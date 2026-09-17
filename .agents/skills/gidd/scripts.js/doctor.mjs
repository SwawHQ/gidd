import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurationPath, parseConfiguration, readConfigurationText, repositoryRoot, toolsRoot, compareVersions, managedExecutable } from './storage.mjs';
import { githubTarget, configurationHint } from './config.mjs';
import { remoteFields, inspectRemoteFields, blockCheck, remoteId } from './repository-check.mjs';
import { minimums, patterns, toolEnvironment } from './tools.mjs';
import { readBindings } from './bindings.mjs';
import { runCommand, checkGitHubRepository } from './github.mjs';
import { inspectSpec } from './specs.mjs';
import { gitSettingChecks, effectiveGitIdentity } from './doctor-git.mjs';
import { gitEnvironment, selectGitHubAccount } from './execution-env.mjs';

const safeReason = (error, fallback) => /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : fallback;
// Success describes the useful result; failure adds a stable reason, not raw output.
const check = (id, status, reason, details = {}) => ({ id, status,
  ...(status === 'ready' ? {} : { reason }), ...(Object.keys(details).length ? { details } : {}) });

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
    if (root) item.commands = [command(fileURLToPath(new URL('../gidd.pre.ensure.cmd', import.meta.url)), ['--repo', root])];
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
  } else if (id === 'folder.git.author') {
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

function inspectConfiguration(root) {
  if (!root) return { result: check('config.toml', 'not_checked', 'target_unavailable'), remote: {} };
  const path = configurationPath(root);
  let settings;
  try {
    if (!existsSync(path)) return { result: check('config.toml', 'missing', 'config_missing', { path }), remote: {} };
    settings = parseConfiguration(readConfigurationText(path));
  } catch (error) {
    return { result: check('config.toml', 'invalid', safeReason(error, 'config_unreadable'), { path }), remote: {} };
  }
  return { remote: settings.repo.remote, git: settings.git, spec: settings.spec, result: check('config.toml', 'ready', undefined, { path }) };
}

// These are startup probes of published paths, not tool discovery or installation validation.
async function inspectTools(execute) {
  let bindings, reason;
  try { bindings = readBindings(toolsRoot()).tools; }
  catch (error) { reason = safeReason(error, 'tool_bindings_invalid'); }
  const checks = [];
  for (const name of ['git', 'gh']) {
    const tool = bindings?.[name];
    let failure = reason || (!tool ? 'tool_binding_missing' : null), version;
    if (!failure) {
      const probe = await execute(tool.path, ['--version'], { timeoutMs: 5000, env: toolEnvironment(bindings.git?.path) });
      version = probe.ok && patterns[name].exec(probe.text)?.[1];
      failure = !probe.ok ? probe.reason : !version ? 'unrecognized_version' :
        compareVersions(version, minimums[name]) < 0 ? 'version_below_minimum' :
          version !== tool.version ? 'tool_binding_version_changed' : null;
    }
    checks.push(failure ? check('tool.' + name, !tool && (!reason || reason === 'tool_bindings_missing') ? 'missing' : 'invalid', failure) :
      check('tool.' + name, 'ready', undefined, { path: tool.path, version, gidd_managed: tool.source === 'managed' }));
  }
  return { checks, bindings: bindings || {} };
}

function managedRuntime(name) {
  try {
    // Native realpath also expands Windows short names consistently in Bun and Node.
    // An external target reached through a launcher junction is not managed.
    const actual = realpathSync.native(process.execPath);
    const expected = resolve(realpathSync.native(toolsRoot()), name, managedExecutable(name));
    return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  } catch { return false; }
}

export async function doctor(target, { offline = false, fixedRepository = false, execute = runCommand } = {}) {
  if (target !== undefined && (!target || !isAbsolute(target))) throw new Error('repository_must_be_absolute');
  target = target === undefined ? null : resolve(target);
  let configRoot, targetExists = false, targetError;
  try {
    targetExists = !!target && existsSync(target) && lstatSync(target).isDirectory();
    if (targetExists) configRoot = fixedRepository ? target : repositoryRoot(target);
  } catch (error) { targetError = safeReason(error, 'target_unreadable'); }
  const configuration = inspectConfiguration(configRoot);
  let fields = remoteFields(configuration.remote);
  if (configuration.result.status !== 'ready') fields = Object.fromEntries(['name', 'url', 'account'].map(key =>
    [key, { id: remoteId(key), status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' }]));
  const { checks: toolChecks, bindings } = await inspectTools(execute);
  const runtimeName = process.versions.bun ? 'bun' : 'node';
  const checks = [check('tool.js_runtime', 'ready', undefined, { name: runtimeName,
    path: process.execPath, version: process.versions.bun || process.versions.node,
    gidd_managed: managedRuntime(runtimeName) }), ...toolChecks];
  const { checks: [modeCheck] } = inspectSpec(configuration.spec?.mode, configRoot || target, configuration.result.status === 'ready');
  if (process.platform !== 'win32' || process.arch !== 'x64') checks.unshift(check('tool.platform', 'unsupported', 'unsupported_platform'));
  const usable = name => checks.find(item => item.id === 'tool.' + name)?.status === 'ready';
  const gitChecks = gitSettingChecks(configuration.git, configuration.result.status === 'ready');
  const userBlocker = gitChecks.find(item => item.id.startsWith('config.git.user.') && item.status !== 'ready');
  const credentialCheck = gitChecks.find(item => item.id === 'config.git.credential.mode');
  const apiTarget = fields.url.details?.expected && fields.account.status === 'ready' ? githubTarget({ url: fields.url.details.expected,
    name: fields.name.details?.expected, account: fields.account.details.expected }) : null;
  let env = toolEnvironment(usable('git') ? bindings.git.path : undefined);
  let environmentError;
  try {
    env = gitEnvironment({ user: !userBlocker ? configuration.git?.user : {},
      credential: credentialCheck.status === 'ready' && usable('gh') && apiTarget ? configuration.git.credential : {} }, bindings, apiTarget, env);
  } catch (error) { environmentError = safeReason(error, 'git_environment_invalid'); }
  const invoke = (args, timeoutMs = 5000) => execute(bindings.git.path, ['-C', target, ...args], { timeoutMs, env });
  let repository;
  if (!target) repository = check('folder.git.worktree', 'not_checked', 'target_required');
  else if (targetError) repository = check('folder.git.worktree', 'invalid', targetError);
  else if (!targetExists) repository = check('folder.git.worktree', 'invalid', 'directory_missing', { path: target });
  else if (fixedRepository && !existsSync(resolve(target, '.git'))) repository = check('folder.git.worktree', 'invalid', 'not_git_repository', { path: target });
  else if (!usable('git')) repository = check('folder.git.worktree', 'not_checked', 'git_unavailable');
  else {
    const inside = await invoke(['rev-parse', '--is-inside-work-tree']), top = await invoke(['rev-parse', '--show-toplevel']);
    if (!inside.ok || inside.text !== 'true' || !top.ok) {
      const marked = existsSync(resolve(configRoot, '.git'));
      repository = check('folder.git.worktree', 'invalid', inside.ok && inside.text === 'false' ? 'not_worktree' :
        marked ? 'not_readable_worktree' : 'not_git_repository', { path: target });
    } else repository = check('folder.git.worktree', 'ready', undefined, { path: top.text });
  }
  checks.push(repository);

  if (repository.status === 'ready') {
    const head = await invoke(['rev-parse', '--verify', 'HEAD']);
    if (head.ok) repository.details.commit = head.text;
    else {
      const symbolic = await invoke(['symbolic-ref', '-q', 'HEAD']);
      repository.status = symbolic.ok ? 'missing' : 'invalid';
      repository.reason = symbolic.ok ? 'unborn_branch' : 'head_unreadable';
    }
    // A readable worktree can still supply authors/remotes before its first commit.
    checks.push(userBlocker ? blockCheck(check('folder.git.author', 'ready'), userBlocker.id) :
      environmentError ? check('folder.git.author', 'failed', environmentError) : await effectiveGitIdentity(invoke));
    fields = await inspectRemoteFields(invoke, fields);
  } else {
    checks.push(check('folder.git.author', 'not_checked', 'repository_unavailable'));
    fields.name = blockCheck(fields.name, 'folder.git.worktree');
    fields.url = blockCheck(fields.url, fields.name.id);
  }
  // Stable presentation groups: tools, folders, then local and online config checks.
  // Cross-group prerequisites remain explicit through blocked_by.
  checks.push(configuration.result, fields.name, fields.url, fields.account, ...gitChecks, modeCheck);
  const accountId = remoteId('account') + '..online', urlId = remoteId('url') + '..online';
  if (offline) checks.push(check(accountId, 'not_checked', 'offline'), check(urlId, 'not_checked', 'offline'));
  else {
    // API identity is host/account-scoped, independent of local Git health.
    let account;
    if (!apiTarget || fields.account.status !== 'ready') account = blockCheck(check(accountId, 'ready'), fields.account.status !== 'ready' ? fields.account.id : fields.url.id);
    else if (!usable('gh')) account = blockCheck(check(accountId, 'ready'), 'tool.gh');
    else {
      try {
        const selected = await selectGitHubAccount({ gh: bindings.gh.path, ...apiTarget },
          { env, cwd: targetExists ? target : undefined, execute });
        env = selected.env;
        account = check(accountId, 'ready', undefined, selected.identity.details);
      } catch (error) {
        account = check(accountId, error.identity?.status || 'failed', safeReason(error, 'identity_check_failed'), error.identity?.details);
      }
    }
    checks.push(account);
    const blocker = [fields.name, fields.url].find(item => item.status !== 'ready');
    if (blocker) checks.push(blockCheck(check(urlId, 'ready'), blocker.id));
    else {
      const probes = {};
      if (account.status !== 'ready') probes.gh_remote_read = { status: 'not_checked', reason: 'dependency_unavailable', blocked_by: accountId };
      else {
        const result = await checkGitHubRepository({ gh: bindings.gh.path, ...apiTarget },
          (exe, args) => execute(exe, args, { cwd: targetExists ? target : undefined, env, timeoutMs: 15000 }));
        probes.gh_remote_read = result;
      }
      if (fields.url.details.protocol !== 'https') probes.git_remote_read = { status: 'not_checked', reason: 'ssh_probe_unsupported' };
      else if (configuration.git?.credential?.mode === 'gh' && account.status !== 'ready') {
        probes.git_remote_read = { status: 'not_checked', reason: 'dependency_unavailable', blocked_by: accountId };
      }
      else {
        const result = await invoke(['-c', 'credential.interactive=false', '-c', 'core.askPass=', 'ls-remote', '--', fields.name.details.expected, 'HEAD'], 15000);
        probes.git_remote_read = { status: result.ok ? 'ready' : 'failed', ...(!result.ok ? { reason: result.reason } : {}) };
      }
      const results = Object.values(probes);
      const failed = results.some(item => ['failed', 'mismatch'].includes(item.status));
      const complete = results.every(item => item.status === 'ready');
      checks.push(check(urlId, failed ? 'failed' : complete ? 'ready' : 'not_checked', failed ? 'online_probe_failed' : 'online_incomplete',
        { expected: fields.url.details.expected, remote: fields.name.details.expected, ...probes }));
    }
  }
  for (const item of checks) describeCheck(item, configRoot || target, bindings);
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
