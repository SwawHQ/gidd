import { existsSync } from 'node:fs';
import { configurationPath, parseConfiguration, readConfigurationText } from '../../shared/storage.mjs';
import { listModes, listSpecs, loadSpec, readSpec, loadIssueForms, requireSpecLanguage, specRoot, specSelectionHint, specCatalogHint } from '../../shared/specs.mjs';
import { isModeSelector, parseSpecName, authorizationKeys } from '../../shared/spec-modes.mjs';
import { resolveLanguage } from '../../shared/language.mjs';

export function parseSpecArguments(route, args) {
  const input = [...args];
  const routes = { spec: 'show', 'spec.current': 'show', 'spec.issue': 'issue', 'spec.issue.current': 'issue', 'spec.modes': 'modes', 'spec.list': 'list' };
  if (!Object.hasOwn(routes, route)) throw new Error('invalid_spec_route');
  const action = routes[route], current = route.endsWith('.current');
  let selector;
  if (!current && action !== 'modes') {
    selector = input.shift();
    try {
      if (action === 'list') { if (!isModeSelector(selector)) throw new Error(); }
      else parseSpecName(selector);
    } catch { throw new Error('invalid_arguments'); }
  }
  let lang;
  while (input.length) {
    const flag = input.shift();
    if (flag === '--lang' && lang === undefined && input[0] && !input[0].startsWith('--')) { lang = input.shift(); continue; }
    throw new Error('invalid_arguments');
  }
  return { action, selector, current, lang: resolveLanguage(lang) };
}

export function specError(repository, selector, reason, lang = 'en') {
  const zh = lang === 'zh-CN';
  const hint = reason === 'invalid_arguments' || reason === 'invalid_spec_route'
    ? 'Run gidd.link help for spec command usage.'
    : reason === 'unsupported_help_language' ? 'Use --lang zh or --lang en.'
    : ['spec_current_missing', 'spec_current_unsupported', 'spec_number_missing', 'spec_mode_missing'].includes(reason) ? specSelectionHint
    : reason === 'spec_number_ambiguous' ? (zh ? '该编号对应多份规范，请使用完整规范名，例如 00/00.auto。' : 'This number matches multiple presets. Use the full preset name, for example 00/00.auto.')
    : reason === 'spec_mode_id_conflict' || reason === 'spec_mode_name_conflict' ? (zh ? '请修正 conflicts 中列出的模式目录，使编号和模式名各自唯一。' : 'Fix the mode directories listed in conflicts so their IDs and mode names are unique.')
    : reason === 'spec_issue_template_missing' ? (zh ? '当前模式不使用 Issue 模板。' : 'This mode does not use an Issue template.')
    : reason === 'spec_language_unavailable' ? (zh ? '所选语言的模式说明或参考经验尚未完成；请使用可用语言或补齐对应正文。' : 'The requested language is incomplete. Use an available language (for example --lang zh) or complete the mode description and references.')
    : reason.startsWith('spec_') ? specCatalogHint : 'Run gidd.link doctor for diagnostics.';
  return { ...(repository ? { scope: repository } : {}), ...(selector ? { selector } : {}), error: reason, hint };
}

const inlineCode = value => {
  const fence = '`'.repeat(Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length)) + 1);
  const padding = /^`|`$/.test(value) ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
};

export function renderSpec(repository, spec, lang) {
  requireSpecLanguage(spec, lang);
  const zh = lang === 'zh-CN', { definition, authorization } = spec;
  const experience = step => spec.experiences.find(item => item.step === step)[lang];
  const lines = [
    `${zh ? '适用范围' : 'Scope'}: ${inlineCode(repository)}  `,
    `${zh ? '提示来源' : 'Prompt source'}: ${inlineCode(spec.path)}  `,
    `${zh ? '模式来源' : 'Mode source'}: ${inlineCode(definition.path)}`, '',
    `# ${spec.selector}`, '', definition[lang].description.trim(), '',
    zh ? '## 流程与授权' : '## Flow and authorization', '',
    definition.flow.map(step => `${step} (${Object.hasOwn(authorization, step) ? authorization[step] : 'auto'})`).join(' → '), '',
    zh ? '以下授权是规范约束，后面的环节参考经验不改变这些授权或流程。' : 'These authorizations govern the workflow; the reference guidance below does not change them.', '',
    zh ? 'auto：前置条件满足时自行执行。ask：复用范围内已有的明确授权；尚未授权时，先准备可检查的结果，再询问。not_applicable：本模式不包含该环节。' : 'auto: proceed when prerequisites hold. ask: reuse explicit authorization within its scope; otherwise prepare a reviewable result before asking. not_applicable: the mode excludes this stage.', '',
    zh ? 'add、commit、push 及错误处理分别遵守授权，不互相包含。task_definition、workspace 和适用时的 pr 由模式固定安排为 auto；development 的 ask 可作为开发前检查点。' : 'add, commit, push and error handling have separate authorization. task_definition, workspace and applicable pr are fixed auto stages; development with ask provides a checkpoint before implementation.', '',
    '| ' + (zh ? '环节 | 授权' : 'Stage | Authorization') + ' |', '| --- | --- |',
    ...authorizationKeys.map(key => `| ${key} | ${authorization[key]} |`), '',
    zh ? '验收未通过时返回开发和验收。推送受阻时进入 push_error；修复涉及的修改、提交和推送重新经过对应环节及授权。' : 'Failed acceptance returns to development and acceptance. A blocked push enters push_error; changes, commits and pushes required by a repair pass through their respective stages and authorization.', '',
  ];
  if (definition.merge) lines.push(zh ? '合并受阻时进入 merge_error，修复后重新确认验收与合并条件；等待或启用自动合并不等于交付完成。' : 'A blocked merge enters merge_error. Recheck acceptance and merge requirements after repairs; waiting or enabling auto-merge does not establish delivery.', '');
  if (definition.issue) lines.push(zh ? 'Issue 模板：' : 'Issue template:', '', inlineCode(`gidd.link spec.issue ${spec.selector} --lang ${zh ? 'zh' : 'en'}`), '');
  lines.push(zh ? '## 公共参考经验' : '## Common reference guidance', '', experience('common').body.trim(), '', zh ? '## 各环节参考经验' : '## Stage reference guidance', '');
  for (const step of definition.flow) {
    const text = experience(step);
    lines.push(`### ${text.title}`, '', text.body.trim(), '');
  }
  lines.push(zh ? '## 受阻时的参考经验' : '## Reference guidance when blocked', '');
  for (const step of definition.errors) {
    const text = experience(step), trigger = step === 'push_error' ? 'push' : 'merge';
    lines.push(`### ${text.title}`, '', zh ? `仅在 ${trigger} 受阻时适用，授权为 ${authorization[step]}。` : `Applies only when ${trigger} is blocked; authorization: ${authorization[step]}.`, '', text.body.trim(), '');
  }
  return lines.join('\n');
}

export function specCommand(repository, options, root = specRoot) {
  let selector = options.selector;
  const failure = (error, exitCode = options.current ? 1 : 2) => ({ report: {
    ...specError(repository, selector, error.message, options.lang),
    ...(error.path ? { path: error.path } : {}), ...(error.field ? { field: error.field } : {}),
    ...(error.conflicts ? { conflicts: error.conflicts } : {}),
  }, exitCode });
  try {
    if (options.action === 'modes') return { report: { scope: repository, modes: listModes(options.lang, root) }, exitCode: 0 };
    if (options.action === 'list') return { report: { scope: repository, mode: selector, specs: listSpecs(selector, root) }, exitCode: 0 };
    if (options.current) {
      try {
        const path = configurationPath(repository);
        if (existsSync(path)) selector = parseConfiguration(readConfigurationText(path)).spec.current;
      } catch { return failure(new Error('spec_configuration_unreadable')); }
      if (selector === undefined) return failure(new Error('spec_current_missing'));
    }
    if (options.action === 'issue') {
      const spec = readSpec(selector, root), forms = loadIssueForms(spec, root);
      if (!forms) return failure(new Error('spec_issue_template_missing'));
      return { report: { scope: repository, selector, mode: spec.mode, form: forms[options.lang] }, exitCode: 0 };
    }
    return { markdown: renderSpec(repository, loadSpec(selector, root), options.lang), exitCode: 0 };
  } catch (error) { return failure(error); }
}

export async function runSpec(repository, options) {
  const result = specCommand(repository, options);
  if (result.markdown !== undefined) process.stdout.write(result.markdown);
  else if (['list', 'modes'].includes(options.action) && result.exitCode === 0) {
    const key = options.action === 'modes' ? 'modes' : 'specs', { [key]: rows, ...header } = result.report;
    const prefix = Object.entries(header).map(([name, value]) => '  ' + JSON.stringify(name) + ': ' + JSON.stringify(value));
    console.log('{\n' + prefix.join(',\n') + ',\n  "' + key + '": [\n' + rows.map(row => '    ' + JSON.stringify(row)).join(',\n') + '\n  ]\n}');
  } else console.log(JSON.stringify(result.report, null, 2));
  return result.exitCode;
}
