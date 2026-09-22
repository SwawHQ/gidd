import { check, blockCheck } from '../shared/result.mjs';
import { identityBlocker } from '../shared/git-settings.mjs';

export const id = 'folder.git.identity';
export async function run(context) {
  if (!(await context.worktree()).readable) return check(id, 'not_checked', 'repository_unavailable');
  const blocker = await identityBlocker(context);
  if (blocker) return blockCheck(check(id, 'ready'), blocker.id);
  const { error } = await context.environment();
  if (error) return check(id, 'failed', error);
  const identities = {};
  for (const [name, variable] of [['author', 'GIT_AUTHOR_IDENT'], ['committer', 'GIT_COMMITTER_IDENT']]) {
    const result = await context.invoke(['var', variable]);
    const match = result.ok && /^(.+) <([^<>\r\n]+)> \d+ [+-]\d{4}$/.exec(result.text);
    if (!match) return check(id, 'failed', result.ok ? 'invalid_identity_response' : result.reason);
    identities[name] = { name: match[1], email: match[2] };
  }
  return check(id, 'ready', undefined, identities);
}
