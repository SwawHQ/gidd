import { existsSync } from 'node:fs';
import { boundExecutor, boundTools } from '../shared/bindings.mjs';
import { toolsRoot, parseConfiguration, readConfigurationText } from '../shared/storage.mjs';
import { noninteractiveEnvironment } from '../shared/noninteractive.mjs';
import { inspectRepositoryEntry } from '../shared/repository-check.mjs';
import { acquireStorageLock, atomicWrite, initializeStorage, storageLocation } from '../shared/managed-storage.mjs';
import { inspectData } from '../shared/data-inspection.mjs';
import { withSignals } from '../shared/signals.mjs';

// Preparation invokes this same handler after tools and the entry are ready.
// Only mechanical local defaults belong here; identity and spec choices remain unset.
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
    if (existsSync(storage.config)) parseConfiguration(readConfigurationText(storage.config));
    const details = await inspectData(storage, git, { initializing: true });
    if (details.issues.length) throw Object.assign(new Error('data_needs_attention'), { dataReport: details });
    initializeStorage(storage);
    if (!existsSync(storage.config)) atomicWrite(storage.config, 'schema_version = 1\n\n[repo]\nremote.name = "origin"\n');
    return { schema: 'gidd.init/v1', status: 'ready', target_repository: storage.main,
      config_path: storage.config, data_path: storage.path };
  } finally { lease.release(); }
}

export const runInit = repository => withSignals(signal => initializeRepository(repository, { signal }));
