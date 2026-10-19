import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { githubEnvironment, withoutEnvironment, selectGitHubAccount } from './execution-env.mjs';
import { plainPath } from './storage.mjs';
import { runCommand } from './process.mjs';
import { runAttachedCommand } from './attached-process.mjs';

// All linked worktrees use the main repository's storage location. Never copy
// the caller's gh configuration or write tokens into GIDD task records.
export function repositoryGitHubEnvironment(storage, target, env = process.env) {
  const directory = join(storage.path, 'gh');
  for (const path of [directory, join(directory, 'config.yml'), join(directory, 'hosts.yml')]) plainPath(path);
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new Error('gh_config_invalid');
  return { ...withoutEnvironment(githubEnvironment(target, env), ['GH_CONFIG_DIR']), GH_CONFIG_DIR: directory };
}

export async function selectRepositoryAccount(target, { storage, env = process.env, execute = runCommand, ...options }) {
  const selectedEnv = repositoryGitHubEnvironment(storage, target, env);
  let account = target.account;
  if (!account) {
    // Ask gh to read its own configuration. A missing host must not fall back
    // to the system keyring's shared active-token slot.
    const result = await execute(target.gh, ['config', 'get', 'user', '--host', target.hostname], { ...options, env: selectedEnv });
    if (!result.ok) throw new Error(result.reason === 'command_failed' ? 'gh_auth_required' : result.reason);
    account = result.text;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(account)) throw new Error('gh_auth_required');
  }
  return selectGitHubAccount({ ...target, account }, { ...options, env: selectedEnv, execute });
}

export async function authorizeRepositoryGitHub(target, { storage, env = process.env, execute = runCommand,
  login = runAttachedCommand, cwd, signal } = {}) {
  const selectedEnv = repositoryGitHubEnvironment(storage, target, env);
  mkdirSync(selectedEnv.GH_CONFIG_DIR, { recursive: true });
  // The browser/device login needs no terminal prompts. Disabling them also
  // prevents gh from offering to change Git credential helpers or SSH keys.
  // Login progress goes to stderr; stdout remains the task command JSON report.
  const status = await login(target.gh, ['auth', 'login', '--hostname', target.hostname, '--web', '--skip-ssh-key'],
    { cwd, signal, env: { ...withoutEnvironment(selectedEnv, ['GH_PROMPT_DISABLED']), GH_PROMPT_DISABLED: '1' }, stdio: ['ignore', 2, 2] });
  if (signal?.aborted || status === 130) throw new Error('cancelled');
  if (status !== 0) throw new Error('gh_login_failed');
  const selected = await selectRepositoryAccount(target, { storage, env: selectedEnv, execute, cwd, signal });
  return { hostname: target.hostname, account: selected.identity.details.actual, config_directory: selectedEnv.GH_CONFIG_DIR };
}
