import { fileURLToPath } from 'node:url';
import { withoutEnvironment, gitConfigurationEnvironment } from './execution-env.mjs';

const shellQuote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
const helper = name => fileURLToPath(new URL(name, import.meta.url));
const gitQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const globalValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

// Retain command-level Git configuration for the SSH helper without filtering arguments.
function gitCommandParameters(args, source = {}) {
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
  return parameters;
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
  config.push(source.GIT_CONFIG_PARAMETERS || '', ...gitCommandParameters(gitArgs, source));
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
