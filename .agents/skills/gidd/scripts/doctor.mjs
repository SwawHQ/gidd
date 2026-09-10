import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurationPath, repositoryRoot, resolveStorage } from './storage.mjs';
import { check, findTool } from './tools.mjs';
import { runCommand } from './github.mjs';

export async function doctor(target) {
  if (!target || !isAbsolute(target)) throw new Error('repository_must_be_absolute');
  target = resolve(target);
  let storage, configurationError;
  try { storage = resolveStorage(existsSync(target) ? repositoryRoot(target) : null); }
  catch (error) { configurationError = error.message; }
  const checks = [check('platform', process.platform === 'win32' && process.arch === 'x64' ? 'ready' : 'unsupported',
    process.platform === 'win32' && process.arch === 'x64' ? 'supported' : 'unsupported_platform', { platform: process.platform, architecture: process.arch })];
  checks.push(storage ? check('tools.storage', 'ready', 'resolved', storage) : check('tools.storage', 'invalid', configurationError, { managed_tools_checked: false }));
  for (const name of ['git', 'node', 'bun', 'gh']) checks.push(await findTool(name, {
    root: name === 'git' ? '' : storage?.tools_root, requested: storage?.tools[name]?.version || '',
  }));
  checks.push(check('runtime', 'ready', 'current_process', { selected: process.versions.bun ? 'tool.bun' : 'tool.node',
    path: process.execPath, version: process.versions.bun || process.versions.node, compatibility_checked: false }));
  const git = checks.find(item => item.id === 'tool.git');
  let root;
  const invoke = args => runCommand(git.details.path, ['-C', target, ...args], { timeoutMs: 5000 });
  if (!existsSync(target) || !lstatSync(target).isDirectory()) checks.push(check('repository', 'invalid', 'directory_missing', { path: target }));
  else if (git.status !== 'ready') checks.push(check('repository', 'not_checked', 'git_unavailable', { depends_on: ['tool.git'] }));
  else {
    const inside = await invoke(['rev-parse','--is-inside-work-tree']), top = await invoke(['rev-parse','--show-toplevel']);
    if (!inside.ok || inside.text !== 'true' || !top.ok) checks.push(check('repository', 'invalid', 'not_readable_worktree', { path: target }));
    else {
      root = top.text;
      checks.push(check('repository','ready','worktree',{ path: root }));
      const head = await invoke(['rev-parse','--verify','HEAD']), symbolic = await invoke(['symbolic-ref','-q','HEAD']);
      checks.push(head.ok ? check('repository.history','ready','has_commit',{ commit: head.text }) :
        check('repository.history', symbolic.ok ? 'missing' : 'invalid', symbolic.ok ? 'unborn_branch' : 'head_unreadable'));
      const remotes = await invoke(['remote']), names = remotes.text.split(/\r?\n/).filter(Boolean), origins = [];
      for (const name of names) {
        const url = await invoke(['remote','get-url',name]);
        const slug = url.ok && /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.text)?.[1] || null;
        origins.push({ name, github_repository: slug, url_checked: url.ok });
      }
      checks.push(check('repository.remotes', !remotes.ok ? 'invalid' : names.length ? 'ready' : 'missing', 'local_remote_configuration_only', { remotes: origins }));
    }
  }
  if (root) {
    const path = configurationPath(root), status = !existsSync(path) ? 'missing' : lstatSync(path).isFile() ? 'ready' : 'invalid';
    checks.push(check('repository.config',status,'file_presence_only',{ path }));
    checks.push(configurationError ? check('repository.config.validation','invalid',configurationError) :
      status === 'ready' && storage.configured ? check('repository.config.validation','ready','tool_storage_schema_v1',{ tools_root: storage.tools_root }) :
        check('repository.config.validation','not_checked','config_missing'));
  } else for (const id of ['repository.config','repository.config.validation']) checks.push(check(id,'not_checked','repository_unavailable'));
  for (const id of ['github.identity','git.authentication']) checks.push(check(id,'not_checked','offline_diagnostic'));
  const required = ['platform','tools.storage','tool.git','runtime','tool.gh','repository','repository.history','repository.remotes','repository.config','repository.config.validation'];
  return { schema: 'gidd.doctor/v1', status: required.every(id => checks.some(item => item.id === id && item.status === 'ready')) ? 'local_ready' : 'needs_setup', repository: target, checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await doctor(process.argv[2]); console.log(JSON.stringify(result)); process.exitCode = result.status === 'local_ready' ? 0 : 1;
  } catch { console.log(JSON.stringify({ schema: 'gidd.doctor/v1', status: 'error', checks: [] })); process.exitCode = 2; }
}
