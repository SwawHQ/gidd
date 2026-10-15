import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach } from 'node:test';
import { initializeStorage, inspectStorage } from '../../.agents/skills/gidd/scripts.js/shared/managed-storage.mjs';
import { disposeTestProcesses, runTestProcess, startTestProcess } from '../../dev/test-process.mjs';

// An exit code of zero alone does not prove that a test worker reached its end.
// In particular, Node on this Windows host can terminate during native fixtures.
after(async () => {
  await disposeTestProcesses();
  if (process.env.GIDD_TEST_COMPLETION) writeFileSync(process.env.GIDD_TEST_COMPLETION, 'completed');
});

export const repo = fileURLToPath(new URL('../../', import.meta.url));
export const code = join(repo, '.agents/skills/gidd/scripts.powershell');
export const support = join(repo, 'tests/support');
export function copySkill(destination) {
  const source = join(repo, '.agents/skills/gidd');
  cpSync(source, destination, { recursive: true });
}
const windowsRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
const sharedNode = join(process.env.USERPROFILE, '.agents/skills.tools/gidd/node/node.exe');
export function bindNodeFixture(home) {
  const node = !process.versions.bun ? process.execPath : existsSync(sharedNode) ? sharedNode :
    ok(run(join(windowsRoot, 'System32/where.exe'), ['node.exe'])).stdout.trim().split(/\r?\n/)[0];
  const root = toolsRoot(home);
  stub(node, join(root, 'node/node.exe'));
  write(join(root, 'node.link.cmd'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "GIDD_JS_EXEC=%~dp0node\\node.exe"\r\n"%GIDD_JS_EXEC%" %*\r\nexit /b %ERRORLEVEL%\r\n');
  return node;
}
export function executionFailure(result) {
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '', 'Launcher and forwarding failures must leave stdout empty');
  const lines = result.stderr.trim().split(/\r?\n/);
  const match = /^GIDD: ([a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*)\.(?: .*)?$/.exec(lines[0]);
  assert.ok(match, result.stderr);
  assert.doesNotMatch(result.stderr, /"schema"|"status"|"reason"/);
  const facts = Object.fromEntries(lines.filter(line => line.startsWith('  ')).map(line => {
    const split = line.indexOf(': '); return [line.slice(2, split), line.slice(split + 2)];
  }));
  return { code: match[1], facts };
}
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
  const result = runTestProcess(executable, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, cwd: repo, ...options, env: environment(options.env) });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
export function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}
export function json(result) { return JSON.parse(result.stdout); }
export function ps(script, args = [], options = {}) {
  return run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], options);
}
const fixtures = new Map();
afterEach(() => {
  // Setup can fail before the caller reaches its try/finally.
  for (const fixture of [...fixtures.values()].reverse()) fixture.dispose();
});
export function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'gidd-js-')));
  // Disable Bun's own cache writes when testing read-only GIDD operations.
  const isolated = { USERPROFILE: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  const previous = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
  // Supply the ordinary empty profile directories before taking read-only snapshots.
  mkdirSync(join(root, 'AppData/Roaming'), { recursive: true });
  // Tests run serially within each worker; every subprocess gets this private home.
  Object.assign(process.env, isolated);
  const workers = new Set();
  const resource = { root, workers, dispose() {
    // Stop owned workers before restoring their profile or deleting their files.
    for (const worker of workers) worker.stopSync();
    fixtures.delete(root);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const full = resolve(root);
    assert.ok(full.startsWith(realpathSync.native(tmpdir()) + sep) && /^gidd-js-/.test(full.slice(full.lastIndexOf(sep) + 1)));
    // fs.rm removes junctions/symlinks themselves, without traversing their targets.
    // Doctor can own a sibling data directory with the same test-owned name.
    const failures = [];
    for (const path of [full, full + '.gidd']) {
      assert.ok(path.startsWith(realpathSync.native(tmpdir()) + sep));
      try { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (cause) { failures.push(new Error(`Test cleanup failed: ${path} (${cause.code || cause.message})`, { cause })); }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
  } };
  fixtures.set(root, resource);
  return resource;
}
export function toolsRoot(home) { return join(home, '.agents/skills.tools/gidd'); }
export function write(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
export function initializeDataFixture(repository) {
  const path = repository + '.gidd';
  initializeStorage(inspectStorage({ main: repository, common: join(repository, '.git'), path }));
}
export function hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function request(root, requestData) {
  const path = join(root, `${randomUUID()}.request.json`);
  write(path, JSON.stringify({ codeRoot: code, ...requestData }));
  return path;
}
export function adapter(root, requestData, options) {
  const path = request(root, requestData);
  try { return ps(join(support, 'windows.ps1'), ['-RequestPath', path], options); }
  finally { rmSync(path, { force: true }); }
}
// Test-only access to the native preparation stage; public preparation is bootstrap.
export function prepare(repository, name = 'gh', options = {}) {
  return adapter(repository,{action:'prepare',repositoryRoot:repository,names:[name]},options);
}
export function bindFixture(home, tools) {
  const bindings={schema:'gidd.tool-bindings/v1',platform:'windows-x64',tools:{}};
  for(const [name,path] of Object.entries(tools)) if(path) bindings.tools[name]={path,source:'path',version:ok(run(path,['--version'])).stdout.match(/\d+\.\d+\.\d+/)[0]};
  write(join(toolsRoot(home),'tool-bindings.json'),JSON.stringify(bindings));
}
export function diagnosis(target, options) { return run(process.execPath, [join(support,'doctor.mjs'),target],options); }
export function startAdapter(root, requestData, options = {}) {
  const path = request(root, requestData);
  const worker = startTestProcess(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(support, 'windows.ps1'), '-RequestPath', path],
    { cwd: repo, timeout: options.timeout ?? 15000, env: environment(options.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const { child } = worker, workers = fixtures.get(root)?.workers;
  workers?.add(worker);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const result = worker.result.then(value => ({ ...value, stdout, stderr })).finally(() => {
    workers?.delete(worker);
    rmSync(path, { force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(path + '.locked', { force: true, maxRetries: 5, retryDelay: 100 });
  });
  result.catch(() => {});
  return { child, result, stop: async () => { worker.stop(); return await result; }, marker: path + '.locked' };
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
export function installRequest(root, definitionPath, fixtureDirectory = '', stopAt = '') {
  return { action: 'install', root, definitionPath, fixtureDirectory, stopAt };
}
export function makeZip(root, destination, entries) { ok(adapter(root, { action: 'zip', destination, entries })); }
export { assert, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, join, dirname, lstatSync };

// Resource entries now share the owning repository manifest.
export function resourceText(data, id) {
  const value = JSON.parse(readFileSync(join(data, 'storage.json'), 'utf8')).worktrees[id];
  return typeof value === 'string' ? value : JSON.stringify(value);
}
export function writeResource(data, id, text) {
  const path = join(data, 'storage.json'), storage = JSON.parse(readFileSync(path, 'utf8'));
  if (text === undefined) delete storage.worktrees[id];
  else { try { storage.worktrees[id] = JSON.parse(text); } catch { storage.worktrees[id] = text; } }
  write(path, JSON.stringify(storage));
}
