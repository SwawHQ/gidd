import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readConfiguration, githubTarget, validateRemoteSettings } from './config.mjs';
import { validateGitSettings } from './git-settings.mjs';
import { boundTools } from './bindings.mjs';
import { toolsRoot } from './storage.mjs';
import { gitEnvironment, githubEnvironment, selectGitHubAccount, withoutEnvironment } from './execution-env.mjs';

// Inherited stdio keeps bytes, terminal semantics, EOF and large output intact.
// Business commands have no diagnostic deadline or output-size cap.
export function runPassthrough(executable, args, { cwd, env, signal, stdio = 'inherit' } = {}) {
  if (!isAbsolute(executable) || (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe'))) {
    throw new Error('absolute_binary_required');
  }
  if (signal?.aborted) return Promise.resolve(130);
  return new Promise((resolve, reject) => {
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
    if (signal?.aborted) cancel();
    child.once('error', () => { signal?.removeEventListener('abort', cancel); reject(new Error('process_start_failed')); });
    child.once('close', (code, terminated) => {
      signal?.removeEventListener('abort', cancel);
      resolve(signal?.aborted ? 130 : code ?? 128 + (constants.signals[terminated] || 1));
    });
  });
}

export async function passthrough(repository, tool, args, { signal } = {}) {
  if (signal?.aborted) return 130;
  const settings = readConfiguration(repository);
  validateGitSettings(settings.git);
  const needsGh = tool === 'gh' || settings.git.credential.mode === 'gh';
  const bindings = boundTools(toolsRoot(), needsGh ? ['git', 'gh'] : ['git']);
  let target;
  if (needsGh) {
    validateRemoteSettings(settings.repo.remote, ['url', 'account']);
    target = githubTarget(settings.repo.remote);
  }
  // The entry chooses the initial worktree. Explicit Git location arguments
  // still work normally, as do all gh target arguments and native overrides.
  let env = withoutEnvironment(process.env, ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GH_PROMPT_DISABLED', 'GH_PAGER', 'GH_FORCE_TTY', 'NO_COLOR', 'GIT_TERMINAL_PROMPT']);
  env = { ...env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' };
  if (needsGh) env = githubEnvironment(target, env);
  env = gitEnvironment(settings.git, bindings, target, env);
  if (tool === 'gh') {
    try { env = (await selectGitHubAccount({ gh: bindings.gh.path, ...target }, { env, cwd: repository, signal })).env; }
    catch (error) { if (signal?.aborted) return 130; throw error; }
  }
  return runPassthrough(bindings[tool].path, args, { cwd: repository, env, signal });
}
