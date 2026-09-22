import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { repositoryRoot } from '../../shared/storage.mjs';
import { githubTarget } from '../../shared/config.mjs';
import { gitEnvironment } from '../../shared/execution-env.mjs';
import { toolEnvironment } from '../../shared/tools.mjs';
import { inspectConfiguration } from './shared/configuration.mjs';
import { inspectBindings } from './shared/tools.mjs';
import { remoteField } from './shared/remote.mjs';
import { identityBlocker } from './shared/git-settings.mjs';
import { inspectWorktree } from './shared/worktree.mjs';
import { inspectAccount } from './shared/account.mjs';
import { check, safeReason } from './shared/result.mjs';

export function createContext(target, { offline, fixedRepository, execute }, entries) {
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
  const context = {
    target, configRoot, targetExists, targetError, offline, fixedRepository, execute,
    configuration: () => memo('configuration', () => inspectConfiguration(configRoot)),
    bindings: () => memo('bindings', inspectBindings),
    remote: key => memo('remote.' + key, () => remoteField(context.configuration(), key)),
    worktree: () => memo('worktree', () => inspectWorktree(context)),
    account: () => memo('account', () => inspectAccount(context)),
    apiTarget: () => memo('apiTarget', () => {
      const url = context.remote('url'), account = context.remote('account'), name = context.remote('name');
      return url.details?.expected && account.status === 'ready' ? githubTarget({
        url: url.details.expected, name: name.details?.expected, account: account.details.expected,
      }) : null;
    }),
    environment: () => memo('environment', async () => {
      const bindings = context.bindings().bindings;
      const gitReady = (await context.run('tool.git')).status === 'ready';
      const ghReady = (await context.run('tool.gh')).status === 'ready';
      const blocker = await identityBlocker(context);
      const credential = await context.run('config.git.credential.mode');
      const configuration = context.configuration(), target = context.apiTarget();
      let env = toolEnvironment(gitReady ? bindings.git.path : undefined), error;
      try {
        env = gitEnvironment({ user: !blocker ? configuration.git?.user : {},
          credential: credential.status === 'ready' && ghReady && target ? configuration.git.credential : {} }, bindings, target, env);
      } catch (caught) { error = safeReason(caught, 'git_environment_invalid'); }
      return { env, error };
    }),
    async invoke(args, timeoutMs = 5000, env) {
      return execute(context.bindings().bindings.git.path, ['-C', target, ...args],
        { timeoutMs, env: env || (await context.environment()).env });
    },
    run(id) {
      if (!entries.has(id)) throw new Error('doctor_unknown_check');
      if (!results.has(id)) results.set(id, Promise.resolve().then(() => {
        const entry = entries.get(id);
        // Skip network entries before entering their code or resolving prerequisites.
        return offline && entry.online ? check(id, 'not_checked', 'offline') : entry.run(context);
      }));
      return results.get(id);
    },
  };
  return context;
}
