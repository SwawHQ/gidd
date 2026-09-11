import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

// One deadline covers process exit AND pipe EOF (including inherited pipes).
// Arbitrary command diagnostics can contain tokens or credential-bearing URLs.
export function runCommand(executable, args, { cwd, timeoutMs = 15000, env = process.env, signal, onStderrLine } = {}) {
  if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'cancelled', text: '' });
  const overrides = {
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '', GH_PROMPT_DISABLED: '1', GH_PAGER: '', GH_DEBUG: '', GH_FORCE_TTY: '', NO_COLOR: '1',
  };
  const omitted = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_CEILING_DIRECTORIES', ...Object.keys(overrides)]);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !omitted.has(key.toUpperCase())));
  return new Promise(resolveResult => {
    let child, timer, cleanupTimer, done = false, exited = false, text = '', bytes = 0, failure, stderrLine = '';
    const detach = () => {
      if (done) return;
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
      finish(false, failure);
    };
    const cancel = () => abort('cancelled');
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', cancel);
      resolveResult({ ok, reason, text: ok ? text.trim() : '' });
    };
    const stop = reason => {
      // Drain until close after killing an overproducing process. Destroying its
      // active pipe inside a data callback corrupts Bun 1.2.15's pipe lifecycle.
      failure ||= reason;
      child?.kill();
    };
    const abort = reason => {
      stop(reason);
      // Wait for termination before closing active pipes (Bun 1.2.15). An
      // exited parent's inherited pipes can be closed immediately. Bound the
      // kill acknowledgement too, in case the runtime never delivers exit.
      if (exited) detach();
      else cleanupTimer ||= setTimeout(detach, 500);
    };
    try {
      child = spawn(executable, args, { cwd, env: { ...childEnv, ...overrides },
        windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.end();
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => abort('process_timeout'), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) stop('output_limit'); else text += chunk;
      });
      child.stderr.setEncoding('utf8');
      const deliver = line => {
        try { if (onStderrLine?.(line) === false) stop('output_rejected'); }
        catch { stop('output_rejected'); }
      };
      child.stderr.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) stop('output_limit');
        else if (onStderrLine && !failure) {
          stderrLine += chunk;
          const lines = stderrLine.split(/\r?\n/);
          stderrLine = lines.pop();
          for (const line of lines) { if (!failure) deliver(line); }
        }
      });
      child.on('error', () => finish(false, 'process_start_failed'));
      child.on('exit', () => { exited = true; if (failure) setImmediate(detach); });
      child.on('close', code => {
        if (!done && !failure && stderrLine) deliver(stderrLine);
        finish(!failure && code === 0, failure || (code === 0 ? 'process_exit' : 'command_failed'));
      });
    } catch { finish(false, 'process_start_failed'); }
  });
}

export function validateOptions(options) {
  if (!options.repository || !isAbsolute(options.repository)) throw new Error('repository_must_be_absolute');
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(options.hostname)) throw new Error('invalid_hostname');
  if (options.account && !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(options.account)) throw new Error('invalid_account');
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(options.remote)) throw new Error('invalid_remote_name');
  for (const name of ['git', 'gh']) {
    if (options[name] && (!isAbsolute(options[name]) || (process.platform === 'win32' && !options[name].toLowerCase().endsWith('.exe')))) {
      throw new Error(`${name}_must_be_absolute_executable`);
    }
  }
}

export async function checkGitHubIdentity({ gh, hostname, account }, execute = runCommand) {
  const result = await execute(gh, ['api', '--hostname', hostname, '--method', 'GET', 'user', '--jq', '.login']);
  if (!result.ok) return { status: 'failed', reason: result.reason };
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(result.text)) return { status: 'failed', reason: 'invalid_api_response' };
  const matches = result.text.toLowerCase() === account.toLowerCase();
  return { status: matches ? 'ready' : 'mismatch', reason: matches ? 'identity_verified' : 'unexpected_account',
    details: { hostname: hostname.toLowerCase(), login: result.text, expected_account: account } };
}
