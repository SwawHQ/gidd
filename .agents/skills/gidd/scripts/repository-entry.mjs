import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { durableFile } from './install.mjs';
import { plainPath } from './storage.mjs';
import { remoteAddress } from './doctor.mjs';
import { validateGitHubField } from './config.mjs';
import { runCommand } from './github.mjs';

const sourceEntry = fileURLToPath(new URL('../gidd.cmd', import.meta.url));
const schema = 'gidd.repository-entry/v1';
const reasonOf = error => /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : 'repository_entry_failed';
const samePath = (a, b) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

export function entryPath(repository) { return join(repository, '.agents/skills/gidd/gidd.link.cmd'); }

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

function validateSpec(spec) {
  if (spec?.schema !== schema || typeof spec.entry !== 'string' || !spec.entry ||
      /[\x00-\x1f"<>|]/.test(spec.entry) || !spec.entry.replaceAll('\\', '/').endsWith('gidd.cmd') ||
      Object.keys(spec).some(key => !['schema', 'entry'].includes(key))) throw new Error('repository_entry_invalid');
  return spec;
}

export function renderRepositoryEntry(spec) {
  validateSpec(spec);
  const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  // A single JS process decodes the location and enters the installed dispatcher.
  // Keeping batch source ASCII avoids CHCP, extra CMD expansion, and an extra shell.
  const loader = "const p=require('node:path'),u=require('node:url'),d=process.env.GIDD_LINK_DIRECTORY,s=JSON.parse(Buffer.from(process.env.GIDD_LINK_SPEC,'base64').toString('utf8'));import(u.pathToFileURL(p.join(p.dirname(p.resolve(d,s.entry)),'scripts','repository-entry.mjs')).href).then(m=>m.runLink(d,s,process.argv.slice(1))).then(c=>process.exitCode=c).catch(()=>{console.error('GIDD linked skill is unavailable. Rerun gidd.tools.ensure.cmd --repository with the target directory.');console.log(JSON.stringify({schema:'gidd.repository-entry/v1',status:'error',reason:'linked_skill_unavailable'}));process.exitCode=2})";
  return ['@echo off', 'setlocal DisableDelayedExpansion', 'rem GIDD_LINK ' + encoded,
    'set "GIDD_LINK_DIRECTORY=%~dp0"', 'set "GIDD_LINK_SPEC=' + encoded + '"',
    'if not exist "%USERPROFILE%\\.agents\\skills.tools\\gidd\\js_exec.cmd" goto :missing',
    '"%USERPROFILE%\\.agents\\skills.tools\\gidd\\js_exec.cmd" -e "' + loader + '" -- %*',
    ':missing', '>&2 echo GIDD runtime launcher missing. Rerun gidd.tools.ensure.cmd --repository with the target directory.',
    'echo {"schema":"gidd.repository-entry/v1","status":"error","reason":"bootstrap_required"}',
    'exit /b 2', ''].join('\r\n');
}

function existingEntry(path) {
  plainPath(path);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 16384) throw new Error('repository_entry_occupied');
  const text = readFileSync(path, 'utf8');
  try {
    const encoded = /^rem GIDD_LINK ([A-Za-z0-9+/=]+)\r?$/m.exec(text)?.[1];
    const spec = JSON.parse(Buffer.from(encoded || '', 'base64').toString('utf8'));
    if (renderRepositoryEntry(spec) !== text) throw new Error();
  } catch { throw new Error('repository_entry_occupied'); }
  return text;
}

export function inspectEntryDestination(repository) {
  requireRoot(repository);
  return existingEntry(entryPath(repository));
}

function desiredEntry(repository, entry) {
  requireRoot(repository);
  plainPath(entry);
  if (!lstatSync(entry).isFile()) throw new Error('linked_skill_unavailable');
  const path = entryPath(repository), fromRoot = relative(repository, entry);
  const internal = !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith('..' + sep);
  const spec = { schema, entry: internal ? relative(dirname(path), entry) : resolve(entry) };
  const text = renderRepositoryEntry(spec);
  return { text, path, target: repository, location: internal ? 'relative' : 'absolute' };
}

export function checkRepositoryLink(repository, entry = sourceEntry) {
  const { text, ...details } = desiredEntry(repository, entry);
  const original = inspectEntryDestination(repository);
  if (existsSync(details.path + '.lock')) return { ...details, status: 'invalid', reason: 'repository_entry_locked' };
  if (original === null) return { ...details, status: 'missing', reason: 'repository_entry_missing' };
  return { ...details, status: original === text ? 'ready' : 'invalid',
    reason: original === text ? 'repository_entry_verified' : 'repository_entry_outdated' };
}

export function publishRepositoryEntry(repository, entry = sourceEntry) {
  const { text, ...details } = desiredEntry(repository, entry);
  const { path } = details;
  inspectEntryDestination(repository);
  mkdirSync(dirname(path), { recursive: true });
  plainPath(path);
  const lockPath = path + '.lock', temporary = path + '.' + randomUUID() + '.tmp';
  let lock;
  try {
    try { lock = openSync(lockPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('repository_entry_locked'); throw error; }
    const original = existingEntry(path);
    if (original === text) return { status: 'ready', action: 'reused', ...details };
    durableFile(temporary, text);
    if (existingEntry(path) !== original) throw new Error('repository_entry_changed');
    renameSync(temporary, path);
    return { status: 'ready', action: original === null ? 'created' : 'updated', ...details };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}

export async function runLink(directory, spec, args) {
  try {
    validateSpec(spec);
    const repository = resolve(directory, '../../..');
    if (resolve(repository, '.agents/skills/gidd').toLowerCase() !== resolve(directory).toLowerCase()) throw new Error('repository_entry_location_invalid');
    const entry = resolve(directory, spec.entry);
    if (samePath(entry, entryPath(repository))) throw new Error('repository_entry_recursive');
    // Verify we entered the very skill named by the link, not another copied helper.
    if (!samePath(entry, sourceEntry)) throw new Error('repository_entry_target_mismatch');
    if (args.some(arg => arg === '--repository' || arg.startsWith('--repository='))) throw new Error('repository_override_forbidden');
    delete process.env.GIDD_LINK_DIRECTORY; delete process.env.GIDD_LINK_SPEC;
    if ((args[0] || '').toLowerCase() === 'tools') {
      requireRoot(repository);
      const shell = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      return await new Promise((resolveResult, reject) => {
        const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
          join(dirname(entry), 'scripts/windows/bootstrap.ps1'), ...args, '--repository', repository],
        { stdio: 'inherit', windowsHide: true, env: { ...process.env, PSModulePath: join(dirname(shell), 'Modules') } });
        child.on('error', reject); child.on('close', code => resolveResult(code ?? 2));
      });
    }
    const { main } = await import('./gidd.mjs');
    return await main([...args], { boundRepository: repository });
  } catch (error) {
    console.error('GIDD repository entry failed. Check the target or rerun gidd.tools.ensure.cmd --repository with the target directory.');
    console.log(JSON.stringify({ schema, status: 'error', reason: reasonOf(error) }));
    return 2;
  }
}
