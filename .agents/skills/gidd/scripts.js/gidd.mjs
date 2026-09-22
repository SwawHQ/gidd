import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { configurationHint } from './shared/config.mjs';
import { doctor } from './commands/doctor/index.mjs';
import { auth } from './commands/gh/auth.mjs';
import { parseSpecArguments, runSpec, specError } from './commands/spec/index.mjs';
import { git } from './commands/git/index.mjs';
import { gh } from './commands/gh/index.mjs';
import { printHelp } from './commands/help.mjs';
import { set } from './commands/set/index.mjs';
import { show } from './commands/set/show.mjs';
import { clear } from './commands/clear.mjs';

// Keep validation order, output channels and exit codes at the CLI boundary.
export async function main(args, { boundRepository } = {}) {
  const route = (args.shift() || 'help').toLowerCase();
  const command = route.startsWith('spec.') ? 'spec' : route;
  const configurationCommand = ['set.show', 'set', 'clear'].includes(command);
  const schemas = { 'set.show': 'gidd.config/v1', set: 'gidd.config/v1', clear: 'gidd.config/v1', doctor: 'gidd.doctor/v1', '.gh.auth': 'gidd.auth/v1', spec: 'gidd.spec/v1' };
  let schema = 'gidd.cli/v1';
  try {
    if (['help','--help','-h'].includes(command)) {
      if (args.length > 1) throw new Error('invalid_arguments');
      printHelp(args[0]); return 0;
    }
    if (command === 'set' && args.length === 0) {
      printHelp(); return 0;
    }
    if (['.gh', '.git'].includes(command)) {
      if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('unsupported_platform');
      if (!boundRepository) throw new Error('repository_binding_required');
      return await (command === '.git' ? git : gh)(boundRepository, args);
    }
    if (!Object.hasOwn(schemas,command)) throw new Error('unknown_command');
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('unsupported_platform');
    let key, value, specOptions;
    if (command === 'spec') {
      schema = schemas.spec;
      specOptions = parseSpecArguments(route, args);
      args = [];
    }
    if (configurationCommand) {
      if (command !== 'set.show') { key = args.shift(); if (key === undefined) throw new Error('invalid_arguments'); }
      if (command === 'set') { value = args.shift(); if (value === undefined) throw new Error('invalid_arguments'); }
    }
    if (command === '.gh.auth' && args.some(arg => ['--hostname','--account','--remote'].includes(arg) || !arg.startsWith('--') && args.indexOf(arg) === 0)) throw new Error('github_parameters_moved_to_config');
    let offline = false;
    if (command === 'doctor') {
      const flags = args.filter(arg => arg === '--offline');
      if (flags.length > 1) throw new Error('invalid_arguments');
      offline = flags.length === 1;
      args = args.filter(arg => arg !== '--offline');
    }
    if (args.length) throw new Error('invalid_arguments');
    if (!boundRepository) throw new Error('repository_binding_required');
    const repository = boundRepository;
    if (!isAbsolute(repository)) throw new Error('repository_must_be_absolute');
    if (!['doctor', '.gh.auth'].includes(command) && !existsSync(resolve(repository, '.git'))) throw new Error('not_git_repository_root');
    schema = schemas[command];
    if (command === 'spec') return await runSpec(repository, specOptions);
    let report;
    if (command === 'doctor') report = await doctor(repository, { offline, fixedRepository: true });
    else if (command === 'set') report = set(repository, key, value);
    else if (command === 'set.show') report = show(repository);
    else if (command === 'clear') report = clear(repository, key);
    else report = await auth(repository);
    if (command === 'set.show') process.stdout.write(report.content);
    else console.log(JSON.stringify(report));
    return ['ready','local_ready','checks_passed','checks_incomplete'].includes(report.status) ? 0 : 1;
  } catch (error) {
    const reason = /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : 'operation_failed';
    if (command === 'spec') {
      console.log(JSON.stringify(specError(boundRepository, undefined, reason), null, 2));
      return 2;
    }
    if (reason.startsWith('tool_binding')) console.error('Run gidd.pre.ensure.cmd --repo with the target directory to prepare tools and rebuild bindings.');
    const hint = configurationHint(reason); if (hint) console.error(hint);
    if (['.gh', '.git'].includes(command)) {
      console.error(JSON.stringify({ schema: 'gidd.exec/v1', status: 'error', reason }));
      return 2;
    }
    const errorReport = JSON.stringify({ schema, status: 'error', reason });
    if (command === 'set.show') console.error(errorReport);
    else console.log(errorReport);
    return 2;
  }
}
