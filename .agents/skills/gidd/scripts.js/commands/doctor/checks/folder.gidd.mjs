import { storageLocation } from '../../../shared/managed-storage.mjs';
import { inspectData } from '../../../shared/data-inspection.mjs';
import { safeReason } from '../shared/result.mjs';

export const id = 'folder.gidd';
export async function run(context) {
  if (!(await context.worktree()).readable)
    return { id, status: 'not_checked', reason: 'repository_unavailable', blocked_by: 'folder.git.worktree' };
  try {
    const git = async (path, args) => {
      const result = await context.invoke(['-C', path, ...args]);
      if (!result.ok) throw new Error('data_git_failed');
      return result.text;
    };
    const storage = await storageLocation(context.configRoot, git);
    const details = await inspectData(storage, git);
    if (!details.issues.length) return { id, status: 'ready', details };
    const missing = details.issues.length === 1 && details.issues[0].reason === 'data_missing';
    return { id, status: missing ? 'missing' : 'invalid', reason: missing ? 'data_missing' : 'data_needs_attention', details };
  } catch (error) { return { id, status: 'invalid', reason: safeReason(error, 'data_unavailable') }; }
}
