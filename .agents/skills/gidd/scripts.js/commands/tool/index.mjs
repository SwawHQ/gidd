import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { runAttachedCommand } from '../../shared/attached-process.mjs';
import { withoutEnvironment } from '../../shared/execution-env.mjs';
import { parseList } from '../../shared/git-worktrees.mjs';
import { skillPath } from '../../shared/paths.mjs';
import { withSignals } from '../../shared/signals.mjs';
import { managedExecutable, readConfigurationText, toolsRoot } from '../../shared/storage.mjs';
import { toolEnvironment } from '../../shared/tools.mjs';

export const toolNames = ['git', 'gh', 'bun', 'node'];

// Read the selected executable from a generated launcher; never evaluate batch text.
function launcherPath(root, text, key, name) {
  const matches = [...text.matchAll(new RegExp('^set "' + key + '=([^"\\r\\n]+)"\\r?$', 'gm'))];
  if (!matches.length && key === 'GIDD_GH_GIT') return undefined;
  if (matches.length !== 1) throw new Error('tool_launcher_invalid:' + name);
  const encoded = matches[0][1], prefix = '%~dp0';
  let path;
  if (encoded.startsWith(prefix)) {
    const relative = encoded.slice(prefix.length).replaceAll('\\', '/');
    if (relative !== name + '/' + managedExecutable(name) &&
        !new RegExp('^\\.runtime-path-[a-f0-9]{64}/' + name + '\\.exe$').test(relative)) {
      throw new Error('tool_launcher_invalid:' + name);
    }
    path = resolve(root, relative);
  } else path = encoded.replaceAll('%%', '%');
  if (!isAbsolute(path) || !path.toLowerCase().endsWith('.exe')) throw new Error('tool_launcher_invalid:' + name);
  return path;
}

function readLauncher(tool) {
  const root = toolsRoot();
  let text;
  try { text = readConfigurationText(join(root, tool + '.link.cmd')); }
  catch (error) { throw new Error((error.code === 'ENOENT' ? 'tool_launcher_missing:' : 'tool_launcher_invalid:') + tool); }
  return { executable: launcherPath(root, text, 'GIDD_JS_EXEC', tool),
    git: tool === 'gh' ? launcherPath(root, text, 'GIDD_GH_GIT', 'git') : undefined };
}

function ghEnvironment(git) {
  let env = toolEnvironment(git);
  if (Object.entries(env).some(([key, value]) => key.toUpperCase() === 'GH_CONFIG_DIR' && value)) return env;
  try {
    // Match gh.link.cmd discovery, including the caller's Git environment.
    const result = spawnSync(git, ['worktree', 'list', '--porcelain', '-z'], {
      env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    });
    const main = result.status === 0 ? parseList(result.stdout)[0] : undefined;
    if (main?.path && !main.bare) {
      const profile = join(main.path + '.gidd', 'gh');
      if (statSync(profile, { throwIfNoEntry: false })?.isDirectory()) {
        env = { ...withoutEnvironment(env, ['GH_CONFIG_DIR']), GH_CONFIG_DIR: profile };
      }
    }
  } catch { /* Optional discovery keeps gh defaults outside a readable worktree. */ }
  return env;
}

export async function runTool(tool, args) {
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('unsupported_platform');
    return await withSignals(signal => {
      const { executable, git } = readLauncher(tool);
      return runAttachedCommand(executable, args, { signal, env: git ? ghEnvironment(git) : process.env });
    });
  } catch (error) {
    const reason = /^(?:tool_launcher_(?:missing|invalid):(?:git|gh|bun|node)|unsupported_platform|process_start_failed)$/.test(error.message)
      ? error.message : 'tool_launcher_failed';
    const repairTool = /^tool_launcher_(?:missing|invalid):(git|gh|bun|node)$/.exec(reason)?.[1] || tool;
    console.error('GIDD: ' + reason + '. Run tools.ensure.cmd ' + repairTool + ' to repair it.');
    if (['node', 'bun'].includes(tool)) {
      await runAttachedCommand(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', skillPath('scripts.powershell/tool-runtime.ps1'), '-Unavailable', tool],
        { stdio: ['ignore', 'ignore', 'inherit'], timeoutMs: 12000 }).catch(() => {});
    }
    return 2;
  }
}
