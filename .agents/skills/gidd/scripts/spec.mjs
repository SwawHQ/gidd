import { existsSync, lstatSync } from 'node:fs';
import { configurationPath, parseConfiguration, readConfigurationText, toolsRoot } from './storage.mjs';
import { validateRemoteField } from './config.mjs';
import { boundTools, boundExecutor } from './bindings.mjs';
import { runCommand } from './github.mjs';
import { inspectSpec, loadSpec, specModes } from './specs.mjs';
import { checkIssueMarkdown } from './issue-check.mjs';
import { readIssueSource } from './issue-source.mjs';

function language(explicit) {
  const choice = explicit || process.env.GIDD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  if ((explicit || process.env.GIDD_LANG) && !/^(zh|en)(?:$|[-_])/.test(choice)) throw new Error('unsupported_help_language');
  return /^zh(?:$|[-_])/.test(choice) ? 'zh-CN' : 'en';
}

export function parseSpecArguments(route, args) {
  const input = [...args];
  const match = /^spec(?:\.([a-z][a-z0-9-]*)(?:\.(issue)(?:\.(check))?)?)?$/.exec(route);
  if (!match) throw new Error('invalid_spec_route');
  const selector = match[1];
  const action = !selector ? 'list' : match[3] ? 'check' : match[2] ? 'issue' : 'show';
  let source;
  let lang, json = false;
  while (input.length) {
    const flag = input.shift();
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--lang' && lang === undefined && input[0] && !input[0].startsWith('--')) { lang = input.shift(); continue; }
    if (action === 'check' && source === undefined && flag && !flag.startsWith('--')) { source = flag; continue; }
    throw new Error('invalid_arguments');
  }
  if (action === 'check' && source === undefined) throw new Error('issue_source_required');
  return { action, selector, source, lang: language(lang), json };
}

const quote = text => "'" + text.replaceAll("'", "''") + "'";
const commandText = command => '& ' + [command.executable, ...command.args].map(quote).join(' ');
const usableFile = path => {
  try { return !!path && lstatSync(path).isFile(); } catch { return false; }
};

async function targetBranch(repository, github, bindings, execute) {
  const result = { branch: null, source: 'unresolved', remote_verified: false };
  if (!usableFile(bindings.git?.path)) return result;
  try { validateRemoteField('name', github.remote); } catch { return result; }
  const prefix = 'refs/remotes/' + github.remote + '/';
  let output;
  try {
    output = await boundExecutor(bindings, execute)(bindings.git.path,
      ['-C', repository, 'symbolic-ref', '--quiet', prefix + 'HEAD'], { timeoutMs: 5000 });
  } catch { return result; }
  if (output.ok && output.text.startsWith(prefix) && output.text.length > prefix.length && !/[\x00-\x1f\x7f]/.test(output.text)) {
    result.branch = output.text.slice(prefix.length);
    result.source = 'local_remote_head';
  }
  return result;
}

function render(report, lang) {
  const zh = lang === 'zh-CN';
  if (report.action === 'list') return report.names.join('\n');
  if (report.status === 'error') return [report.reason, report.hint].filter(Boolean).join('\n');
  if (report.action === 'check' && report.source) {
    const lines = [`${report.mode}: ${report.status}`, report.source.path || report.source.url,
      zh ? '范围：Issue 正文自动规则；不代表任务已完成或内容质量已人工验收。' :
        'Scope: automated Issue body rules; this does not verify delivery or replace content review.'];
    for (const item of report.checks.filter(item => item.status === 'failed')) {
      lines.push(`${item.id}${item.line ? `:${item.line}` : ''}: ${item.reason}`, '  ' + item.hint);
    }
    return lines.join('\n');
  }
  if (report.status !== 'ready') {
    const lines = [zh ? '当前规范不可用。' : 'The current spec is unavailable.'];
    for (const item of report.checks.filter(item => item.status !== 'ready' && item.status !== 'not_checked')) {
      lines.push(`${item.id}: ${item.reason}`, item.hint || '');
      for (const command of item.commands || []) lines.push(commandText(command));
    }
    return lines.filter(Boolean).join('\n');
  }
  if (report.template) return report.content.trimEnd();
  const target = report.target.branch ? report.target.branch + (zh ? '（本地远程 HEAD 记录，未联网确认）' : ' (local remote HEAD; not verified online)') :
    (zh ? '尚未确定；先查询仓库默认分支，不能猜测为 main。' : 'Unresolved; query the repository default branch instead of assuming main.');
  const lines = [
    `${zh ? '规范' : 'Spec'}: ${report.mode} — ${report.title}`,
    `${zh ? '适用仓库' : 'Repository'}: ${report.repository}`,
    `${zh ? '目标分支' : 'Target branch'}: ${target}`, '', report.instructions.trimEnd(),
  ];
  return lines.join('\n');
}

export async function specCommand(repository, options, { execute = runCommand } = {}) {
  const report = { schema: 'gidd.spec/v1', action: options.action, status: 'needs_attention', repository, read_only: true };
  if (options.action === 'list') {
    Object.assign(report, { status: 'ready', names: [...specModes] });
    return { report, text: render(report, options.lang) };
  }
  const unresolved = () => ({ report, text: render(report, options.lang), exitCode: options.action === 'check' ? 2 : 1 });
  let settings = { repo: { remote: {} }, spec: {} };
  try {
    const path = configurationPath(repository);
    if (!existsSync(path)) {
      if (options.selector === 'current') {
        report.checks = inspectSpec(undefined, repository).checks;
        return unresolved();
      }
    } else {
      settings = parseConfiguration(readConfigurationText(path));
    }
  } catch {
    if (options.selector === 'current') {
      report.checks = [{ id: 'config.toml', status: 'invalid', reason: 'spec_configuration_unreadable',
        hint: 'Run doctor --offline and repair the configuration it reports. No spec was selected.' }];
      return unresolved();
    }
  }
  let spec;
  if (options.selector === 'current') {
    const selected = inspectSpec(settings.spec.mode, repository);
    report.checks = selected.checks;
    spec = selected.spec;
    if (!spec) return unresolved();
  } else {
    try { spec = loadSpec(options.selector); }
    catch (error) {
      Object.assign(report, { status: 'error', reason: error.message,
        hint: error.message === 'spec_mode_unsupported' ? 'Available specs: ' + specModes.join(', ') : 'Restore or reinstall the spec resources, then rerun doctor.' });
      return { report, text: render(report, options.lang), exitCode: 2 };
    }
  }
  Object.assign(report, { status: 'ready', mode: spec.definition.id, version: spec.definition.version });
  if (options.action === 'check') {
    try {
      const { body, source } = await readIssueSource(repository, options.source, { execute });
      const checks = checkIssueMarkdown(body, spec.issueRules, options.lang);
      Object.assign(report, { source, scope: 'issue_body', checks,
        status: checks.some(item => item.status === 'failed') ? 'failed' : 'passed' });
      return { report, text: render(report, options.lang), exitCode: report.status === 'passed' ? 0 : 1 };
    } catch (error) {
      Object.assign(report, { status: 'error', reason: error.message, hint: 'Check the source path or run doctor for GitHub configuration and access. No Issue was changed.' });
      return { report, text: render(report, options.lang), exitCode: 2 };
    }
  } else if (options.action === 'issue') {
    Object.assign(report, { template: 'issue', content: spec.templates[options.lang] });
  } else {
    let bindings = {};
    try { bindings = boundTools(toolsRoot(), []); } catch { /* Guidance remains available without tools. */ }
    Object.assign(report, { title: spec.definition.title[options.lang], instructions: spec.prompts[options.lang],
      target: await targetBranch(repository, { remote: settings.repo.remote.name }, bindings, execute) });
  }
  return { report, text: render(report, options.lang) };
}
