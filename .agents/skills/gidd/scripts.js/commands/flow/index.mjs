import { readFlowHistory, flowStorage } from '../../shared/flow-history.mjs';
import { resolve } from 'node:path';
import { listDeliveryModes, listAuthorizationPresets, loadFlow, readFlow, loadIssueForms, requireFlowLanguage, flowRoot, flowSelectionHint, flowCatalogHint } from '../../shared/flows.mjs';
import { isDeliveryModeSelector, parseFlowSelector, authorizationKeys } from '../../shared/flow-definition.mjs';
import { resolveLanguage } from '../../shared/language.mjs';
import { diagnostic } from '../../shared/diagnostics.mjs';
import { boundExecutor, boundTools } from '../../shared/bindings.mjs';
import { locateStorage } from '../../shared/managed-storage.mjs';
import { noninteractiveEnvironment } from '../../shared/noninteractive.mjs';
import { toolsRoot } from '../../shared/storage.mjs';

export function parseFlowArguments(route, args) {
  const input = [...args];
  const routes = { flow: 'show', 'flow.history': 'history', 'flow.issue': 'issue', 'flow.deliveries': 'deliveries', 'flow.list': 'list' };
  if (!Object.hasOwn(routes, route)) throw new Error('invalid_flow_route');
  const action = routes[route];
  let selector;
  if (!['deliveries', 'history'].includes(action)) {
    selector = input.shift();
    try {
      if (action === 'list') { if (!isDeliveryModeSelector(selector)) throw new Error(); }
      else parseFlowSelector(selector);
    } catch { throw new Error('invalid_arguments'); }
  }
  let lang, verbose;
  while (input.length) {
    const flag = input.shift();
    if (flag === '-v' && action === 'history' && !verbose) { verbose = true; continue; }
    if (flag === '--lang' && lang === undefined && input[0] && !input[0].startsWith('--')) { lang = input.shift(); continue; }
    throw new Error('invalid_arguments');
  }
  return { action, selector, ...(verbose ? { verbose } : {}), lang: lang === undefined ? undefined : resolveLanguage(lang) };
}

export function flowError(repository, selector, reason, lang = 'en', facts) {
  const zh = lang === 'zh-CN';
  const hint = reason === 'invalid_arguments' || reason === 'invalid_flow_route'
    ? 'Run gidd help for flow command usage.'
    : reason === 'unsupported_help_language' ? 'Use --lang zh or --lang en.'
    : ['flow_selector_invalid', 'flow_number_missing', 'flow_mode_missing'].includes(reason) ? flowSelectionHint
    : reason === 'task_required' ? 'Register the Issue with gidd <Issue编号> --flow <flow>.'
    : reason === 'flow_number_ambiguous' ? (zh ? '该编号对应多份授权方案，请使用完整授权方案名，例如 00/00.auto。' : 'This number matches multiple presets. Use the full preset name, for example 00/00.auto.')
    : reason === 'flow_mode_id_conflict' || reason === 'flow_mode_name_conflict' ? (zh ? '请修正 details.conflicts 中列出的模式目录，使编号和模式名各自唯一。' : 'Fix the mode directories listed in details.conflicts so their IDs and mode names are unique.')
    : reason === 'flow_language_unavailable' ? (zh ? '请使用可用语言，或补齐该语言的模式简介及已有正文的标题。环节正文可以省略。' : 'Use an available language, or complete the mode description and titles for existing guidance. Stage guidance is optional.')
    : reason.startsWith('flow_') ? flowCatalogHint : 'Run gidd doctor for diagnostics.';
  return { ...(repository ? { scope: repository } : {}), ...(selector ? { selector } : {}), details: diagnostic(reason, facts), hint };
}

const inlineCode = value => {
  const fence = '`'.repeat(Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length)) + 1);
  const padding = /^`|`$/.test(value) ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
};

export function renderFlow(repository, flow, lang) {
  requireFlowLanguage(flow, lang);
  const zh = lang === 'zh-CN', { definition, authorization } = flow;
  const stepReference = step => flow.stepReferences.find(item => item.step === step)?.[lang];
  const lines = [
    ...(repository ? [`${zh ? '适用范围' : 'Scope'}: ${inlineCode(repository)}  `] : []),
    `${zh ? '授权方案来源' : 'Authorization preset source'}: ${inlineCode(flow.path)}  `,
    `${zh ? '交付模式来源' : 'Delivery mode source'}: ${inlineCode(definition.path)}`, '',
    `# ${flow.selector}`, '', definition[lang].description.trim(), '',
    zh ? '## 流程与授权' : '## Flow and authorization', '',
    definition.steps.map(step => `${step} (${Object.hasOwn(authorization, step) ? authorization[step] : 'auto'})`).join(' → '), '',
    zh ? '按与用户确定的流程和确认点开展工作。可使用 GIDD 工具或原生 Git/gh；工具选择不改变授权要求。' : 'Follow the agreed process and approval points. Use GIDD tools or native Git/gh; tool choice does not change authorization.', '',
    zh ? 'auto：前置条件满足时自行执行。ask：复用范围内已有的明确授权；尚未授权时，先准备可检查的结果，再询问。not_applicable：本模式不包含该环节。' : 'auto: proceed when prerequisites hold. ask: reuse explicit authorization within its scope; otherwise prepare a reviewable result before asking. not_applicable: the mode excludes this stage.', '',
    zh ? '错误处理仍遵守所涉及环节的授权。历史记录供参考，不代表用户已经授权本次操作。' : 'Recovery follows the authorizations of the affected stages. Flow history is reference information, not approval for this task.', '',
    '| ' + (zh ? '环节 | 授权' : 'Stage | Authorization') + ' |', '| --- | --- |',
    ...authorizationKeys.map(key => `| ${key} | ${authorization[key]} |`), '',
    zh ? '验收未通过时返回开发和验收。推送受阻时进入 push_error；修复涉及的修改、提交和推送重新经过对应环节及授权。' : 'Failed acceptance returns to development and acceptance. A blocked push enters push_error; changes, commits and pushes required by a repair pass through their respective stages and authorization.', '',
  ];
  lines.push(zh ? 'Issue 模板：' : 'Issue template:', '', inlineCode(`gidd flow.issue ${flow.selector} --lang ${zh ? 'zh' : 'en'}`), '');
  if (stepReference('common')?.body.trim()) lines.push(zh ? '## 工具与资源' : '## Tools and resources', '', stepReference('common').body.trim(), '');
  for (const step of definition.steps) {
    const text = stepReference(step);
    if (text?.body.trim()) lines.push(`### ${text.title}`, '', text.body.trim(), '');
    const errorStep = step + '_error';
    if (definition.errors.includes(errorStep)) {
      const blocked = stepReference(errorStep);
      if (blocked?.body.trim()) lines.push(`#### ${blocked.title}`, '', zh ? `仅在 ${step} 受阻时适用，授权为 ${authorization[errorStep]}。` : `Applies only when ${step} is blocked; authorization: ${authorization[errorStep]}.`, '', blocked.body.trim(), '');
    }
  }
  return lines.join('\n');
}

export function flowCommand(repository, options, root = flowRoot) {
  options = { ...options, lang: resolveLanguage(options.lang, 'unsupported_help_language', repository) };
  let selector = options.selector;
  const failure = (error, exitCode = 2) => ({ report: {
    ...flowError(repository, selector, error.message, options.lang, {
      ...(error.path ? { path: error.path } : {}), ...(error.field ? { field: error.field } : {}),
      ...(error.conflicts ? { conflicts: error.conflicts } : {}),
    }),
  }, exitCode });
  try {
    if (options.action === 'deliveries') return { report: { scope: repository, deliveries: listDeliveryModes(options.lang, root) }, exitCode: 0 };
    if (options.action === 'list') return { report: { scope: repository, delivery_mode: selector, presets: listAuthorizationPresets(selector, root) }, exitCode: 0 };
    if (options.action === 'history') {
      const history = readFlowHistory(flowStorage(repository)).slice(-200).reverse(), labels = new Map();
      const rows = history.map(entry => {
        if (!labels.has(entry.selector)) {
          const short = entry.selector.replace(/^([0-9]{2})\.[^/]+\/([0-9]{2})\..+$/, '$1/$2');
          let label = entry.selector;
          try { if (readFlow(short, root).selector === entry.selector) label = short; } catch {}
          labels.set(entry.selector, label);
        }
        return labels.get(entry.selector) + (options.verbose ? ' ' + entry.at : '');
      });
      const heading = options.lang === 'zh-CN' ? '工作流程记录（最新在前，最多200条）：' : 'Workflow records (newest first, up to 200):';
      return { markdown: rows.length ? heading + '\n' + rows.join(options.verbose ? '\n' : ' ') + '\n'
        : (options.lang === 'zh-CN' ? '暂无工作流程记录。\n' : 'No workflow records.\n'), exitCode: 0 };
    }
    if (options.action === 'issue') {
      const flow = readFlow(selector, root), forms = loadIssueForms(flow, root);
      return { report: { scope: repository, selector, delivery_mode: flow.mode, form: forms[options.lang] }, exitCode: 0 };
    }
    const flow = loadFlow(selector, root);
    return { markdown: renderFlow(repository, flow, options.lang), exitCode: 0 };
  } catch (error) { return failure(error); }
}

export async function runFlow(repository, options) {
  if (options.action === 'history') {
    const bindings = boundTools(toolsRoot(), ['git']), execute = boundExecutor(bindings);
    const storage = await locateStorage(repository, async (path, args) => {
      const result = await execute(bindings.git.path, ['-C', path, ...args],
        { env: noninteractiveEnvironment(bindings.git.path, process.env), timeoutMs: 60000 });
      if (!result.ok) throw new Error('data_git_failed');
      return result.text;
    });
    repository = resolve(storage.main);
  }
  const result = flowCommand(repository, options);
  if (result.markdown !== undefined) process.stdout.write(result.markdown);
  else if (['list', 'deliveries'].includes(options.action) && result.exitCode === 0) {
    const key = options.action === 'deliveries' ? 'deliveries' : 'presets', { [key]: rows, ...header } = result.report;
    const prefix = Object.entries(header).filter(([, value]) => value !== undefined)
      .map(([name, value]) => '  ' + JSON.stringify(name) + ': ' + JSON.stringify(value));
    console.log('{\n' + (prefix.length ? prefix.join(',\n') + ',\n' : '') + '  "' + key + '": [\n' + rows.map(row => '    ' + JSON.stringify(row)).join(',\n') + '\n  ]\n}');
  } else console.log(JSON.stringify(result.report, null, 2));
  return result.exitCode;
}
