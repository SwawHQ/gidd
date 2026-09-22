import { checkGitHubRepository } from '../../../shared/github.mjs';
import { check, blockCheck } from '../shared/result.mjs';

export const id = 'config.repo.remote.url..online';
export const online = true;
export async function run(context) {
  const name = await context.run('config.repo.remote.name'), url = await context.run('config.repo.remote.url');
  const blocker = [name, url].find(item => item.status !== 'ready');
  if (blocker) return blockCheck(check(id, 'ready'), blocker.id);
  const accountId = 'config.repo.remote.account..online';
  const account = await context.run(accountId), { env } = await context.account();
  const probes = {};
  if (account.status !== 'ready') probes.gh_remote_read = { status: 'not_checked', reason: 'dependency_unavailable', blocked_by: accountId };
  else probes.gh_remote_read = await checkGitHubRepository({ gh: context.bindings().bindings.gh.path, ...context.apiTarget() },
    (exe, args) => context.execute(exe, args, { cwd: context.targetExists ? context.target : undefined, env, timeoutMs: 15000 }));
  if (url.details.protocol !== 'https') probes.git_remote_read = { status: 'not_checked', reason: 'ssh_probe_unsupported' };
  else if (context.configuration().git?.credential?.mode === 'gh' && account.status !== 'ready') {
    probes.git_remote_read = { status: 'not_checked', reason: 'dependency_unavailable', blocked_by: accountId };
  } else {
    const result = await context.invoke(['-c', 'credential.interactive=false', '-c', 'core.askPass=', 'ls-remote', '--', name.details.expected, 'HEAD'], 15000, env);
    probes.git_remote_read = { status: result.ok ? 'ready' : 'failed', ...(!result.ok ? { reason: result.reason } : {}) };
  }
  const results = Object.values(probes);
  const failed = results.some(item => ['failed', 'mismatch'].includes(item.status));
  const complete = results.every(item => item.status === 'ready');
  return check(id, failed ? 'failed' : complete ? 'ready' : 'not_checked', failed ? 'online_probe_failed' : 'online_incomplete',
    { expected: url.details.expected, remote: name.details.expected, ...probes });
}
