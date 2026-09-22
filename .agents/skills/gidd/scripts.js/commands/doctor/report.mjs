import { resolve } from 'node:path';
import { configurationHint } from '../../shared/config.mjs';
import { skillPath } from '../../shared/paths.mjs';
import { remoteId } from './shared/remote.mjs';

// A skipped dependent check is explained by its blocker, not another repair request.
const blockers = {
  target_unavailable: 'folder.git.worktree', git_unavailable: 'tool.git', gh_unavailable: 'tool.gh',
  repository_unavailable: 'folder.git.worktree', configuration_unavailable: 'config.toml',
};

function describeCheck(item, root, bindings) {
  const { id, status, reason } = item;
  const configKey = id.startsWith('config.') ? id.slice('config.'.length) : undefined;
  item.severity = status === 'ready' || reason === 'offline' ? 'info' :
    ['unborn_branch', 'ssh_probe_unsupported', 'online_incomplete'].includes(reason) ? 'warning' : 'error';
  if (status === 'ready') return;
  if (reason === 'offline') { item.hint = 'Not checked in offline mode. Run doctor without --offline to check GitHub identity and HTTPS remote access.'; return; }
  if (status === 'not_checked' && (item.blocked_by || blockers[reason])) {
    item.severity = 'info'; item.blocked_by ||= blockers[reason];
    item.hint = `Resolve the ${item.blocked_by} check, then rerun doctor.`; return;
  }
  const link = root && resolve(root, '.agents/skills/gidd/gidd.link.cmd');
  // Commands carry argument arrays so paths and user values are not shell-interpolated.
  const command = (executable, args, inputs = []) => ({ executable, args,
    ...(inputs.length ? { required_inputs: inputs } : {}) });
  const remoteCommands = root && bindings.git ? [command(bindings.git.path, ['-C', root, 'remote', '-v'])] : [];
  if (id === 'tool.git' || id === 'tool.gh') {
    item.hint = 'Run gidd.pre.ensure.cmd with this repository to repair shared tools and rebuild its entry.';
    if (root) item.commands = [command(skillPath('gidd.pre.ensure.cmd'), ['--repo', root])];
    return;
  }
  if (id === 'config.toml') {
    if (reason === 'config_missing') {
      item.hint = 'Create config.toml with gidd.link set repo.remote.account <login>, then set repo.remote.url and review repo.remote.name.';
      if (link) item.commands = [command(link, ['set', 'repo.remote.account', '<value>'], ['repo.remote.account'])];
    } else {
      item.hint = configurationHint(reason) || 'Repair config.toml at the reported path, preserving unrelated settings and comments, then rerun doctor. Invalid values are omitted from this report.';
    }
    return;
  }
  if (id === 'folder.git.worktree') {
    item.hint = reason === 'unborn_branch' ? 'This repository has no commits yet. Create the first commit when there is work to save; local configuration can continue.' :
      reason === 'head_unreadable' ? 'Repair the repository HEAD, then rerun doctor.' :
      reason === 'target_required' ? 'Run the actual skill gidd.pre.ensure.cmd --repo <Git-working-tree-root>, then invoke the generated gidd.link.cmd by its full path.' :
      'Check the reported directory and its Git working-tree metadata. Restore the intended repository or explicitly initialize Git there, then rerun doctor; do not substitute a parent repository.';
  } else if (id === 'folder.git.identity') {
    item.hint = 'Check effective Git author and committer. Repair inherited Git identity, or select git.user.mode=managed and set both git.user.name and git.user.email.';
    if (link) item.commands = [command(link, ['set', 'git.user.mode', 'managed']),
      ...['name', 'email'].map(key => command(link, ['set', `git.user.${key}`, '<value>'], [`git.user.${key}`]))];
  } else if (id === remoteId('account') + '..online') {
    item.hint = reason === 'unexpected_account' ?
      'The selected token does not belong to repo.remote.account. Review the configured account and saved gh credentials.' :
      reason === 'account_token_unavailable' ? 'Run gidd.link.cmd .gh.auth to authorize the configured account.' :
      'Check connectivity and saved gh credentials for the configured host/account. A failed API request does not prove login is required.';
  } else if (id === remoteId('url') + '..online') {
    item.hint = 'Inspect details.gh_remote_read and details.git_remote_read. Skipped checks remain unverified; Git reading and API reading do not prove write permission.';
  } else if (id.startsWith('config.repo.remote.')) {
    item.hint = id === remoteId('account') ?
      'Set repo.remote.account to the expected GitHub login. This does not log in or change Git author information.' :
      'Review the local remote and the expected repository address, then repair the reported config field or the local remote. Do not accept a changed target automatically.';
    item.commands = [...remoteCommands];
    if (link) item.commands.push({ ...command(link, ['set', configKey, '<value>'], [configKey]),
      ...(id === remoteId('url') ? { requires_configuration_review: true } : {}) });
  } else if (id.startsWith('config.git.')) {
    item.hint = reason === 'config_git_user_inherit_conflict' ?
      `Run gidd.link.cmd clear ${configKey} in inherit mode, or select managed and provide both name and email.` : configurationHint(reason);
    if (link && reason === 'config_git_user_inherit_conflict') item.commands = [command(link, ['clear', configKey])];
  }
  else if (id === 'tool.platform') item.hint = 'Use the currently supported Windows x64 platform.';
}


export function report(context, results) {
  const { offline, target, configRoot } = context;
  // Presentation never mutates the observations used by other checks.
  const checks = structuredClone(results);
  for (const item of checks) describeCheck(item, configRoot || target, context.bindings().bindings);
  const hasErrors = checks.some(item => item.severity === 'error');
  const status = hasErrors ? 'needs_attention' : offline ? 'local_ready' :
    checks.some(item => item.id.endsWith('..online') && item.status !== 'ready') ? 'checks_incomplete' : 'checks_passed';
  const hints = [hasErrors ? 'Resolve checks with severity "error", then rerun doctor.' :
    offline ? 'No local errors found.' : status === 'checks_incomplete' ?
      'No errors found, but some online checks remain unverified.' : 'No errors found in local or online checks.'];
  if (checks.some(item => item.severity === 'warning')) hints.push('Review checks with severity "warning".');
  if (offline) hints.push('Online checks were not run.');
  hints.push('Push permission is not checked.');
  return { schema: 'gidd.doctor/v1', mode: offline ? 'offline' : 'online', status,
    hint: hints.join(' '), folder: target, checks };
}
