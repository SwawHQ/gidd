import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Inherited stdio keeps bytes, terminal semantics, EOF and large output intact.
// Browser authorization can wait for the user; callers own any deadline.
export function runAttachedCommand(executable, args, { cwd, env, signal, timeoutMs = 0, stdio = 'inherit' } = {}) {
  if (!isAbsolute(executable) || (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe'))) {
    throw new Error('absolute_binary_required');
  }
  if (signal?.aborted) return Promise.resolve(130);
  return new Promise((resolve, reject) => {
    let timer, timedOut = false;
    const child = spawn(executable, args, { cwd, env, stdio, shell: false, windowsHide: true });
    const cancel = () => {
      if (process.platform !== 'win32' || !child.pid) { child.kill('SIGTERM'); return; }
      // Windows does not propagate a Unix signal to the process tree. Stop the
      // launched command and its helpers together when this invocation cancels.
      const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => child.kill('SIGTERM'));
      killer.once('exit', code => { if (code) child.kill('SIGTERM'); });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (timeoutMs) timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write('GIDD: execution timed out; stopping the command tree.\n');
      cancel();
    }, timeoutMs);
    if (signal?.aborted) cancel();
    child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new Error('process_start_failed')); });
    child.once('close', (code, terminated) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(timedOut ? 124 : signal?.aborted ? 130 : code ?? 128 + (constants.signals[terminated] || 1));
    });
  });
}
