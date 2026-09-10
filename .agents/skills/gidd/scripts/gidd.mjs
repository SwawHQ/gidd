import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure, configurationHint, readGitHubConfiguration } from './config.mjs';
import { doctor } from './doctor.mjs';
import { checkIdentity } from './github.mjs';
import { authorize } from './auth.mjs';
import { resolveStorage, repositoryRoot } from './storage.mjs';
import { findTool } from './tools.mjs';
import { setupTools } from './install.mjs';

export async function main(args) {
  let command = (args.shift() || 'help').toLowerCase();
  const schemas = { config: 'gidd.config/v1', doctor: 'gidd.doctor/v1', setup: 'gidd.setup-tools/v1', identity: 'gidd.identity/v1', auth: 'gidd.auth/v1' };
  let schema = 'gidd.cli/v1';
  try {
    if (['help','--help','-h'].includes(command)) {
      if (args.length > 1) throw new Error('invalid_arguments');
      const choice = args[0] || process.env.GIDD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
      if ((args[0] || process.env.GIDD_LANG) && !/^(zh|en)(?:$|[-_])/.test(choice)) throw new Error('unsupported_help_language');
      const language = /^zh(?:$|[-_])/.test(choice) ? 'zh-CN' : 'en';
      console.log(readFileSync(new URL(`../assets/help/${language}.txt`,import.meta.url),'utf8')); return 0;
    }
    if (!Object.hasOwn(schemas,command)) throw new Error('unknown_command');
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('unsupported_platform');
    let action, key, value, tool;
    if (command === 'config') {
      action = args.shift(); if (!['show','set'].includes(action)) throw new Error('invalid_arguments');
      if (action === 'set') { key = args.shift(); value = args.shift(); if (value === undefined) throw new Error('invalid_arguments'); }
    }
    if (command === 'setup' && args.length && !args[0].startsWith('--')) {
      tool = args.shift(); if (!['bun','node','gh'].includes(tool)) throw new Error('invalid_setup_tool');
    }
    if (['identity','auth'].includes(command) && args.some(arg => ['--hostname','--account','--remote'].includes(arg) || !arg.startsWith('--') && args.indexOf(arg) === 0)) throw new Error('github_parameters_moved_to_config');
    let repository;
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--repository' || !args[1]) throw new Error('invalid_arguments');
      repository = args[1];
    } else {
      const scripts = dirname(fileURLToPath(import.meta.url));
      repository = resolve(scripts, '../../../..');
      if (resolve(repository, '.agents/skills/gidd/scripts').toLowerCase() !== scripts.toLowerCase() || !existsSync(resolve(repository,'.git'))) {
        throw new Error('repository_required_for_unbound_entry');
      }
    }
    repository = repositoryRoot(repository);
    schema = schemas[command];
    let report;
    if (command === 'doctor') report = await doctor(repository);
    else if (command === 'config') report = configure(repository,action,key,value);
    else {
      const storage = resolveStorage(repository);
      if (command === 'setup') report = await setupTools(storage,tool);
      else {
        const github = readGitHubConfiguration(repository,command === 'identity' ? ['hostname','account','remote'] : ['hostname','account']);
        const gh = await findTool('gh',{ root: storage.tools_root, requested: storage.tools.gh.version });
        if (command === 'auth' && gh.status !== 'ready') throw new Error('gh_unavailable');
        const options = { repository, ...github, gh: gh.status === 'ready' ? gh.details.path : undefined };
        if (command === 'identity') {
          const git = await findTool('git'); report = await checkIdentity({ ...options, git: git.status === 'ready' ? git.details.path : undefined });
        } else {
          const controller = new AbortController(), cancel = () => controller.abort();
          process.on('SIGINT',cancel); process.on('SIGTERM',cancel);
          try { report = await authorize(options,{ signal: controller.signal, onEvent: event => console.error(JSON.stringify(event)) }); }
          finally { process.removeListener('SIGINT',cancel); process.removeListener('SIGTERM',cancel); }
        }
      }
    }
    console.log(JSON.stringify(report));
    return ['ready','local_ready','checks_passed'].includes(report.status) ? 0 : 1;
  } catch (error) {
    const reason = /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : 'operation_failed';
    const hint = configurationHint(reason); if (hint) console.error(hint);
    console.log(JSON.stringify({ schema, status: 'error', reason }));
    return command === 'setup' && schema !== 'gidd.cli/v1' ? 1 : 2;
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
