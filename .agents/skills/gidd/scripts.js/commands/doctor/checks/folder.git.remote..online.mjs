import { checkGitHubRepository } from '../../../shared/github.mjs';
import { remoteAddress } from '../../../shared/config.mjs';
import { check, blockCheck } from '../shared/result.mjs';

export const id = 'folder.git.remote..online';
export const online = true;
export async function run(context) {
  const remote = await context.run('folder.git.remote');
  if (remote.status !== 'ready') return blockCheck(check(id, 'ready'), remote.id);
  const accountId = 'tool.gh.account..online';
  const account = await context.run(accountId), { env } = await context.account();
  const { env: gitEnv } = await context.environment();
  const probes = {};
  if (account.status !== 'ready') probes.gh_remote_read = { status: 'not_checked', reason: 'dependency_unavailable', blocked_by: accountId };
  else probes.gh_remote_read = await checkGitHubRepository({ gh: context.bindings().bindings.gh.path, ...await context.apiTarget() },
    (exe, args) => context.execute(exe, args, { cwd: context.target, env, timeoutMs: 15000 }));
  for (const direction of ['fetch', 'push']) {
    const endpoint = remote.details[direction], key = `git_${direction}_read`;
    if (remoteAddress(endpoint.url)?.protocol !== 'https') probes[key] = { status: 'not_checked', reason: 'ssh_probe_unsupported' };
    else {
      const result = await context.invoke(['ls-remote', '--', endpoint.url, 'HEAD'], 15000, gitEnv);
      probes[key] = { status: result.ok ? 'ready' : 'failed', ...(!result.ok ? { reason: result.reason } : {}) };
    }
  }
  const results = Object.values(probes), failed = results.some(item => ['failed', 'mismatch'].includes(item.status));
  const complete = results.every(item => item.status === 'ready');
  return check(id, failed ? 'failed' : complete ? 'ready' : 'not_checked',
    failed ? 'online_probe_failed' : 'online_incomplete', probes);
}
