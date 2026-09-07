import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, validateOptions } from './github.mjs';
import { configurationHint, readGitHubConfiguration } from './config.mjs';

// Platform-neutral orchestration. Windows is the only verified launcher today.
export async function authorize(input, { execute = runCommand, env = process.env, signal, onEvent = () => {}, timeoutMs = 900000 } = {}) {
  const options = { hostname: 'github.com', account: '', remote: 'origin', ...input };
  validateOptions(options);
  if (!options.account) throw new Error('expected_account_required');
  if (!options.gh) throw new Error('gh_required');
  if (!statSync(options.repository).isDirectory()) throw new Error('repository_unavailable');
  const report = (status, reason, details = {}) => ({ schema: 'gidd.auth/v1', status, reason,
    hostname: options.hostname.toLowerCase(), expected_account: options.account, ...details });
  const commandOptions = { cwd: options.repository, env, signal };
  const cancelled = () => report('failed', 'cancelled');
  if (signal?.aborted) return cancelled();
  const identity = () => execute(options.gh, ['api', '--hostname', options.hostname, '--method', 'GET', 'user', '--jq', '.login'], commandOptions);
  const matches = login => login.toLowerCase() === options.account.toLowerCase();
  const validLogin = text => /^[a-z0-9][a-z0-9-]{0,99}$/i.test(text);
  const before = await identity();
  if (signal?.aborted) return cancelled();
  if (before.ok && validLogin(before.text)) {
    return report(matches(before.text) ? 'ready' : 'mismatch', matches(before.text) ? 'already_authenticated' : 'existing_account_mismatch',
      { login: before.text, credentials_may_have_changed: false });
  }
  if (Object.entries(env).some(([key, value]) => /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key) && value)) {
    return report('failed', 'environment_token_active');
  }
  // Output parsing follows the verified gh 2.98 device flow. Older versions are
  // rejected instead of silently starting a different interactive protocol.
  const version = await execute(options.gh, ['--version'], commandOptions);
  if (signal?.aborted) return cancelled();
  const v = version.ok && /^gh version (\d+)\.(\d+)\.(\d+)/.exec(version.text);
  if (!v || Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 98)) return report('failed', 'requires_gh_2_98_or_newer');
  let code, url, displayed = false, plaintext = false, protocolFailure = false;
  const login = await execute(options.gh, ['auth', 'login', '--hostname', options.hostname,
    '--web', '--skip-ssh-key', '--clipboard=false'], {
    ...commandOptions, timeoutMs,
    onStderrLine(line) {
      const codeLine = /^! First copy your one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})$/.exec(line.trim());
      if (codeLine) code = codeLine[1];
      const urlLine = /^Open this URL to continue in your web browser: (\S+)$/.exec(line.trim());
      if (urlLine) {
        try {
          const parsed = new URL(urlLine[1]);
          if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== options.hostname.toLowerCase() ||
              parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/login/device') throw new Error();
          url = parsed.href;
        } catch { protocolFailure = true; return false; }
      }
      if (line.includes('Authentication credentials saved in plain text')) plaintext = true;
      if (code && url && !displayed) {
        displayed = true;
        onEvent({ schema: 'gidd.auth.event/v1', type: 'authorization_required', url, code });
      }
    },
  });
  const changed = { credentials_may_have_changed: true, credential_storage: plaintext ? 'plaintext' : 'managed_by_gh' };
  if (!login.ok) return report('failed', protocolFailure ? 'unsupported_authorization_url' : login.reason, changed);
  if (!displayed) return report('failed', 'device_challenge_not_observed', changed);
  if (signal?.aborted) return report('failed', 'cancelled', changed);
  const after = await identity();
  if (!after.ok || !validLogin(after.text)) return report('failed', signal?.aborted ? 'cancelled' : 'identity_verification_failed', changed);
  return report(matches(after.text) ? 'ready' : 'mismatch', matches(after.text) ? 'authenticated' : 'authorized_account_mismatch',
    { ...changed, login: after.text });
}

async function main() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    if (process.platform !== 'win32') throw new Error('unsupported_platform');
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!args[i].startsWith('--') || !['repository','gh'].includes(key) || key in options || !args[i + 1]) throw new Error('invalid_arguments');
      options[key] = args[i + 1];
    }
    const result = await authorize({ ...options, ...readGitHubConfiguration(options.repository, ['hostname', 'account']) }, { signal: controller.signal,
      onEvent: event => console.error(JSON.stringify(event)) });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'ready' ? 0 : 1;
  } catch (error) {
    const reason = /^(config_[a-z_]+|expected_account_required|gh_required|repository_unavailable|repository_must_be_absolute|invalid_hostname|invalid_account|gh_must_be_absolute_executable|unsupported_platform|invalid_arguments)$/.test(error.message) ? error.message : 'authorization_start_failed';
    const hint = configurationHint(reason); if (hint) console.error(hint);
    console.log(JSON.stringify({ schema: 'gidd.auth/v1', status: 'error', reason }));
    process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
