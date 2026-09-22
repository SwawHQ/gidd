import { existsSync } from 'node:fs';
import { configurationPath, parseConfiguration, readConfigurationText } from '../../shared/storage.mjs';
import { loadSpec, loadSpecCatalog, specCatalogHint, specNamePattern } from '../../shared/specs.mjs';

function language(explicit) {
  const choice = explicit || process.env.GIDD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  if ((explicit || process.env.GIDD_LANG) && !/^(zh|en)(?:$|[-_])/.test(choice)) throw new Error('unsupported_help_language');
  return /^zh(?:$|[-_])/.test(choice) ? 'zh-CN' : 'en';
}

export function parseSpecArguments(route, args) {
  const input = [...args];
  const routes = { spec: 'show', 'spec.current': 'show', 'spec.issue': 'issue', 'spec.issue.current': 'issue', 'spec.list': 'list' };
  if (!Object.hasOwn(routes, route)) throw new Error('invalid_spec_route');
  const action = routes[route], current = route.endsWith('.current');
  let selector;
  if (!current && action !== 'list') {
    selector = input.shift();
    if (!specNamePattern.test(selector || '')) throw new Error('invalid_arguments');
  }
  let lang;
  while (input.length) {
    const flag = input.shift();
    if (flag === '--lang' && lang === undefined && input[0] && !input[0].startsWith('--')) { lang = input.shift(); continue; }
    throw new Error('invalid_arguments');
  }
  return { action, selector, current, lang: language(lang) };
}

export function specError(repository, mode, reason) {
  const hint = reason === 'invalid_arguments' || reason === 'invalid_spec_route'
    ? 'Run gidd.link help for spec command usage.'
    : reason === 'unsupported_help_language' ? 'Use --lang zh or --lang en.'
    : reason === 'spec_issue_template_missing' ? 'This spec does not declare issue_template. Choose a spec with a template or add an explicit reference to both prompt files.'
    : /^spec_(list|directory|metadata)_/.test(reason) ? specCatalogHint
    : reason.startsWith('spec_') ? 'Run gidd.link doctor --offline for details.'
    : 'Run gidd.link doctor for diagnostics.';
  return { ...(repository ? { scope: repository } : {}), ...(mode ? { mode } : {}), error: reason, hint };
}

export function specCommand(repository, options) {
  if (options.action === 'list') return { report: { scope: repository, specs: loadSpecCatalog()[options.lang] }, exitCode: 0 };
  const current = options.current;
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
  if (options.action === 'issue') return spec.issueForms
    ? { report: { ...report, form: spec.issueForms[options.lang] }, exitCode: 0 }
    : failure('spec_issue_template_missing');
  const zh = options.lang === 'zh-CN';
  // Paths may contain backticks; choose a safe Markdown code delimiter.
  const inlineCode = value => {
    const fence = '`'.repeat(Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length)) + 1);
    const padding = /^`|`$/.test(value) ? ' ' : '';
    return `${fence}${padding}${value}${padding}${fence}`;
  };
  const prompt = spec.prompts[options.lang];
  // Two trailing spaces preserve a Markdown line break without a blank line.
  const header = `${zh ? '适用范围' : 'Scope'}: ${inlineCode(repository)}  \n${zh ? '提示来源' : 'Prompt source'}: ${inlineCode(prompt.path)}\n\n`;
  // Bind template references to this rendered spec, even when config selects
  // another one. This is literal text substitution, never command execution.
  const issueCommand = `gidd.link spec.issue ${mode} --lang ${zh ? 'zh' : 'en'}`;
  const content = prompt.content.replaceAll('@gidd.link spec.issue.current@', issueCommand);
  return { markdown: header + content, exitCode: 0 };
}


export async function runSpec(repository, specOptions) {
  const result = await specCommand(repository, specOptions);
  if (result.markdown !== undefined) process.stdout.write(result.markdown);
  else if (specOptions.action === 'list' && result.exitCode === 0) {
    // Keep each workflow on one line while preserving ordinary JSON parsing.
    const rows = result.report.specs.map(spec => '    ' + JSON.stringify(spec)).join(',\n');
    console.log('{\n  "scope": ' + JSON.stringify(result.report.scope) + ',\n  "specs": [\n' + rows + '\n  ]\n}');
  }
  else console.log(JSON.stringify(result.report, null, 2));
  return result.exitCode;
}
