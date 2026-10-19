import { selectRepositoryAccount } from '../../../shared/repository-auth.mjs';
import { check, blockCheck, safeReason } from './result.mjs';

export async function inspectAccount(context) {
  const id = 'tool.gh.account..online';
  const target = await context.apiTarget();
  const { env } = await context.environment();
  if (!target) return {
    result: blockCheck(check(id, 'ready'), 'folder.git.remote'), env,
  };
  if ((await context.run('tool.gh')).status !== 'ready') return { result: blockCheck(check(id, 'ready'), 'tool.gh'), env };
  const data = await context.run('folder.gidd');
  if (!data.details?.path) return { result: blockCheck(check(id, 'ready'), 'folder.gidd'), env };
  try {
    const selected = await selectRepositoryAccount({ gh: context.bindings().bindings.gh.path, ...target },
      { storage: data.details, env, cwd: context.targetExists ? context.target : undefined, execute: context.execute });
    return { result: check(id, 'ready', undefined, selected.identity.details), env: selected.env };
  } catch (error) {
    return { result: check(id, error.identity?.status || 'failed', safeReason(error, 'identity_check_failed'), error.identity?.details), env };
  }
}
