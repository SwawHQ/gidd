import { join, run } from './helpers.mjs';

const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
export function runRepositoryCommand(repository, args, options = {}) {
  const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
  const { entry = join(repository, '.agents/skills/gidd/gidd.cmd'), ...settings } = options;
  return run(cmd, ['/d','/s','/c', `""%GIDD_TEST_ENTRY%" ${args.map(quote).join(' ')}"`], {
    cwd: repository, ...settings, env: { ...settings.env, GIDD_TEST_ENTRY: entry }, windowsVerbatimArguments: true,
  });
}
