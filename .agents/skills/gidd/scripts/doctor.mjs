import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurationPath, parseConfiguration, readConfigurationText, repositoryRoot, toolsRoot, compareVersions, managedExecutable } from './storage.mjs';
import { normalizeRepositoryIdentity, validateGitHubField } from './config.mjs';
import { minimums, patterns, toolEnvironment } from './tools.mjs';
import { readBindings } from './bindings.mjs';
import { runCommand, checkGitHubIdentity } from './github.mjs';

const safeReason = (error, fallback) => /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : fallback;
// Success describes the useful result; failure adds a stable reason, not raw output.
const check = (id, status, reason, details = {}) => ({ id, status,
  ...(status === 'ready' ? {} : { reason }), ...(Object.keys(details).length ? { details } : {}) });

// A skipped dependent check is explained by its blocker, not another repair request.
const blockers = {
  target_unavailable: 'git.worktree', git_unavailable: 'git', gh_unavailable: 'gh',
  repository_unavailable: 'git.worktree', configuration_unavailable: 'config_file',
};

function blocked(item, by) {
  if (item.status === 'not_checked') return item;
  return { ...item, ...(item.status === 'ready' ? { status: 'not_checked', reason: 'dependency_unavailable' } : {}), blocked_by: by };
}

function describeCheck(item, root, bindings) {
  const { id, status, reason } = item;
  const configKey = id.startsWith('config.') ? id.slice('config.'.length) : undefined;
  item.severity = status === 'ready' || reason === 'offline' ? 'info' :
    ['unborn_branch', 'https_remote_required'].includes(reason) ? 'warning' : 'error';
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
  if (id === 'git' || id === 'gh') {
    item.hint = 'Run gidd.pre.ensure.cmd with this repository to repair shared tools and rebuild its entry.';
    if (root) item.commands = [command(fileURLToPath(new URL('../gidd.pre.ensure.cmd', import.meta.url)), ['--repo', root])];
    return;
  }
  if (id === 'config_file') {
    if (reason === 'config_missing') {
      item.hint = 'Create config.toml with config set github.account, review the generated defaults, then rerun doctor for field checks.';
      if (link) item.commands = [command(link, ['config', 'set', 'github.account', '<value>'], ['github.account'])];
    } else {
      item.hint = 'Repair config.toml at the reported path, preserving unrelated settings and comments, then rerun doctor. Invalid values are omitted from this report.';
    }
    return;
  }
  if (id === 'git.worktree') {
    item.hint = reason === 'unborn_branch' ? 'This repository has no commits yet. Create the first commit when there is work to save; local configuration can continue.' :
      reason === 'head_unreadable' ? 'Repair the repository HEAD, then rerun doctor.' :
      reason === 'target_required' ? 'Run the actual skill gidd.pre.ensure.cmd --repo <Git-working-tree-root>, then invoke the generated gidd.link.cmd by its full path.' :
      'Check the reported directory and its Git working-tree metadata. Restore the intended repository or explicitly initialize Git there, then rerun doctor; do not substitute a parent repository.';
  } else if (id === 'git.author') {
    item.hint = 'Check the local Git author name and email. If missing, set values supplied by the user, then rerun doctor.';
    if (root && bindings.git) item.commands = ['name', 'email'].map(key => command(bindings.git.path,
      ['-C', root, 'config', '--local', `user.${key}`, '<value>'], [`user.${key}`]));
  } else if (id === 'config.github.remote') {
    item.hint = 'Use git remote -v to review local remotes, then set github.remote to the intended remote name. For multiple fetch URLs, inspect get-url --all and select a remote with one unambiguous fetch URL.';
    item.commands = [...remoteCommands];
    if (root && bindings.git && item.details?.configured) item.commands.push(command(bindings.git.path,
      ['-C', root, 'remote', 'get-url', '--all', item.details.configured]));
    if (link) item.commands.push(command(link, ['config', 'set', configKey, '<value>'], [configKey]));
  } else if (id === 'config.github.hostname' || id === 'config.github.repository') {
    item.hint = id === 'config.github.hostname' ?
      'Review the selected remote and its host. Set github.hostname to the intended GitHub host, or restore the intended remote, then rerun doctor.' :
      'Review the Issue/PR target and github.remote, hostname and account. Record the intended canonical repository URL with config set, or restore the intended remote, then rerun doctor. Do not accept a changed target automatically.';
    item.commands = [];
    if (link) item.commands.push({ ...command(link, ['config', 'set', configKey, item.details?.actual || '<value>'],
      item.details?.actual ? [] : [configKey]), requires_configuration_review: true });
    item.commands.push(...remoteCommands);
  } else if (id === 'config.github.account') {
    item.hint = 'Set github.account to the expected GitHub login, then rerun doctor. Setting this field does not log in or change Git author information.';
    if (link) item.commands = [command(link, ['config', 'set', configKey, '<value>'], [configKey])];
  } else if (id === 'github.identity') {
    item.hint = reason === 'unexpected_account' ? 'The authenticated account differs from github.account. Confirm the intended identity before changing configuration or credentials.' :
      'GitHub identity could not be verified. Check connectivity, the configured host/account and gh authentication. A failed API request does not by itself mean login is required.';
    if (link) item.commands = [{ ...command(link, ['auth']), requires_user_authorization: true }];
  } else if (id === 'git.remote_read') {
    item.hint = reason === 'https_remote_required' ? 'SSH remote reading is not probed by doctor. Verify SSH access separately before remote operations; changing to HTTPS is not required.' :
      'Check connectivity, repository access and Git transport credentials, then rerun doctor. GitHub API login does not prove Git transport access or push permission.';
  } else if (id === 'platform') item.hint = 'Use the currently supported Windows x64 platform.';
}

function inspectConfiguration(root) {
  if (!root) return { result: check('config_file', 'not_checked', 'target_unavailable'), github: {} };
  const path = configurationPath(root);
  let settings;
  try {
    if (!existsSync(path)) return { result: check('config_file', 'missing', 'config_missing', { path }), github: {} };
    settings = parseConfiguration(readConfigurationText(path));
  } catch (error) {
    return { result: check('config_file', 'invalid', safeReason(error, 'config_unreadable'), { path }), github: {} };
  }
  return { github: settings.github, result: check('config_file', 'ready', undefined, { path }) };
}

function inspectField(key, configuration) {
  const id = `config.github.${key}`;
  if (configuration.result.status !== 'ready') return check(id, 'not_checked', 'configuration_unavailable');
  if (!Object.hasOwn(configuration.github, key)) return check(id, 'missing', `config_missing_github_${key}`);
  const value = configuration.github[key];
  try { validateGitHubField(key, value); }
  catch { return check(id, 'invalid', `config_invalid_github_${key}`); }
  return check(id, 'ready', undefined, { configured: key === 'repository' ? normalizeRepositoryIdentity(value) : value });
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
    checks.push(failure ? check(name, !tool && (!reason || reason === 'tool_bindings_missing') ? 'missing' : 'invalid', failure) :
      check(name, 'ready', undefined, { path: tool.path, version, gidd_managed: tool.source === 'managed' }));
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

// Parse only unambiguous addresses. Raw URLs may contain credentials and never enter reports.
export function remoteAddress(text) {
  if (/[\s\\%?#]/.test(text)) return null;
  let protocol = 'https', match = /^https:\/\/([^/:@]+)\/([^/]+)\/([^/]+)\/?$/i.exec(text);
  if (!match) { protocol = 'ssh'; match = /^git@([^/:@]+):([^/]+)\/([^/]+)\/?$/i.exec(text); }
  if (!match) match = /^ssh:\/\/git@([^/:@]+)(?::[0-9]+)?\/([^/]+)\/([^/]+)\/?$/i.exec(text);
  if (!match) return null;
  const [, hostname, owner, rawName] = match, name = rawName.replace(/\.git$/i, '');
  try { validateGitHubField('hostname', hostname); } catch { return null; }
  if (![owner, name].every(value => /^[a-z0-9_.-]+$/i.test(value) && !['.', '..'].includes(value))) return null;
  return { protocol, hostname: hostname.toLowerCase(), repository: owner + '/' + name };
}

async function inspectRemote(invoke, field) {
  if (field.status !== 'ready') return field;
  const details = { ...field.details }, name = details.configured;
  const listed = await invoke(['remote']);
  if (!listed.ok) return check(field.id, 'invalid', listed.reason, details);
  if (!listed.text.split(/\r?\n/).includes(name)) return check(field.id, 'missing', 'configured_remote_missing', details);
  const result = await invoke(['remote', 'get-url', '--all', name]);
  if (!result.ok) return check(field.id, 'invalid', result.reason, details);
  const urls = result.text.split(/\r?\n/).filter(Boolean);
  if (urls.length !== 1) return check(field.id, 'invalid', 'remote_url_ambiguous', details);
  const address = remoteAddress(urls[0]);
  if (!address) return check(field.id, 'invalid', 'unsupported_remote_url', details);
  details.fetch_identity = normalizeRepositoryIdentity(`https://${address.hostname}/${address.repository}`);
  return check(field.id, 'ready', undefined,
    { ...details, hostname: address.hostname, github_repository: address.repository, protocol: address.protocol });
}

function inspectRemoteMatch(field, remote) {
  if (remote.status !== 'ready') return blocked(field, remote.id);
  const actual = field.id === 'config.github.hostname' ? remote.details.hostname : remote.details.fetch_identity;
  const details = { ...field.details, actual, remote: remote.details.configured };
  if (field.status !== 'ready') return { ...field, details };
  if (details.configured.toLowerCase() !== actual) return check(field.id, 'mismatch',
    field.id === 'config.github.hostname' ? 'remote_hostname_mismatch' : 'repository_identity_changed', details);
  return check(field.id, 'ready', undefined, details);
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
  const fields = Object.fromEntries(['remote', 'hostname', 'repository', 'account'].map(key => [key, inspectField(key, configuration)]));
  const github = Object.fromEntries(Object.entries(fields).filter(([, field]) => field.status === 'ready')
    .map(([key, field]) => [key, field.details.configured]));
  const { checks: toolChecks, bindings } = await inspectTools(execute);
  const runtimeName = process.versions.bun ? 'bun' : 'node';
  const checks = [check('js_runtime', 'ready', undefined, { name: runtimeName,
    path: process.execPath, version: process.versions.bun || process.versions.node,
    gidd_managed: managedRuntime(runtimeName) }), ...toolChecks, configuration.result];
  if (process.platform !== 'win32' || process.arch !== 'x64') checks.push(check('platform', 'unsupported', 'unsupported_platform'));
  const usable = name => checks.find(item => item.id === name)?.status === 'ready';
  const env = toolEnvironment(usable('git') ? bindings.git.path : undefined);
  const invoke = (args, timeoutMs = 5000) => execute(bindings.git.path, ['-C', target, ...args], { timeoutMs, env });
  let repository;
  if (!target) repository = check('git.worktree', 'not_checked', 'target_required');
  else if (targetError) repository = check('git.worktree', 'invalid', targetError);
  else if (!targetExists) repository = check('git.worktree', 'invalid', 'directory_missing', { path: target });
  else if (fixedRepository && !existsSync(resolve(target, '.git'))) repository = check('git.worktree', 'invalid', 'not_git_repository', { path: target });
  else if (!usable('git')) repository = check('git.worktree', 'not_checked', 'git_unavailable');
  else {
    const inside = await invoke(['rev-parse', '--is-inside-work-tree']), top = await invoke(['rev-parse', '--show-toplevel']);
    if (!inside.ok || inside.text !== 'true' || !top.ok) {
      const marked = existsSync(resolve(configRoot, '.git'));
      repository = check('git.worktree', 'invalid', inside.ok && inside.text === 'false' ? 'not_worktree' :
        marked ? 'not_readable_worktree' : 'not_git_repository', { path: target });
    } else repository = check('git.worktree', 'ready', undefined, { path: top.text });
  }
  checks.push(repository);
  let remote;
  if (repository.status === 'ready') {
    const head = await invoke(['rev-parse', '--verify', 'HEAD']);
    if (head.ok) repository.details.commit = head.text;
    else {
      const symbolic = await invoke(['symbolic-ref', '-q', 'HEAD']);
      repository.status = symbolic.ok ? 'missing' : 'invalid';
      repository.reason = symbolic.ok ? 'unborn_branch' : 'head_unreadable';
    }
    // A readable worktree can still supply authors/remotes before its first commit.
    const author = await invoke(['var', 'GIT_AUTHOR_IDENT']);
    const match = author.ok && /^(.+) <([^<>\r\n]+)> \d+ [+-]\d{4}$/.exec(author.text);
    checks.push(match ? check('git.author', 'ready', undefined, { name: match[1], email: match[2] }) :
      check('git.author', 'failed', author.ok ? 'invalid_author_response' : author.reason));
    remote = await inspectRemote(invoke, fields.remote);
  } else {
    checks.push(check('git.author', 'not_checked', 'repository_unavailable'));
    remote = blocked(fields.remote, 'git.worktree');
  }
  const hostname = inspectRemoteMatch(fields.hostname, remote), identity = inspectRemoteMatch(fields.repository, remote);
  checks.push(remote, hostname, identity, fields.account);
  if (offline) checks.push(check('github.identity', 'not_checked', 'offline'), check('git.remote_read', 'not_checked', 'offline'));
  else {
    if (!github.hostname || !github.account) checks.push(blocked(check('github.identity', 'ready'), !github.hostname ? fields.hostname.id : fields.account.id));
    else if (!usable('gh')) checks.push(check('github.identity', 'not_checked', 'gh_unavailable'));
    else {
      const result = await checkGitHubIdentity({ gh: bindings.gh.path, ...github },
        (exe, args) => execute(exe, args, { cwd: targetExists ? target : undefined, env, timeoutMs: 15000 }));
      checks.push(check('github.identity', result.status, result.reason, result.details));
    }
    const remoteBlocker = [remote, hostname, identity].find(item => item.status !== 'ready');
    if (remoteBlocker) checks.push(blocked(check('git.remote_read', 'ready'), remoteBlocker.id));
    else if (remote.details.protocol !== 'https') checks.push(check('git.remote_read', 'not_checked', 'https_remote_required'));
    else {
      const result = await invoke(['-c', 'credential.interactive=false', '-c', 'core.askPass=', 'ls-remote', '--', github.remote, 'HEAD'], 15000);
      checks.push(check('git.remote_read', result.ok ? 'ready' : 'failed', result.reason, { remote: github.remote }));
    }
  }
  for (const item of checks) describeCheck(item, configRoot || target, bindings);
  return { schema: 'gidd.doctor/v1', mode: offline ? 'offline' : 'online',
    status: checks.some(item => item.severity === 'error') ? 'needs_attention' : offline ? 'local_ready' : 'checks_passed',
    hint: 'Resolve error checks and rerun doctor. Warnings describe remaining limitations. Offline success covers local checks only; no mode proves push permission.',
    repository: target, checks };
}
