import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { plainPath } from './storage.mjs';
import { remoteAddress } from './doctor.mjs';
import { validateGitHubField } from './config.mjs';
import { runCommand } from './github.mjs';

const samePath = (a, b) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

function requireRoot(repository) {
  if (!repository || !isAbsolute(repository)) throw new Error('repository_must_be_absolute');
  plainPath(repository);
  if (!existsSync(repository) || !lstatSync(repository).isDirectory()) throw new Error('repository_directory_missing');
  if (!existsSync(join(repository, '.git'))) throw new Error('not_git_repository_root');
}

// Only Git can distinguish a valid worktree marker from a broken or redirected one.
// No network/authentication, HEAD, author, or GIDD configuration completeness is required.
export async function inspectRepositoryEntry(repository, git, github = {}, execute = runCommand) {
  requireRoot(repository);
  const invoke = args => execute(git, ['-C', repository, ...args], { timeoutMs: 5000 });
  const inside = await invoke(['rev-parse', '--is-inside-work-tree']);
  const top = await invoke(['rev-parse', '--show-toplevel']);
  if (!inside.ok || inside.text !== 'true' || !top.ok) throw new Error('not_readable_worktree');
  if (!samePath(repository, top.text)) throw new Error('repository_root_mismatch');
  const hostname = github.hostname ?? 'github.com';
  validateGitHubField('hostname', hostname);
  if (github.remote !== undefined) validateGitHubField('remote', github.remote);
  const listed = await invoke(['remote']);
  if (!listed.ok) throw new Error('repository_remotes_unreadable');
  let names = listed.text.split(/\r?\n/).filter(Boolean);
  if (github.remote !== undefined) {
    if (!names.includes(github.remote)) throw new Error('configured_remote_missing');
    names = [github.remote];
  }
  const remotes = [];
  for (const name of names) {
    validateGitHubField('remote', name);
    const result = await invoke(['remote', 'get-url', '--all', name]);
    if (!result.ok) continue;
    const urls = result.text.split(/\r?\n/).filter(Boolean);
    const address = urls.length === 1 && remoteAddress(urls[0]);
    if (address && address.hostname === hostname.toLowerCase()) {
      remotes.push({ name, hostname: address.hostname, repository: address.repository, protocol: address.protocol });
    }
  }
  if (!remotes.length) throw new Error('github_remote_required');
  return { status: 'ready', path: repository, remotes };
}
