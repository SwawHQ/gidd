import { isAbsolute } from 'node:path';
import { runCommand } from './process.mjs';

export function validateOptions(options) {
  if (!options.repository || !isAbsolute(options.repository)) throw new Error('repository_must_be_absolute');
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(options.hostname)) throw new Error('invalid_hostname');
  if (options.account && !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(options.account)) throw new Error('invalid_account');
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(options.remote)) throw new Error('invalid_remote_name');
  for (const name of ['git', 'gh']) {
    if (options[name] && (!isAbsolute(options[name]) || (process.platform === 'win32' && !options[name].toLowerCase().endsWith('.exe')))) {
      throw new Error(`${name}_must_be_absolute_executable`);
    }
  }
}

export async function checkGitHubIdentity({ gh, hostname, account }, execute = runCommand) {
  const result = await execute(gh, ['api', '--hostname', hostname, '--method', 'GET', 'user', '--jq', '.login']);
  if (!result.ok) return { status: 'failed', reason: result.reason };
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(result.text)) return { status: 'failed', reason: 'invalid_api_response' };
  const matches = result.text.toLowerCase() === account.toLowerCase();
  return { status: matches ? 'ready' : 'mismatch', reason: matches ? 'identity_verified' : 'unexpected_account',
    details: { hostname: hostname.toLowerCase(), actual: result.text, expected: account } };
}

export async function checkGitHubRepository({ gh, repository }, execute = runCommand) {
  const result = await execute(gh, ['repo', 'view', repository, '--json', 'url']);
  if (!result.ok) return { status: 'failed', reason: result.reason };
  let response;
  try { response = JSON.parse(result.text); } catch { return { status: 'failed', reason: 'invalid_api_response' }; }
  if (typeof response?.url !== 'string') return { status: 'failed', reason: 'invalid_api_response' };
  if (response.url.toLowerCase().replace(/\/$/, '') !== repository.toLowerCase()) {
    return { status: 'mismatch', reason: 'repository_response_mismatch' };
  }
  return { status: 'ready' };
}
