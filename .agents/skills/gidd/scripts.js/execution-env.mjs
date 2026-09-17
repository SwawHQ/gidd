import { fileURLToPath } from 'node:url';
import { toolEnvironment } from './tools.mjs';
import { runCommand, checkGitHubIdentity } from './github.mjs';

const tokenNames = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
export function withoutEnvironment(env, names) {
  const omitted = new Set(names.map(name => name.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([key]) => !omitted.has(key.toUpperCase())));
}

export function githubEnvironment(target, env = process.env) {
  return { ...withoutEnvironment(env, [...tokenNames, 'GH_HOST', 'GH_REPO', 'GH_DEBUG', 'DEBUG']),
    GH_HOST: target.hostname, ...(target.repository ? { GH_REPO: target.repository.replace(/^https:\/\//, '') } : {}) };
}

// Retain ordered duplicate keys: resetting a helper and adding its replacement
// are two different entries. Explicit Git -c options keep their native priority.
export function gitConfigurationEnvironment(env, pairs) {
  const source = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  const count = source.GIT_CONFIG_COUNT || '0';
  if (!/^\d+$/.test(count) || Number(count) > 1024) throw new Error('git_config_environment_invalid');
  const entries = [];
  for (let i = 0; i < Number(count); i++) {
    const key = source['GIT_CONFIG_KEY_' + i], value = source['GIT_CONFIG_VALUE_' + i];
    if (!key || value === undefined) throw new Error('git_config_environment_invalid');
    entries.push([key, value]);
  }
  entries.push(...pairs);
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/i.test(key)));
  result.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], i) => {
    result['GIT_CONFIG_KEY_' + i] = key;
    result['GIT_CONFIG_VALUE_' + i] = value;
  });
  return result;
}

const shellQuote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";

export function gitEnvironment(settings, bindings, target, env = process.env) {
  const pairs = [];
  if (settings.user?.mode === 'managed') pairs.push(['user.name', settings.user.name], ['user.email', settings.user.email]);
  if (settings.credential?.mode === 'gh') {
    // Lazy authentication: local Git operations do not need a token or network.
    // Git invokes this broker only when it needs HTTPS credentials for this host.
    const helper = '!' + [process.execPath, fileURLToPath(new URL('./credential-helper.mjs', import.meta.url)),
      bindings.gh.path, target.hostname, target.account].map(shellQuote).join(' ');
    const key = `credential.https://${target.hostname}.helper`;
    pairs.push([key, ''], [key, helper]);
  }
  return gitConfigurationEnvironment(toolEnvironment(bindings.git?.path, env), pairs);
}

// Never return the token in a diagnostic report; only the caller's private env.
export async function selectGitHubAccount({ gh, hostname, account, repository },
  { env = process.env, cwd, signal, execute = runCommand } = {}) {
  hostname = hostname.toLowerCase();
  const clean = githubEnvironment({ hostname, repository }, env);
  const token = await execute(gh, ['auth', 'token', '--hostname', hostname, '--user', account], { env: clean, cwd, signal });
  if (!token.ok) throw new Error(token.reason === 'command_failed' ? 'account_token_unavailable' : token.reason);
  if (!token.text || /\s/.test(token.text) || token.text.length > 16384) throw new Error('invalid_account_token');
  const key = hostname === 'github.com' || hostname.endsWith('.ghe.com') ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN';
  const selected = { ...clean, [key]: token.text };
  const identity = await checkGitHubIdentity({ gh, hostname, account },
    (exe, args) => execute(exe, args, { env: selected, cwd, signal }));
  if (identity.status !== 'ready') {
    const error = new Error(identity.reason);
    error.identity = identity;
    throw error;
  }
  return { env: selected, identity };
}
