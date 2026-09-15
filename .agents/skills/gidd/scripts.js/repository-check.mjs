import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { plainPath } from './storage.mjs';
import { remoteAddress, normalizeRepositoryIdentity, validateRemoteField, readRemoteConfiguration, githubTarget } from './config.mjs';
import { runCommand } from './github.mjs';

export const remoteId = key => 'config.repo.remote.' + key;
const result = (key, status, reason, details) => ({ id: remoteId(key), status, ...(reason ? { reason } : {}), ...(details ? { details } : {}) });
export const blockCheck = (item, by) => item.status !== 'ready' ? item :
  { ...item, status: 'not_checked', reason: 'dependency_unavailable', blocked_by: by };

export function remoteFields(remote) {
  return Object.fromEntries(['name', 'url', 'account'].map(key => {
    let item;
    if (!Object.hasOwn(remote, key)) item = result(key, 'missing', 'config_missing_repo_remote_' + key);
    else {
      try {
        validateRemoteField(key, remote[key]);
        item = result(key, 'ready', undefined, { expected: key === 'url' ? normalizeRepositoryIdentity(remote[key]) : remote[key] });
      } catch { item = result(key, 'invalid', 'config_invalid_repo_remote_' + key); }
    }
    return [key, item];
  }));
}

// Field checks include every fact available locally. Invalid fields keep their own
// errors even when another prerequisite prevents observing the selected remote.
export async function inspectRemoteFields(invoke, fields) {
  const checks = structuredClone(fields);
  if (checks.name.status === 'ready') {
    const listed = await invoke(['remote']);
    if (!listed.ok) checks.name = { ...checks.name, status: 'failed', reason: listed.reason };
    else if (!listed.text.split(/\r?\n/).includes(checks.name.details.expected)) {
      checks.name = { ...checks.name, status: 'missing', reason: 'configured_remote_missing' };
    }
  }
  if (checks.name.status !== 'ready') { checks.url = blockCheck(checks.url, checks.name.id); return checks; }
  const selected = checks.name.details.expected;
  const output = await invoke(['remote', 'get-url', '--all', selected]);
  const urls = output.ok ? output.text.split(/\r?\n/).filter(Boolean) : [];
  const address = urls.length === 1 && remoteAddress(urls[0]);
  const reason = !output.ok ? output.reason : urls.length !== 1 ? 'remote_url_ambiguous' : !address ? 'unsupported_remote_url' : undefined;
  if (reason) {
    if (checks.url.status === 'ready') checks.url = { ...checks.url, status: 'invalid', reason };
    return checks;
  }
  checks.url.details = { ...checks.url.details, actual: address.identity, remote: selected, protocol: address.protocol };
  if (checks.url.status === 'ready' && checks.url.details.expected !== address.identity) {
    checks.url.status = 'mismatch'; checks.url.reason = 'repository_address_mismatch';
  }
  return checks;
}

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

export async function requireRemoteTarget(repository, git, execute = runCommand) {
  const remote = readRemoteConfiguration(repository, ['name', 'url', 'account']);
  await inspectRepositoryEntry(repository, git, execute);
  const fields = await inspectRemoteFields(args => execute(git, ['-C', repository, ...args], { timeoutMs: 5000 }), remoteFields(remote));
  const failure = Object.values(fields).find(item => item.status !== 'ready');
  if (failure) throw new Error(failure.reason);
  return githubTarget(remote);
}
