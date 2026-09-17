import { existsSync } from 'node:fs';
import { configurationPath, parseConfiguration, readConfigurationText } from './storage.mjs';
import { loadSpec, loadSpecCatalog, specCatalogHint } from './specs.mjs';

function language(explicit) {
  const choice = explicit || process.env.GIDD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  if ((explicit || process.env.GIDD_LANG) && !/^(zh|en)(?:$|[-_])/.test(choice)) throw new Error('unsupported_help_language');
  return /^zh(?:$|[-_])/.test(choice) ? 'zh-CN' : 'en';
}

export function parseSpecArguments(route, args) {
  const input = [...args];
  const match = /^spec\.([a-z][a-z0-9-]*)(?:\.(issue))?$/.exec(route);
  if (!match || match[1] === 'list' && match[2]) throw new Error('invalid_spec_route');
  const selector = match[1];
  const action = selector === 'list' ? 'list' : match[2] ? 'issue' : 'show';
  let lang;
  while (input.length) {
    const flag = input.shift();
    if (flag === '--lang' && lang === undefined && input[0] && !input[0].startsWith('--')) { lang = input.shift(); continue; }
    throw new Error('invalid_arguments');
  }
  return { action, selector, lang: language(lang) };
}

export function specError(repository, mode, reason) {
  const hint = reason === 'invalid_arguments' || reason === 'invalid_spec_route'
    ? 'Run gidd.link help for spec command usage.'
    : reason === 'unsupported_help_language' ? 'Use --lang zh or --lang en.'
    : /^spec_(list|directory|description)_/.test(reason) ? specCatalogHint
    : reason.startsWith('spec_') ? 'Run gidd.link doctor --offline for details.'
    : 'Run gidd.link doctor for diagnostics.';
  return { ...(repository ? { scope: repository } : {}), ...(mode ? { mode } : {}), error: reason, hint };
}

export function specCommand(repository, options) {
  if (options.action === 'list') return { report: { scope: repository, specs: loadSpecCatalog()[options.lang] }, exitCode: 0 };
  const current = options.selector === 'current';
  const resourceExit = current ? 1 : 2;
  let mode = current ? undefined : options.selector;
  const failure = (reason, exitCode = resourceExit) => ({ report: specError(repository, mode, reason), exitCode });
  if (current) {
    try {
      const path = configurationPath(repository);
      if (existsSync(path)) mode = parseConfiguration(readConfigurationText(path)).spec.current;
    } catch {
      return failure('spec_configuration_unreadable');
    }
    if (mode === undefined) return failure('spec_current_missing');
  }
  let spec;
  try { spec = loadSpec(mode); }
  catch (error) { return failure(error.message); }
  const report = { scope: repository, mode };
  if (options.action === 'issue') return { report: { ...report, form: spec.issueForms[options.lang] }, exitCode: 0 };
  const zh = options.lang === 'zh-CN';
  // Paths may contain backticks; choose a safe Markdown code delimiter.
  const inlineCode = value => {
    const fence = '`'.repeat(Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length)) + 1);
    return `${fence} ${value} ${fence}`;
  };
  const prompt = spec.prompts[options.lang];
  // Two trailing spaces preserve a Markdown line break without a blank line.
  const header = `${zh ? '适用范围' : 'Scope'}: ${inlineCode(repository)}  \n${zh ? '提示来源' : 'Prompt source'}: ${inlineCode(prompt.path)}\n\n`;
  return { markdown: header + prompt.content, exitCode: 0 };
}
