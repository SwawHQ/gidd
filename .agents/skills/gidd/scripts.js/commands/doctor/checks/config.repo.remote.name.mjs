import { blockCheck } from '../shared/result.mjs';

export const id = 'config.repo.remote.name';
export async function run(context) {
  const field = context.remote('name');
  if (!(await context.worktree()).readable) return blockCheck(field, 'folder.git.worktree');
  if (field.status !== 'ready') return field;
  const listed = await context.invoke(['remote']);
  if (!listed.ok) return { ...field, status: 'failed', reason: listed.reason };
  if (!listed.text.split(/\r?\n/).includes(field.details.expected)) return { ...field, status: 'missing', reason: 'configured_remote_missing' };
  return field;
}
