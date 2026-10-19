import { resolveRemoteBinding } from '../../../shared/remote-binding.mjs';
import { safeReason } from '../shared/result.mjs';

export const id = 'folder.git.remote';
export async function run(context) {
  if (!(await context.worktree()).readable)
    return { id, status: 'not_checked', reason: 'repository_unavailable', blocked_by: 'folder.git.worktree' };
  try {
    const remote = await resolveRemoteBinding(async (path, args) => {
      const result = await context.invoke(['-C', path, ...args]);
      if (!result.ok) throw new Error('remote_unavailable');
      return result.text;
    }, context.configRoot);
    return { id, status: 'ready', details: remote };
  } catch (error) { return { id, status: 'invalid', reason: safeReason(error, 'remote_unavailable') }; }
}
