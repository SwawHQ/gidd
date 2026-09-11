import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurationPath, parseConfiguration, readConfigurationText, repositoryRoot, resolveStorage } from './storage.mjs';
import { validateGitHubField } from './config.mjs';
import { check, findTool } from './tools.mjs';
import { runCommand } from './github.mjs';

const safeReason = (error, fallback) => /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : fallback;

function inspectConfiguration(root) {
  const ids = ['repository.config', 'repository.config.validation', 'repository.config.github'];
  if (!root) return { checks: ids.map(id => check(id, 'not_checked', 'target_unavailable')), github: {} };
  const path = configurationPath(root), checks = [];
  let settings;
  try {
    if (!existsSync(path)) return { checks: [check(ids[0], 'missing', 'config_missing', { path }),
      ...ids.slice(1).map(id => check(id, 'not_checked', 'config_missing'))], github: {} };
    const file = lstatSync(path).isFile();
    checks.push(check(ids[0], file ? 'ready' : 'invalid', file ? 'file_presence_only' : 'config_not_a_file', { path }));
    settings = parseConfiguration(readConfigurationText(path));
    checks.push(check(ids[1], 'ready', 'configuration_schema_v1'));
  } catch (error) {
    if (!checks.length) checks.push(check(ids[0], 'invalid', 'config_unreadable', { path }));
    checks.push(check(ids[1], 'invalid', safeReason(error, 'config_unreadable')),
      check(ids[2], 'not_checked', 'config_invalid'));
    return { checks, github: {} };
  }
  const missing = [], invalid = [], github = {};
  for (const key of ['hostname', 'account', 'remote']) {
    if (!Object.hasOwn(settings.github, key)) missing.push(key);
    else {
      try { validateGitHubField(key, settings.github[key]); github[key] = settings.github[key]; }
      catch { invalid.push(key); }
    }
  }
  checks.push(check(ids[2], invalid.length ? 'invalid' : missing.length ? 'missing' : 'ready',
    invalid.length ? 'github_fields_invalid' : missing.length ? 'github_fields_missing' : 'github_fields_valid',
    { missing_fields: missing, invalid_fields: invalid }));
  return { checks, github };
}

// Parse only unambiguous repository addresses. Never include raw URLs in reports.
function remoteAddress(text) {
  if (/[\s\\%?#]/.test(text)) return null;
  let match = /^https:\/\/([^/:@]+)\/([^/]+)\/([^/]+)\/?$/i.exec(text);
  if (!match) match = /^git@([^/:@]+):([^/]+)\/([^/]+)\/?$/i.exec(text);
  if (!match) match = /^ssh:\/\/git@([^/:@]+)(?::[0-9]+)?\/([^/]+)\/([^/]+)\/?$/i.exec(text);
  if (!match) return null;
  const [, hostname, owner, rawName] = match, name = rawName.replace(/\.git$/i, '');
  try { validateGitHubField('hostname', hostname); } catch { return null; }
  if (![owner, name].every(value => /^[a-z0-9_.-]+$/i.test(value) && !['.', '..'].includes(value))) return null;
  return { hostname: hostname.toLowerCase(), repository: owner + '/' + name };
}

async function inspectRemotes(invoke, github) {
  const listed = await invoke(['remote']);
  const remotes = [], addresses = new Map();
  if (listed.ok) for (const name of listed.text.split(/\r?\n/).filter(Boolean)) {
    const result = await invoke(['remote', 'get-url', '--all', name]);
    const urls = result.ok ? result.text.split(/\r?\n/).filter(Boolean) : [];
    const address = urls.length === 1 ? remoteAddress(urls[0]) : null;
    addresses.set(name, { result, urls, address });
    remotes.push({ name, url_checked: result.ok, github_repository:
      address && [github.hostname?.toLowerCase(), 'github.com'].includes(address.hostname) ? address.repository : null });
  }
  const checks = [check('repository.remotes', !listed.ok ? 'invalid' : remotes.length ? 'ready' : 'missing',
    !listed.ok ? 'remote_list_unreadable' : remotes.length ? 'local_remote_configuration_only' : 'no_remotes', { remotes })];
  let selected;
  if (!listed.ok) selected = check('repository.remote', 'not_checked', 'remote_list_unreadable');
  else if (!github.hostname || !github.remote) selected = check('repository.remote', 'not_checked', 'github_remote_configuration_required');
  else {
    const found = addresses.get(github.remote), details = { name: github.remote, expected_hostname: github.hostname };
    if (!found) selected = check('repository.remote', 'missing', 'configured_remote_missing', details);
    else if (!found.result.ok) selected = check('repository.remote', 'invalid', 'remote_url_unreadable', details);
    else if (found.urls.length !== 1) selected = check('repository.remote', 'invalid', 'remote_url_ambiguous', details);
    else if (!found.address) selected = check('repository.remote', 'invalid', 'unsupported_remote_url', details);
    else if (found.address.hostname !== github.hostname.toLowerCase()) selected = check('repository.remote', 'invalid', 'remote_hostname_mismatch',
      { ...details, actual_hostname: found.address.hostname });
    else selected = check('repository.remote', 'ready', 'configured_remote_host_matches',
      { ...details, hostname: found.address.hostname, github_repository: found.address.repository });
  }
  return [...checks, selected];
}

export async function doctor(target) {
  if (target !== undefined && (!target || !isAbsolute(target))) throw new Error('repository_must_be_absolute');
  target = target === undefined ? null : resolve(target);
  let configRoot, targetExists = false, targetError, storage, storageError;
  try {
    targetExists = !!target && existsSync(target) && lstatSync(target).isDirectory();
    if (targetExists) configRoot = repositoryRoot(target);
  } catch (error) { targetError = safeReason(error, 'target_unreadable'); }
  const configuration = inspectConfiguration(configRoot);
  try {
    if (targetError) throw new Error(targetError);
    storage = resolveStorage(configRoot || null);
  } catch (error) { storageError = safeReason(error, 'storage_unreadable'); }
  const checks = [check('platform', process.platform === 'win32' && process.arch === 'x64' ? 'ready' : 'unsupported',
    process.platform === 'win32' && process.arch === 'x64' ? 'supported' : 'unsupported_platform', { platform: process.platform, architecture: process.arch })];
  // GitHub field values can be malformed; tool diagnostics need only tool settings.
  const { github: omitted, ...storageDetails } = storage || {};
  checks.push(storage ? check('tools.storage', 'ready', 'resolved', storageDetails) : check('tools.storage', 'invalid', storageError, { managed_tools_checked: false }));
  for (const name of ['git', 'node', 'bun', 'gh']) checks.push(await findTool(name, {
    root: name === 'git' ? '' : storage?.tools_root, requested: storage?.tools[name]?.version || '',
  }));
  checks.push(check('runtime', 'ready', 'current_process', { selected: process.versions.bun ? 'tool.bun' : 'tool.node',
    path: process.execPath, version: process.versions.bun || process.versions.node, compatibility_checked: false }));
  const git = checks.find(item => item.id === 'tool.git');
  let root;
  const invoke = args => runCommand(git.details.path, ['-C', target, ...args], { timeoutMs: 5000 });
  if (!target) checks.push(check('repository', 'not_checked', 'target_required'));
  else if (targetError) checks.push(check('repository', 'invalid', targetError));
  else if (!targetExists) checks.push(check('repository', 'invalid', 'directory_missing', { path: target }));
  else if (git.status !== 'ready') checks.push(check('repository', 'not_checked', 'git_unavailable', { depends_on: ['tool.git'] }));
  else {
    const inside = await invoke(['rev-parse', '--is-inside-work-tree']), top = await invoke(['rev-parse', '--show-toplevel']);
    if (!inside.ok || inside.text !== 'true' || !top.ok) {
      const marked = existsSync(resolve(configRoot, '.git'));
      checks.push(check('repository', 'invalid', inside.ok && inside.text === 'false' ? 'not_worktree' :
        marked ? 'not_readable_worktree' : 'not_git_repository', { path: target }));
    } else {
      root = top.text;
      checks.push(check('repository', 'ready', 'worktree', { path: root }));
      const head = await invoke(['rev-parse', '--verify', 'HEAD']), symbolic = await invoke(['symbolic-ref', '-q', 'HEAD']);
      checks.push(head.ok ? check('repository.history', 'ready', 'has_commit', { commit: head.text }) :
        check('repository.history', symbolic.ok ? 'missing' : 'invalid', symbolic.ok ? 'unborn_branch' : 'head_unreadable'));
      checks.push(...await inspectRemotes(invoke, configuration.github));
    }
  }
  if (!root) for (const id of ['repository.history', 'repository.remotes', 'repository.remote']) checks.push(check(id, 'not_checked', 'repository_unavailable'));
  checks.push(...configuration.checks);
  for (const id of ['github.identity', 'git.authentication']) checks.push(check(id, 'not_checked', 'offline_diagnostic'));
  const required = ['platform', 'tools.storage', 'tool.git', 'runtime', 'tool.gh', 'repository', 'repository.history',
    'repository.remotes', 'repository.remote', 'repository.config', 'repository.config.validation', 'repository.config.github'];
  return { schema: 'gidd.doctor/v1', status: required.every(id => checks.some(item => item.id === id && item.status === 'ready')) ? 'local_ready' : 'needs_setup', repository: target, checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await doctor(process.argv[2]); console.log(JSON.stringify(result)); process.exitCode = result.status === 'local_ready' ? 0 : 1;
  } catch { console.log(JSON.stringify({ schema: 'gidd.doctor/v1', status: 'error', checks: [] })); process.exitCode = 2; }
}
