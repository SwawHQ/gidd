import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { boundExecutor, boundTools } from './bindings.mjs';
import { executionScope } from './execution-scope.mjs';
import { inspectData } from './data-inspection.mjs';
import { noninteractiveEnvironment } from './noninteractive.mjs';
import { plainPath, toolsRoot } from './storage.mjs';
import { acquireStorageLock, initializeStorage, locateStorage } from './managed-storage.mjs';

const canonical = path => existsSync(path) ? realpathSync.native(path) :
  dirname(resolve(path)) === resolve(path) ? resolve(path) : join(canonical(dirname(resolve(path))), basename(path));
export const sameRepositoryPath = (a, b) => canonical(a).toLowerCase() === canonical(b).toLowerCase();

export async function repositoryCommandContext(repository, { execute, signal, cwd = process.cwd(), required = true } = {}) {
  const bindings = boundTools(toolsRoot(), ['git']), invoke = boundExecutor(bindings, execute);
  const env = { ...noninteractiveEnvironment(bindings.git.path, process.env), GIT_NO_LAZY_FETCH: '1' };
  await executionScope(repository, { bindings, env, signal, cwd });
  const git = async (path, args) => {
    const result = await invoke(bindings.git.path, ['-C', path, ...args], { env, signal, timeoutMs: 60000 });
    if (!result.ok) throw new Error(result.reason === 'command_failed' ? 'delivery_git_failed' : result.reason);
    return result.text;
  };
  let storage = await locateStorage(repository, git, { required });
  const lease = acquireStorageLock(storage);
  try {
    storage = await locateStorage(repository, git, { required });
    plainPath(storage.path);
    const ensureData = async () => { if (!storage.initialized) {
      const details = await inspectData(storage, git, { initializing: true });
      if (details.issues.length) throw Object.assign(new Error('data_needs_attention'), { dataReport: details });
      initializeStorage(storage);
    } };
    return { bindings, invoke, env, git, storage, lease, ensureData };
  } catch (error) { lease.release(); throw error; }
}
