import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { configure, configurationHint, readAuthorizationConfiguration } from './config.mjs';
import { doctor } from './doctor.mjs';
import { authorize } from './auth.mjs';
import { toolsRoot } from './storage.mjs';
import { boundTools, boundExecutor } from './bindings.mjs';
import { parseSpecArguments, specCommand, specError } from './spec.mjs';
import { passthrough } from './passthrough.mjs';

function printHelp(requestedLanguage) {
  const choice = requestedLanguage || process.env.GIDD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  if ((requestedLanguage || process.env.GIDD_LANG) && !/^(zh|en)(?:$|[-_])/.test(choice)) throw new Error('unsupported_help_language');
  const language = /^zh(?:$|[-_])/.test(choice) ? 'zh-CN' : 'en';
  console.log(readFileSync(new URL(`../references/gidd.link.help.${language}.md`, import.meta.url), 'utf8'));
}

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
      const controller = new AbortController(), cancel = () => controller.abort();
      process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
      try { return await passthrough(boundRepository, command.slice(1), args, { signal: controller.signal }); }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
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
    if (command === 'spec') {
      const result = await specCommand(repository, specOptions);
      if (result.markdown !== undefined) process.stdout.write(result.markdown);
      else console.log(JSON.stringify(result.report, null, 2));
      return result.exitCode;
    }
    let report;
    if (command === 'doctor') report = await doctor(repository, { offline, fixedRepository: true });
    else if (configurationCommand) report = configure(repository,command === 'set.show' ? 'show' : command,key,value);
    else {
      const github = readAuthorizationConfiguration(repository);
      const { gh } = boundTools(toolsRoot(), ['gh']);
      const execute = boundExecutor({ gh });
      const options = { repository, ...github, gh: gh.path };
      const controller = new AbortController(), cancel = () => controller.abort();
      process.on('SIGINT',cancel); process.on('SIGTERM',cancel);
      try { report = await authorize(options,{ execute, signal: controller.signal, onEvent: event => console.error(JSON.stringify(event)) }); }
      finally { process.removeListener('SIGINT',cancel); process.removeListener('SIGTERM',cancel); }
    }
    console.log(JSON.stringify(report));
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
    console.log(JSON.stringify({ schema, status: 'error', reason }));
    return 2;
  }
}
