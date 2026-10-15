import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { plainPath } from './storage.mjs';

// State describes management and checkout health, independent of delivery mode.
// Ordinary edits are expected while a workspace remains assigned to its task.
export function workspaceState({ managed = true, released = false, reason } = {}) {
  if (!managed) return 'unmanaged';
  if (reason && !(reason === 'worktree_dirty' && !released)) return 'needs_check';
  return released ? 'available' : 'assigned';
}

export async function inspectWorkspace(row, { git, common, same, includeIgnored = false }) {
  if (!row || !existsSync(row.path)) return 'worktree_missing';
  try { plainPath(row.path); } catch { return 'worktree_reparse_path'; }
  if (row.bare || row.locked || row.prunable) return 'worktree_unavailable';
  if (!same(await git(row.path, ['rev-parse', '--show-toplevel']), row.path) ||
      !same(await git(row.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']), common)) return 'worktree_repository_mismatch';
  const gitDir = await git(row.path, ['rev-parse', '--absolute-git-dir']);
  plainPath(gitDir);
  const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START', 'index.lock', 'HEAD.lock'];
  if (operations.some(name => existsSync(join(gitDir, name)))) return 'worktree_operation_in_progress';
  // Index flags can hide edits from status. Never infer availability from them.
  const index = await git(row.path, ['ls-files', '-v', '-z']);
  if (index.split('\0').some(entry => /^[a-zS] /.test(entry))) return 'worktree_index_flags';
  if (await git(row.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])) return 'worktree_dirty';
  // Reuse preserves ignored caches. Removal must check them separately.
  if (includeIgnored && await git(row.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])) return 'worktree_ignored_files';
  return null;
}
