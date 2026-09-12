import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure, configurationHint, readGitHubConfiguration } from './config.mjs';
import { doctor } from './doctor.mjs';
import { authorize } from './auth.mjs';
import { resolveStorage, repositoryRoot } from './storage.mjs';
import { boundTools, boundExecutor } from './bindings.mjs';

export async function main(args, { boundRepository } = {}) {
  let command = (args.shift() || 'help').toLowerCase();
  const schemas = { config: 'gidd.config/v1', doctor: 'gidd.doctor/v1', auth: 'gidd.auth/v1' };
  let schema = 'gidd.cli/v1';
  try {
    if (['help','--help','-h'].includes(command)) {
      if (args.length > 1) throw new Error('invalid_arguments');
      const choice = args[0] || process.env.GIDD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
      if ((args[0] || process.env.GIDD_LANG) && !/^(zh|en)(?:$|[-_])/.test(choice)) throw new Error('unsupported_help_language');
      const language = /^zh(?:$|[-_])/.test(choice) ? 'zh-CN' : 'en';
      console.log(readFileSync(new URL(`./help/${language}.txt`,import.meta.url),'utf8')); return 0;
    }
    if (!Object.hasOwn(schemas,command)) throw new Error('unknown_command');
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('unsupported_platform');
    let action, key, value;
    if (command === 'config') {
      action = args.shift(); if (!['show','set'].includes(action)) throw new Error('invalid_arguments');
      if (action === 'set') { key = args.shift(); value = args.shift(); if (value === undefined) throw new Error('invalid_arguments'); }
    }
    if (command === 'auth' && args.some(arg => ['--hostname','--account','--remote'].includes(arg) || !arg.startsWith('--') && args.indexOf(arg) === 0)) throw new Error('github_parameters_moved_to_config');
    let offline = false;
    if (command === 'doctor') {
      const flags = args.filter(arg => arg === '--offline');
      if (flags.length > 1) throw new Error('invalid_arguments');
      offline = flags.length === 1;
      args = args.filter(arg => arg !== '--offline');
    }
    let repository;
    if (boundRepository) {
      if (args.length) throw new Error('invalid_arguments');
      repository = boundRepository;
      if (!existsSync(resolve(repository, '.git'))) throw new Error('not_git_repository_root');
    } else if (args.length) {
      if (args.length !== 2 || args[0] !== '--repository' || !args[1]) throw new Error('invalid_arguments');
      repository = args[1];
    } else {
      const scripts = dirname(fileURLToPath(import.meta.url));
      repository = resolve(scripts, '../../../..');
      if (resolve(repository, '.agents/skills/gidd/scripts').toLowerCase() !== scripts.toLowerCase() || !existsSync(resolve(repository,'.git'))) {
        if (command !== 'doctor') throw new Error('repository_required_for_unbound_entry');
        repository = undefined;
      }
    }
    if (repository !== undefined && !isAbsolute(repository)) throw new Error('repository_must_be_absolute');
    if (command !== 'doctor' && !boundRepository) repository = repositoryRoot(repository);
    schema = schemas[command];
    let report;
    if (command === 'doctor') report = await doctor(repository, { offline });
    else if (command === 'config') report = configure(repository,action,key,value);
    else {
      const storage = resolveStorage(repository,{inspect:false});
      const github = readGitHubConfiguration(repository,['hostname','account']);
      const bindings = boundTools(storage.tools_root,['gh']);
      const execute = boundExecutor(bindings);
      const options = { repository, ...github, gh:bindings.gh?.path, git:bindings.git?.path };
      const controller = new AbortController(), cancel = () => controller.abort();
      process.on('SIGINT',cancel); process.on('SIGTERM',cancel);
      try { report = await authorize(options,{ execute, signal: controller.signal, onEvent: event => console.error(JSON.stringify(event)) }); }
      finally { process.removeListener('SIGINT',cancel); process.removeListener('SIGTERM',cancel); }
    }
    console.log(JSON.stringify(report));
    return ['ready','local_ready','checks_passed'].includes(report.status) ? 0 : 1;
  } catch (error) {
    const reason = /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : 'operation_failed';
    if (reason.startsWith('tool_binding')) console.error('Run gidd.pre.ensure.cmd --repo with the target directory to prepare tools and rebuild bindings.');
    const hint = configurationHint(reason); if (hint) console.error(hint);
    console.log(JSON.stringify({ schema, status: 'error', reason }));
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args = process.argv.slice(2);
  try {
    if (args[0] === '--encoded-arguments') {
      if (args.length !== 2) throw new Error();
      args = JSON.parse(Buffer.from(args[1],'base64').toString('utf8'));
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error();
    }
    process.exitCode = await main(args);
  } catch { console.log(JSON.stringify({ schema: 'gidd.cli/v1', status: 'error', reason: 'invalid_arguments' })); process.exitCode = 2; }
}
