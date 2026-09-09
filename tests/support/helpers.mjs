import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('../../', import.meta.url));
export const code = join(repo, '.agents/skills/gidd/scripts/windows');
export const support = join(repo, 'tests/support');
export function copySkill(destination) {
  const source = join(repo, '.agents/skills/gidd');
  const config = join(source, 'config.toml');
  // Repository settings and in-flight editor files are not part of the skill.
  cpSync(source, destination, { recursive: true,
    filter: path => path !== config && !path.startsWith(config + '.'),
  });
}
const windowsRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
export const shell = join(windowsRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
export function environment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(path|psmodulepath|git_dir|git_work_tree|git_index_file|git_common_dir|git_ceiling_directories)$/i.test(key) ||
        Object.keys(overrides).some(name => name.toLowerCase() === key.toLowerCase())) delete env[key];
  }
  // An isolated USERPROFILE can make Windows PowerShell's cache path relative.
  // Disable that cache so fixtures cannot leave Microsoft/ in the checkout.
  return { ...env, PATH: process.env.PATH ?? process.env.Path ?? '', PSModulePath: join(dirname(shell), 'Modules'), PSModuleAnalysisCachePath: 'NUL', ...overrides };
}
export function run(executable, args = [], options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, cwd: repo, ...options, env: environment(options.env) });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
export function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}
export function json(result) { return JSON.parse(result.stdout); }
export function ps(script, args = [], options = {}) {
  const bytes = readFileSync(script);
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf', `PowerShell BOM: ${script}`);
  return run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], options);
}
export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gidd-js-')));
  // Disable Bun's own cache writes when testing read-only GIDD operations.
  const isolated = { USERPROFILE: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  const previous = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
  // Supply the ordinary empty profile directories before taking read-only snapshots.
  mkdirSync(join(root, 'AppData/Roaming'), { recursive: true });
  // Tests run serially within each worker; every subprocess gets this private home.
  Object.assign(process.env, isolated);
  return { root, dispose() {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const full = resolve(root);
    assert.ok(full.startsWith(realpathSync(tmpdir()) + sep) && /^gidd-js-/.test(full.slice(full.lastIndexOf(sep) + 1)));
    // fs.rm removes junctions/symlinks themselves, without traversing their targets.
    rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}
export function toolsRoot(home) { return join(home, '.agents/skills.tools/gidd'); }
export function write(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
export function hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function request(root, spec) {
  const path = join(root, `${randomUUID()}.request.json`);
  write(path, JSON.stringify({ codeRoot: code, ...spec }));
  return path;
}
export function adapter(root, spec, options) {
  const path = request(root, spec);
  try { return ps(join(support, 'windows.ps1'), ['-RequestPath', path], options); }
  finally { rmSync(path, { force: true }); }
}
export function product(args, options) { return run(process.execPath, [join(code,'../gidd.mjs'),...args], options); }
export function diagnosis(target, options) { return run(process.execPath,[join(code,'../doctor.mjs'),target],options); }
export function jsAdapter(root, spec, options) {
  if (!['configuration','release','validate','find','stage','guide','install'].includes(spec.action)) return adapter(root,spec,options);
  const path = request(root,spec);
  try { return run(process.execPath,[join(support,'javascript.mjs'),path],options); }
  finally { rmSync(path,{ force: true }); }
}
export function startAdapter(root, spec, options = {}) {
  const path = request(root, spec);
  const executable = options.javascript ? process.execPath : shell;
  const arguments_ = options.javascript ? [join(support,'javascript.mjs'),path] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(support, 'windows.ps1'), '-RequestPath', path];
  const child = spawn(executable, arguments_,
    { cwd: repo, windowsHide: true, env: environment(options.env), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const result = new Promise((res, rej) => {
    const timer = setTimeout(() => { child.kill(); rej(new Error('Fixture worker timed out')); }, 15000);
    child.on('error', error => { clearTimeout(timer); rej(error); });
    child.on('close', status => { clearTimeout(timer); res({ status, stdout, stderr }); });
  });
  return { child, result, marker: path + '.locked' };
}
export async function until(predicate, timeout = 10000) {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < timeout, 'Timed out waiting for fixture');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
export function compile(root, source = 'tool.cs') {
  const exe = join(root, source.replace('.cs', '.exe'));
  ok(adapter(root, { action: 'compile', source: join(support, source), destination: exe }));
  return exe;
}
export function stub(source, destination, mode, managed = false) {
  mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
  if (mode !== undefined) write(destination + '.mode', mode);
  if (managed) {
    const dir = dirname(destination);
    const files = readdirSync(dir).filter(name => name !== 'install.json').map(name => ({ name, length: lstatSync(join(dir, name)).size, sha256: hash(join(dir, name)) }));
    const name = destination.endsWith('bun.exe') ? 'bun' : destination.endsWith('node.exe') ? 'node' : 'gh';
    write(join(dir, 'install.json'), JSON.stringify({ schema: 'gidd.install/v1', name, platform: 'windows-x64', version: name === 'node' ? '24.19.0' : name === 'gh' ? '2.98.0' : '1.4.2', archive_sha256: '0'.repeat(64), files }));
  }
}
export function snapshot(root) {
  const entries = [];
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), 'Snapshot fixtures must not contain links');
      entries.push([path, stat.isDirectory() ? 'directory' : hash(path)]);
      if (stat.isDirectory()) visit(path);
    }
  }
  visit(root); return entries;
}
export function findGit() {
  const result = ok(run(join(windowsRoot, 'System32/where.exe'), ['git.exe']));
  return result.stdout.trim().split(/\r?\n/)[0];
}
export function installSpec(root, definitionPath, fixtureDirectory = '', stopAt = '') {
  return { action: 'install', root, definitionPath, fixtureDirectory, stopAt };
}
export function makeZip(root, destination, entries) { ok(adapter(root, { action: 'zip', destination, entries })); }
export { assert, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, join, dirname, lstatSync };
