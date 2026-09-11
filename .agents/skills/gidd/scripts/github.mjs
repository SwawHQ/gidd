import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurationHint, readGitHubConfiguration } from './config.mjs';

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

export async function checkIdentity(input, execute = runCommand, env = process.env) {
  const options = { hostname: 'github.com', account: '', remote: 'origin', ...input };
  validateOptions(options);
  const checks = [];
  const add = (id, status, reason, details = {}) => checks.push({ id, status, reason, details });
  const invoke = (name, args) => execute(options[name], args, { cwd: options.repository, env });
  if (!options.gh) add('github.api', 'missing', 'gh_unavailable');
  else {
    const result = await invoke('gh', ['api', '--hostname', options.hostname, '--method', 'GET', 'user', '--jq', '.login']);
    if (!result.ok) add('github.api', 'failed', result.reason);
    else if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(result.text)) add('github.api', 'failed', 'invalid_api_response');
    else {
      const matches = !options.account || result.text.toLowerCase() === options.account.toLowerCase();
      add('github.api', matches ? 'ready' : 'mismatch', matches ? 'identity_verified' : 'unexpected_account', {
        hostname: options.hostname.toLowerCase(), login: result.text, expected_account: options.account || null,
      });
    }
  }
  if (!options.git) {
    for (const id of ['repository', 'git.author', 'git.remote_read']) add(id, 'not_checked', 'git_unavailable');
  } else {
    const repository = await invoke('git', ['rev-parse', '--show-toplevel']);
    if (!repository.ok) {
      add('repository', 'failed', repository.reason);
      for (const id of ['git.author', 'git.remote_read']) add(id, 'not_checked', 'repository_unavailable');
    } else {
      add('repository', 'ready', 'worktree_found');
      const author = await invoke('git', ['var', 'GIT_AUTHOR_IDENT']);
      const match = author.ok && /^(.+) <([^<>\r\n]+)> \d+ [+-]\d{4}$/.exec(author.text);
      if (match) add('git.author', 'ready', 'effective_author', { name: match[1], email: match[2] });
      else add('git.author', 'failed', author.ok ? 'invalid_author_response' : author.reason);
      // --get-url applies insteadOf rewrites without contacting the remote.
      const remote = await invoke('git', ['ls-remote', '--get-url', options.remote]);
      let url;
      try {
        // WHATWG URL accepts forms such as https:host; Git may treat those as
        // SSH syntax. Only parse an explicit HTTPS URL without normalization.
        if (remote.ok && /^https:\/\//i.test(remote.text) && !/[\s\\]/.test(remote.text)) url = new URL(remote.text);
      } catch { /* SSH/local paths are deliberately not probed. */ }
      if (!remote.ok) add('git.remote_read', 'failed', remote.reason);
      else if (!url || url.protocol !== 'https:') add('git.remote_read', 'not_checked', 'https_remote_required');
      else if (url.hostname.toLowerCase() !== options.hostname.toLowerCase() || url.port || url.username || url.password || url.search || url.hash) {
        add('git.remote_read', 'not_checked', 'remote_host_or_url_not_eligible');
      } else {
        const result = await invoke('git', ['-c', 'credential.interactive=false', '-c', 'core.askPass=',
          'ls-remote', '--', options.remote, 'HEAD']);
        add('git.remote_read', result.ok ? 'ready' : 'failed', result.ok ? 'remote_readable' : result.reason,
          { remote: options.remote, hostname: url.hostname });
      }
    }
  }
  add('git.authentication', 'not_checked', 'remote_read_does_not_identify_user_or_prove_push_permission');
  const required = ['github.api', 'repository', 'git.author', 'git.remote_read'];
  return { schema: 'gidd.identity/v1', status: required.every(id => checks.some(c => c.id === id && c.status === 'ready')) ?
    'checks_passed' : 'needs_attention', checks };
}

async function main() {
  try {
    if (process.platform !== 'win32') throw new Error('unsupported_platform');
    const args = process.argv.slice(2), options = {};
    const names = new Set(['repository', 'git', 'gh']);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!args[i].startsWith('--') || !names.has(key) || key in options || !args[i + 1]) throw new Error('invalid_arguments');
      options[key] = args[i + 1];
    }
    const report = await checkIdentity({ ...options, ...readGitHubConfiguration(options.repository, ['hostname', 'account', 'remote']) });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'checks_passed' ? 0 : 1;
  } catch (error) {
    // Only validation errors from this module are public; never print process diagnostics.
    const reason = /^(?:config_[a-z_]+|repository_must_be_absolute|invalid_hostname|invalid_account|invalid_remote_name|(?:git|gh)_must_be_absolute_executable|unsupported_platform|invalid_arguments)$/.test(error.message) ? error.message : 'identity_check_failed';
    const hint = configurationHint(reason); if (hint) console.error(hint);
    console.log(JSON.stringify({ schema: 'gidd.identity/v1', status: 'error', reason }));
    process.exitCode = 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
