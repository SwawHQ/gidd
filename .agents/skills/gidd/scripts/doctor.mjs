import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { configurationPath, parseConfiguration, readConfigurationText, repositoryRoot, toolsRoot, compareVersions, managedExecutable } from './storage.mjs';
import { validateGitHubField } from './config.mjs';
import { minimums, patterns, toolEnvironment } from './tools.mjs';
import { readBindings } from './bindings.mjs';
import { runCommand, checkGitHubIdentity } from './github.mjs';

const safeReason = (error, fallback) => /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : fallback;
// Success describes the useful result; failure adds a stable reason, not raw output.
const check = (id, status, reason, details = {}) => ({ id, status,
  ...(status === 'ready' ? {} : { reason }), ...(Object.keys(details).length ? { details } : {}) });

function inspectConfiguration(root) {
  if (!root) return { result: check('config', 'not_checked', 'target_unavailable'), github: {} };
  const path = configurationPath(root);
  let settings;
  try {
    if (!existsSync(path)) return { result: check('config', 'missing', 'config_missing', { path }), github: {} };
    settings = parseConfiguration(readConfigurationText(path));
  } catch (error) {
    return { result: check('config', 'invalid', safeReason(error, 'config_unreadable'), { path }), github: {} };
  }
  const missing = [], invalid = [], github = {};
  for (const key of ['hostname', 'account', 'remote']) {
    if (!Object.hasOwn(settings.github, key)) missing.push(key);
    else {
      try { validateGitHubField(key, settings.github[key]); github[key] = settings.github[key]; }
      catch { invalid.push(key); }
    }
  }
  return { github, result: check('config', invalid.length ? 'invalid' : missing.length ? 'missing' : 'ready',
    invalid.length ? 'github_fields_invalid' : 'github_fields_missing',
    { path, ...(missing.length ? { missing_fields: missing } : {}), ...(invalid.length ? { invalid_fields: invalid } : {}) }) };
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
    checks.push(failure ? { ...check(name, !tool && (!reason || reason === 'tool_bindings_missing') ? 'missing' : 'invalid', failure),
      hint: 'Run gidd tools --ensure' } : check(name, 'ready', undefined, { path: tool.path, version, gidd_managed: tool.source === 'managed' }));
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

async function inspectRemote(invoke, github) {
  if (!github.hostname || !github.remote) return check('repository.remote', 'not_checked', 'github_remote_configuration_required');
  const details = { name: github.remote };
  const listed = await invoke(['remote']);
  if (!listed.ok) return check('repository.remote', 'invalid', listed.reason);
  if (!listed.text.split(/\r?\n/).includes(github.remote)) return check('repository.remote', 'missing', 'configured_remote_missing', details);
  const result = await invoke(['remote', 'get-url', '--all', github.remote]);
  if (!result.ok) return check('repository.remote', 'invalid', result.reason, details);
  const urls = result.text.split(/\r?\n/).filter(Boolean);
  if (urls.length !== 1) return check('repository.remote', 'invalid', 'remote_url_ambiguous', details);
  const address = remoteAddress(urls[0]);
  if (!address) return check('repository.remote', 'invalid', 'unsupported_remote_url', details);
  if (address.hostname !== github.hostname.toLowerCase()) return check('repository.remote', 'invalid', 'remote_hostname_mismatch',
    { ...details, expected_hostname: github.hostname, actual_hostname: address.hostname });
  return check('repository.remote', 'ready', undefined,
    { ...details, hostname: address.hostname, github_repository: address.repository, protocol: address.protocol });
}

export async function doctor(target, { offline = false, execute = runCommand } = {}) {
  if (target !== undefined && (!target || !isAbsolute(target))) throw new Error('repository_must_be_absolute');
  target = target === undefined ? null : resolve(target);
  let configRoot, targetExists = false, targetError;
  try {
    targetExists = !!target && existsSync(target) && lstatSync(target).isDirectory();
    if (targetExists) configRoot = repositoryRoot(target);
  } catch (error) { targetError = safeReason(error, 'target_unreadable'); }
  const configuration = inspectConfiguration(configRoot), github = configuration.github;
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
  if (!target) repository = check('repository', 'not_checked', 'target_required');
  else if (targetError) repository = check('repository', 'invalid', targetError);
  else if (!targetExists) repository = check('repository', 'invalid', 'directory_missing', { path: target });
  else if (!usable('git')) repository = check('repository', 'not_checked', 'git_unavailable');
  else {
    const inside = await invoke(['rev-parse', '--is-inside-work-tree']), top = await invoke(['rev-parse', '--show-toplevel']);
    if (!inside.ok || inside.text !== 'true' || !top.ok) {
      const marked = existsSync(resolve(configRoot, '.git'));
      repository = check('repository', 'invalid', inside.ok && inside.text === 'false' ? 'not_worktree' :
        marked ? 'not_readable_worktree' : 'not_git_repository', { path: target });
    } else repository = check('repository', 'ready', undefined, { path: top.text });
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
    remote = await inspectRemote(invoke, github);
  } else {
    checks.push(check('git.author', 'not_checked', 'repository_unavailable'));
    remote = check('repository.remote', 'not_checked', 'repository_unavailable');
  }
  checks.push(remote);
  if (offline) checks.push(check('github.identity', 'not_checked', 'offline'), check('git.remote_read', 'not_checked', 'offline'));
  else {
    if (!github.hostname || !github.account) checks.push(check('github.identity', 'not_checked', 'github_identity_configuration_required'));
    else if (!usable('gh')) checks.push(check('github.identity', 'not_checked', 'gh_unavailable'));
    else {
      const result = await checkGitHubIdentity({ gh: bindings.gh.path, ...github },
        (exe, args) => execute(exe, args, { cwd: targetExists ? target : undefined, env, timeoutMs: 15000 }));
      checks.push(check('github.identity', result.status, result.reason, result.details));
    }
    if (remote.status !== 'ready') checks.push(check('git.remote_read', 'not_checked', 'remote_unavailable'));
    else if (remote.details.protocol !== 'https') checks.push(check('git.remote_read', 'not_checked', 'https_remote_required'));
    else {
      const result = await invoke(['-c', 'credential.interactive=false', '-c', 'core.askPass=', 'ls-remote', '--', github.remote, 'HEAD'], 15000);
      checks.push(check('git.remote_read', result.ok ? 'ready' : 'failed', result.reason, { remote: github.remote }));
    }
  }
  const required = checks.filter(item => !offline || !['github.identity', 'git.remote_read'].includes(item.id));
  return { schema: 'gidd.doctor/v1', mode: offline ? 'offline' : 'online',
    status: required.every(item => item.status === 'ready') ? offline ? 'local_ready' : 'checks_passed' : 'needs_attention',
    repository: target, checks };
}
