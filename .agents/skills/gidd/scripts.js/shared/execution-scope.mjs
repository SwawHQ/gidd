import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { boundExecutor } from './bindings.mjs';
import { configurationPath, plainPath, repositoryRoot } from './storage.mjs';
import { parseList, readRecords } from '../commands/worktree/index.mjs';
import { locateStorage, registryLocation } from './managed-storage.mjs';

const canonical = path => existsSync(path) ? realpathSync.native(path) :
  dirname(resolve(path)) === resolve(path) ? resolve(path) : join(canonical(dirname(resolve(path))), basename(path));
const key = path => canonical(path).toLowerCase();
const same = (a, b) => key(a) === key(b);

export async function executionScope(repository, { bindings, env, signal, cwd = process.cwd() }) {
  const details = { cwd, entry_repository: repository, config: configurationPath(repository),
    execution_directory: cwd, detected_repository: null };
  const fail = reason => { throw Object.assign(new Error(reason), { executionScope: { ...details } }); };
  const invoke = boundExecutor(bindings);
  async function probe(directory) {
    const result = await invoke(bindings.git.path, ['rev-parse', '--show-toplevel',
      '--absolute-git-dir', '--path-format=absolute', '--git-common-dir'], { cwd: directory, env, signal });
    if (!result.ok) fail(signal?.aborted ? 'cancelled' : 'execution_not_worktree');
    const [root, gitDir, common, ...extra] = result.text.split(/\r?\n/);
    if (!root || !gitDir || !common || extra.length) fail('execution_not_worktree');
    try { for (const path of [directory, root, gitDir, common]) plainPath(path); }
    catch { fail('execution_reparse_path'); }
    return { root, gitDir, common };
  }
  const entry = await probe(repository);
  if (!same(entry.root, repository)) fail('repository_root_mismatch');
  let records, rows;
  const storageGit = async (path, args) => {
    const result = await invoke(bindings.git.path, ['-C', path, ...args], { env, signal });
    if (!result.ok) fail('execution_registry_unavailable');
    return result.text;
  };
  const storage = await locateStorage(repository, storageGit);
  async function allowed(directory) {
    details.execution_directory = directory;
    details.detected_repository = null;
    const actual = await probe(directory);
    details.detected_repository = actual.root;
    if (!same(repositoryRoot(directory), actual.root)) fail('execution_location_mismatch');
    if (!same(actual.common, entry.common)) fail('execution_repository_mismatch');
    if (same(actual.root, entry.root)) return actual;
    if (!rows) {
      const result = await invoke(bindings.git.path, ['-C', repository, 'worktree', 'list', '--porcelain', '-z'], { env, signal });
      if (!result.ok) fail('execution_registry_unavailable');
      rows = parseList(result.text);
      const main = rows[0];
      if (!main?.path || main.bare) fail('execution_registry_unavailable');
      try { records = readRecords(registryLocation(storage), storage.path); }
      catch { fail('execution_registry_invalid'); }
    }
    if (!rows.some(row => !row.bare && !row.prunable && same(row.path, actual.root)) ||
        !records.some(record => same(record.path, actual.root))) fail('execution_worktree_unregistered');
    return actual;
  }
  // Only validate where the entry is invoked. Explicit native target arguments
  // remain the caller's responsibility and do not change the entry settings.
  await allowed(cwd);
  return cwd;
}
