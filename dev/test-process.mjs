import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
let executable, ownedDirectory;
const running = new Set();
const wait = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

// Both test runners and synchronous fixture commands share this Windows owner.
// The owner holds a job before resuming the command and waits for all its helpers.
export function testProcessExecutable() {
  if (executable) return executable;
  if (process.env.GIDD_TEST_PROCESS_EXECUTABLE) return executable = process.env.GIDD_TEST_PROCESS_EXECUTABLE;
  ownedDirectory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gidd-test-process-')));
  const destination = join(ownedDirectory, 'owner.exe');
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(directory, 'compile-test-process.ps1'), join(directory, 'test-process.cs'), destination],
  { windowsHide: true, encoding: 'utf8', timeout: 20000, env: { ...process.env, PSModuleAnalysisCachePath: 'NUL' } });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
  return executable = destination;
}

const quote = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
function invocation(command, args, options) {
  const owner = testProcessExecutable(), control = join(dirname(owner), randomUUID());
  return { owner, control, args: [command, args.map(options.windowsVerbatimArguments ? String : quote).join(' '),
    String(options.timeout ?? 20000), control],
  options: { windowsHide: true, ...options, timeout: undefined, windowsVerbatimArguments: false } };
}
function finish(control, result) {
  let error = result.error;
  // Bun truncates Windows exit codes returned by node:child_process.
  const status = existsSync(control + '.exit') ? Number(readFileSync(control + '.exit', 'utf8')) : result.status;
  if (existsSync(control + '.timeout')) error = Object.assign(new Error('Test command timed out'), { code: 'ETIMEDOUT' });
  if (existsSync(control + '.error')) {
    const code = readFileSync(control + '.error', 'utf8');
    error = Object.assign(new Error(`Test process start failed: ${code}`), { code: code === '2' || code === '3' ? 'ENOENT' : 'EIO' });
  }
  for (const suffix of ['.cancel', '.timeout', '.error', '.exit']) rmSync(control + suffix, { force: true });
  return { ...result, status, error };
}
export function runTestProcess(command, args, options = {}) {
  const call = invocation(command, args, options);
  return finish(call.control, spawnSync(call.owner, call.args, call.options));
}
export function startTestProcess(command, args, options = {}) {
  const call = invocation(command, args, options), child = spawn(call.owner, call.args, call.options);
  let error;
  const handle = { child, stop: () => { if (running.has(handle)) writeFileSync(call.control + '.cancel', 'cancel'); } };
  running.add(handle);
  handle.result = new Promise((resolveResult, reject) => {
    child.once('error', value => { error = value; });
    child.once('close', (status, signal) => {
      running.delete(handle);
      const result = finish(call.control, { status, signal, error });
      if (result.error) reject(result.error); else resolveResult(result);
    });
  });
  // Cleanup may be called after a failed assertion before the result was awaited.
  handle.result.catch(() => {});
  handle.stopSync = () => {
    if (!running.has(handle)) return;
    handle.stop();
    const deadline = Date.now() + 10000;
    while (child.pid) {
      try { process.kill(child.pid, 0); } catch { break; }
      if (Date.now() > deadline) throw new Error(`Test worker did not stop: ${child.pid}`);
      wait(20);
    }
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
  };
  return handle;
}
export async function disposeTestProcesses() {
  const active = [...running];
  for (const handle of active) handle.stop();
  await Promise.allSettled(active.map(handle => handle.result));
  if (ownedDirectory) {
    const temp = realpathSync.native(tmpdir()), path = resolve(ownedDirectory);
    if (!path.startsWith(temp + sep) || !/^gidd-test-process-/.test(path.slice(path.lastIndexOf(sep) + 1)))
      throw new Error(`Unsafe test cleanup path: ${path}`);
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    ownedDirectory = executable = undefined;
  }
}
