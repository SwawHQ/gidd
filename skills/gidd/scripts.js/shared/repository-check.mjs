import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { plainPath } from './storage.mjs';
import { runCommand } from './process.mjs';

export async function inspectRepositoryEntry(repository, git, execute = runCommand) {
  if (!repository || !isAbsolute(repository)) throw new Error('repository_must_be_absolute');
  plainPath(repository);
  if (!existsSync(join(repository, '.git'))) throw new Error('not_git_repository_root');
  const invoke = args => execute(git, ['-C', repository, ...args], { timeoutMs: 5000 });
  const inside = await invoke(['rev-parse', '--is-inside-work-tree']);
  const top = await invoke(['rev-parse', '--show-toplevel']);
  if (!inside.ok || inside.text !== 'true' || !top.ok) throw new Error('not_readable_worktree');
  if (realpathSync.native(repository).toLowerCase() !== realpathSync.native(top.text).toLowerCase()) throw new Error('repository_root_mismatch');
  return { status: 'ready', path: repository };
}
