import { runCommand } from './process.mjs';

export async function checkGitHubIdentity({ gh, hostname, account }, execute = runCommand) {
  const result = await execute(gh, ['api', '--hostname', hostname, '--method', 'GET', 'user', '--jq', '.login']);
  if (!result.ok) return { status: 'failed', reason: result.reason };
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(result.text)) return { status: 'failed', reason: 'invalid_api_response' };
  const matches = !account || result.text.toLowerCase() === account.toLowerCase();
  return { status: matches ? 'ready' : 'mismatch', reason: matches ? 'identity_verified' : 'unexpected_account',
    details: { hostname: hostname.toLowerCase(), actual: result.text, ...(account ? { expected: account } : {}) } };
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
