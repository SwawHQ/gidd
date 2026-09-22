import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { check } from './result.mjs';

export async function inspectWorktree(context) {
  const { target, targetError, targetExists, fixedRepository, configRoot } = context;
  const id = 'folder.git.worktree';
  let result;
  if (!target) result = check(id, 'not_checked', 'target_required');
  else if (targetError) result = check(id, 'invalid', targetError);
  else if (!targetExists) result = check(id, 'invalid', 'directory_missing', { path: target });
  else if (fixedRepository && !existsSync(resolve(target, '.git'))) result = check(id, 'invalid', 'not_git_repository', { path: target });
  else if ((await context.run('tool.git')).status !== 'ready') result = check(id, 'not_checked', 'git_unavailable');
  else {
    const inside = await context.invoke(['rev-parse', '--is-inside-work-tree']);
    const top = await context.invoke(['rev-parse', '--show-toplevel']);
    if (!inside.ok || inside.text !== 'true' || !top.ok) {
      const marked = existsSync(resolve(configRoot, '.git'));
      result = check(id, 'invalid', inside.ok && inside.text === 'false' ? 'not_worktree' :
        marked ? 'not_readable_worktree' : 'not_git_repository', { path: target });
    } else result = check(id, 'ready', undefined, { path: top.text });
  }
  // Worktree readability is a fact separate from HEAD readiness. Even an unborn
  // branch or an unreadable HEAD can still provide identity and remote observations.
  const readable = result.status === 'ready';
  if (readable) {
    const head = await context.invoke(['rev-parse', '--verify', 'HEAD']);
    if (head.ok) result.details.commit = head.text;
    else {
      const symbolic = await context.invoke(['symbolic-ref', '-q', 'HEAD']);
      result.status = symbolic.ok ? 'missing' : 'invalid';
      result.reason = symbolic.ok ? 'unborn_branch' : 'head_unreadable';
    }
  }
  return { result, readable };
}
