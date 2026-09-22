import { fileURLToPath } from 'node:url';
import { withoutEnvironment, gitConfigurationEnvironment } from './execution-env.mjs';

const shellQuote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
const helper = name => fileURLToPath(new URL(name, import.meta.url));
const gitQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const globalValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

function gitGlobals(args, source = {}) {
  let index = 0;
  const parameters = [];
  while (index < args.length && args[index].startsWith('-')) {
    const option = args[index++];
    if (option === '--') break;
    const value = globalValues.has(option) ? args[index++] : option.startsWith('-c') && !option.startsWith('--') ? option.slice(2)
      : option.startsWith('--config-env=') ? option.slice('--config-env='.length) : undefined;
    if (value === undefined) continue;
    if (option === '-c' || option.startsWith('-c') && !option.startsWith('--')) parameters.push(gitQuote(value));
    if (option === '--config-env' || option.startsWith('--config-env=')) {
      const equal = value.indexOf('=');
      const configured = source[value.slice(equal + 1).toUpperCase()];
      if (equal > 0 && configured !== undefined) parameters.push(gitQuote(value.slice(0, equal) + '=' + configured));
    }
  }
  return { index, parameters };
}

export function noninteractiveEnvironment(git, env, gitArgs = []) {
  const source = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  const editor = [process.execPath, helper('reject-interaction.mjs')].map(shellQuote).join(' ');
  const ssh = shellQuote(helper('noninteractive-ssh.sh'));
  // An alias/extension may invoke another repository wrapper. Keep the original
  // transport rather than recursively wrapping our own SSH helper.
  const nested = source.GIDD_SSH_WRAPPER && source.GIT_SSH_COMMAND === source.GIDD_SSH_WRAPPER;
  // Git deliberately removes its local config environment before starting SSH.
  // Retain the ordered command configuration privately for the helper's config
  // reads, including -c / --config-env, while it resolves files in transport cwd.
  const config = Array.from({ length: Number(source.GIT_CONFIG_COUNT || 0) }, (_, i) =>
    gitQuote(source['GIT_CONFIG_KEY_' + i] + '=' + source['GIT_CONFIG_VALUE_' + i]));
  config.push(source.GIT_CONFIG_PARAMETERS || '', ...gitGlobals(gitArgs, source).parameters);
  const overrides = {
    GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GIT_PAGER: 'cat', NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: '0',
    GIT_EDITOR: editor, GIT_SEQUENCE_EDITOR: editor, GH_EDITOR: editor,
    // AskPass accepts a program path, not an editor-style command with arguments.
    GIT_ASKPASS: helper('reject-interaction.sh'), SSH_ASKPASS: helper('reject-interaction.sh'), SSH_ASKPASS_REQUIRE: 'never',
    // Git for Windows has a separate retry confirmation when a file is locked.
    GIT_ASK_YESNO: helper('reject-confirmation.sh'),
    GIDD_BOUND_GIT: git.replaceAll('\\', '/'),
    GIDD_SSH_CONFIG_PARAMETERS: config.filter(Boolean).join(' '),
    GIDD_SSH_COMMAND: (nested ? source.GIDD_SSH_COMMAND : source.GIT_SSH_COMMAND) || '',
    GIDD_SSH_PROGRAM: ((nested ? source.GIDD_SSH_PROGRAM : source.GIT_SSH) || '').replaceAll('\\', '/'),
    ...(source.GIT_SSH_VARIANT !== undefined ? { GIT_SSH_VARIANT: source.GIT_SSH_VARIANT } : {}),
    GIDD_SSH_WRAPPER: ssh, GIT_SSH_COMMAND: ssh,
  };
  return gitConfigurationEnvironment({ ...withoutEnvironment(env, [...Object.keys(overrides), 'GH_FORCE_TTY']), ...overrides },
    [['credential.interactive', 'false']]);
}

export function executionTimeout(env) {
  const value = Object.entries(env).find(([key]) => key.toUpperCase() === 'GIDD_EXEC_TIMEOUT_MS')?.[1];
  if (value === undefined || value === '') return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) {
    throw new Error('invalid_execution_timeout');
  }
  return Number(value);
}

// Only inspect native options whose purpose is to request interaction. Do not
// scan message bodies, config values or pathspecs for option-looking strings.
export function rejectInteractiveArguments(tool, args) {
  if (tool !== 'git') return;
  let i = gitGlobals(args).index;
  const command = args[i++];
  if (['mergetool', 'difftool', 'gui', 'citool'].includes(command)) throw new Error('interactive_command_disabled');
  const modes = {
    add: ['interactive', 'patch'], clean: ['interactive'], commit: ['interactive', 'patch'],
    checkout: ['patch'], restore: ['patch'], reset: ['patch'], stash: ['patch'],
  }[command];
  if (!modes) return;
  const values = new Set(['--pathspec-from-file', ...({
    commit: ['-m', '--message', '-F', '--file', '-C', '-c', '--reuse-message', '--reedit-message',
      '--author', '--date', '-t', '--template', '--fixup', '--squash', '--trailer'],
    checkout: ['-b', '-B', '--orphan', '--conflict'], restore: ['-s', '--source', '--conflict'],
    stash: ['-m', '--message'], clean: ['-e', '--exclude'],
  }[command] || [])]);
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0];
      if (name && modes.some(mode => mode.startsWith(name))) throw new Error('interactive_command_disabled');
    }
    if (values.has(arg) || arg.startsWith('--') && !arg.includes('=') && [...values].filter(value => value.startsWith(arg)).length === 1) { i++; continue; }
    if (/^-[^-]/.test(arg)) {
      // Short flags may be combined; options with attached values consume the
      // rest of the token. In particular, commit -m"patch" is not commit -p.
      for (let offset = 1; offset < arg.length; offset++) {
        const flag = arg[offset];
        if (values.has('-' + flag)) {
          if (offset === arg.length - 1) i++;
          break;
        }
        if (flag === 'p' && modes.includes('patch') || flag === 'i' && command !== 'commit' && modes.includes('interactive')) {
          throw new Error('interactive_command_disabled');
        }
      }
    }
  }
}
