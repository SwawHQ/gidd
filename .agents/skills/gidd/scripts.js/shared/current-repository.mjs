import { resolve } from 'node:path';
import { boundExecutor, boundTools } from './bindings.mjs';
import { toolsRoot } from './storage.mjs';
import { noninteractiveEnvironment } from './noninteractive.mjs';
import { parseList } from './git-worktrees.mjs';

// Git resolves subdirectories and linked worktrees. Records belong to the main
// checkout, independently of where the skill itself is installed.
export async function currentRepository(cwd = process.cwd()) {
  const bindings = boundTools(toolsRoot(), ['git']), execute = boundExecutor(bindings);
  const result = await execute(bindings.git.path, ['worktree', 'list', '--porcelain', '-z'], {
    cwd, env: noninteractiveEnvironment(bindings.git.path, process.env), timeoutMs: 30000,
  });
  if (!result.ok) throw new Error('not_readable_worktree');
  const main = parseList(result.text)[0];
  if (!main?.path || main.bare) throw new Error('worktree_main_unavailable');
  return resolve(main.path);
}
