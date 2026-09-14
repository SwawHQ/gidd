// Test adapters call the native implementation, never a second JS generator.
import { adapter, code, join, json, run } from './helpers.mjs';

function invoke(operation, repository, entry = join(code,'../gidd.mjs')) {
  const result = adapter(repository,{action:'repository',operation,repositoryRoot:repository,entry,runtime:process.versions.bun?'bun':'node'});
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return json(result);
}
export const assertInstallationRepository = (repository,entry) => invoke('assert',repository,entry);
export const checkRepositoryLink = (repository,entry) => invoke('check',repository,entry);
export const publishRepositoryEntry = (repository,entry) => invoke('publish',repository,entry);

const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
export function runRepositoryCommand(repository, args, options = {}) {
  const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
  const entry = join(repository, '.agents/skills/gidd/gidd.link.cmd');
  return run(cmd, ['/d','/s','/c', `""${entry}" ${args.map(quote).join(' ')}"`], {
    ...options, windowsVerbatimArguments: true,
  });
}
