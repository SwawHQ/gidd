import { selectGitHubAccount } from '../../../shared/execution-env.mjs';
import { check, blockCheck, safeReason } from './result.mjs';
import { remoteId } from './remote.mjs';

export async function inspectAccount(context) {
  const id = remoteId('account') + '..online';
  const target = context.apiTarget(), account = context.remote('account');
  const { env } = await context.environment();
  // API identity depends on configured host/account, not local Git health.
  if (!target || account.status !== 'ready') return {
    result: blockCheck(check(id, 'ready'), account.status !== 'ready' ? account.id : remoteId('url')), env,
  };
  if ((await context.run('tool.gh')).status !== 'ready') return { result: blockCheck(check(id, 'ready'), 'tool.gh'), env };
  try {
    const selected = await selectGitHubAccount({ gh: context.bindings().bindings.gh.path, ...target },
      { env, cwd: context.targetExists ? context.target : undefined, execute: context.execute });
    return { result: check(id, 'ready', undefined, selected.identity.details), env: selected.env };
  } catch (error) {
    return { result: check(id, error.identity?.status || 'failed', safeReason(error, 'identity_check_failed'), error.identity?.details), env };
  }
}
