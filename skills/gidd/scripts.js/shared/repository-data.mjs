import { boundExecutor, boundTools } from './bindings.mjs';
import { toolsRoot } from './storage.mjs';
import { noninteractiveEnvironment } from './noninteractive.mjs';
import { inspectRepositoryEntry } from './repository-check.mjs';
import { acquireStorageLock, initializeStorage, storageLocation } from './managed-storage.mjs';
import { inspectData } from './data-inspection.mjs';

// Create or verify repository data without choosing identity or delivery settings.
export async function initializeRepository(repository, { signal } = {}) {
  const bindings = boundTools(toolsRoot(), ['git']), execute = boundExecutor(bindings);
  const env = noninteractiveEnvironment(bindings.git.path, process.env);
  await inspectRepositoryEntry(repository, bindings.git.path, (exe, args, options) => execute(exe, args, { ...options, env, signal }));
  const git = async (path, args) => {
    const result = await execute(bindings.git.path, ['-C', path, ...args], { env, signal, timeoutMs: 120000 });
    if (!result.ok) throw new Error(signal?.aborted ? 'cancelled' : 'data_git_failed');
    return result.text;
  };
  let storage = await storageLocation(repository, git);
  const lease = acquireStorageLock(storage);
  try {
    storage = await storageLocation(repository, git);
    const details = await inspectData(storage, git, { initializing: true });
    if (details.issues.length) throw Object.assign(new Error('data_needs_attention'), { dataReport: details });
    initializeStorage(storage);
    return storage;
  } finally { lease.release(); }
}
