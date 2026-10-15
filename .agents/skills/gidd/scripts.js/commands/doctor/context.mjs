import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { repositoryRoot } from '../../shared/storage.mjs';
import { remoteTarget } from '../../shared/remote-binding.mjs';
import { noninteractiveEnvironment } from '../../shared/noninteractive.mjs';
import { toolEnvironment } from '../../shared/tools.mjs';
import { inspectConfiguration } from './shared/configuration.mjs';
import { inspectBindings } from './shared/tools.mjs';
import { inspectWorktree } from './shared/worktree.mjs';
import { inspectAccount } from './shared/account.mjs';
import { check, safeReason } from './shared/result.mjs';

export function createContext(target, { offline, fixedRepository, execute, catalog, lang }, entries) {
  if (target !== undefined && (!target || !isAbsolute(target))) throw new Error('repository_must_be_absolute');
  target = target === undefined ? null : resolve(target);
  let configRoot, targetExists = false, targetError;
  try {
    targetExists = !!target && existsSync(target) && lstatSync(target).isDirectory();
    if (targetExists) configRoot = fixedRepository ? target : repositoryRoot(target);
  } catch (error) { targetError = safeReason(error, 'target_unreadable'); }

  // Observations, failures and in-flight probes belong to this invocation only.
  const observations = new Map(), results = new Map();
  const memo = (key, observe) => {
    if (!observations.has(key)) observations.set(key, observe());
    return observations.get(key);
  };
  const skipped = id => {
    const declared = catalog.checks.get(id);
    const reason = !declared ? 'not_declared' : !declared.enabled ? 'disabled' : offline && entries.get(id).online ? 'offline' : null;
    return reason ? check(id, 'not_checked', reason) : null;
  };
  const context = {
    target, configRoot, targetExists, targetError, offline, fixedRepository, execute, catalog, lang,
    configuration: () => memo('configuration', () => {
      const result = skipped('config.toml');
      return result ? { result } : inspectConfiguration(configRoot);
    }),
    bindings: () => memo('bindings', inspectBindings),
    worktree: () => memo('worktree', () => {
      const result = skipped('folder.git.worktree');
      return result ? { result, readable: false } : inspectWorktree(context);
    }),
    account: () => memo('account', async () => {
      const result = skipped('tool.gh.account..online');
      return result ? { result, env: (await context.environment()).env } : inspectAccount(context);
    }),
    apiTarget: () => memo('apiTarget', async () => {
      const remote = await context.run('folder.git.remote');
      return remote.status === 'ready' ? remoteTarget(remote.details) : null;
    }),
    environment: () => memo('environment', async () => {
      const bindings = context.bindings().bindings;
      const gitReady = (await context.run('tool.git')).status === 'ready';
      const env = toolEnvironment(gitReady ? bindings.git.path : undefined);
      return { env: gitReady ? noninteractiveEnvironment(bindings.git.path, env) : env };
    }),
    async invoke(args, timeoutMs = 5000, env) {
      return execute(context.bindings().bindings.git.path, ['-C', context.target, ...args],
        { timeoutMs, env: env || toolEnvironment(context.bindings().bindings.git?.path) });
    },
    run(id) {
      if (!entries.has(id)) throw new Error('doctor_unknown_check');
      if (!results.has(id)) results.set(id, Promise.resolve().then(() => {
        const entry = entries.get(id);
        // Skip network entries before entering their code or resolving prerequisites.
        return skipped(id) || entry.run(context);
      }));
      return results.get(id);
    },
  };
  return context;
}
