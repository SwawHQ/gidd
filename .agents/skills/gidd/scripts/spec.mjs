import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { configurationPath, parseConfiguration, readConfigurationText, toolsRoot } from './storage.mjs';
import { normalizeRepositoryIdentity, validateGitHubField } from './config.mjs';
import { boundTools, boundExecutor } from './bindings.mjs';
import { runCommand } from './github.mjs';
import { inspectSpec, specHelpers } from './specs.mjs';

function language(explicit) {
  const choice = explicit || process.env.GIDD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  if ((explicit || process.env.GIDD_LANG) && !/^(zh|en)(?:$|[-_])/.test(choice)) throw new Error('unsupported_help_language');
  return /^zh(?:$|[-_])/.test(choice) ? 'zh-CN' : 'en';
}

export function parseSpecArguments(args) {
  const input = [...args];
  const action = !input.length || input[0].startsWith('--') ? 'current' : input.shift();
  if (!['current', 'template'].includes(action)) throw new Error('invalid_arguments');
  if (action === 'template' && input.shift() !== 'issue') throw new Error('invalid_arguments');
  let lang, json = false;
  while (input.length) {
    const flag = input.shift();
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--lang' && lang === undefined && input[0] && !input[0].startsWith('--')) { lang = input.shift(); continue; }
    throw new Error('invalid_arguments');
  }
  return { action, lang: language(lang), json };
}

const quote = text => "'" + text.replaceAll("'", "''") + "'";
const commandText = command => '& ' + [command.executable, ...command.args].map(quote).join(' ');
const usableFile = path => {
  try { return !!path && lstatSync(path).isFile(); } catch { return false; }
};

function githubTarget(github) {
  try {
    validateGitHubField('hostname', github.hostname);
    const identity = normalizeRepositoryIdentity(github.repository);
    if (new URL(identity).hostname !== github.hostname.toLowerCase()) return null;
    return identity.slice('https://'.length);
  } catch { return null; }
}

async function targetBranch(repository, github, bindings, execute) {
  const result = { branch: null, source: 'unresolved', remote_verified: false };
  if (!usableFile(bindings.git?.path)) return result;
  try { validateGitHubField('remote', github.remote); } catch { return result; }
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

function helpersFor(spec, repository, github, bindings, lang) {
  const identity = githubTarget(github), link = join(repository, '.agents/skills/gidd/gidd.link.cmd');
  return spec.definition.helpers.map(id => {
    const helper = specHelpers[id];
    const executable = helper.tool === 'gidd' ? link : bindings[helper.tool]?.path;
    const available = usableFile(executable) && (helper.tool !== 'gh' || !!identity);
    const args = helper.args.map(arg => arg === '{repository}' ? identity : arg);
    if (id === 'spec.template.issue') args.push('--lang', lang);
    const command = available ? { executable, args: helper.tool === 'git' ? ['-C', repository, ...args] : args } : {};
    return { id, description: lang === 'zh-CN' ? helper.zh : helper.en, effect: helper.effect, available,
      ...command, ...(helper.inputs ? { required_inputs: helper.inputs } : {}),
      ...(!available ? { reason: helper.tool === 'gidd' ? 'repository_entry_missing' :
        !usableFile(executable) ? 'tool_binding_unavailable' : 'github_repository_unconfigured' } : {}) };
  });
}

function render(report, lang) {
  const zh = lang === 'zh-CN';
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
    `${zh ? '当前规范' : 'Current spec'}: ${report.mode} — ${report.title}`,
    `${zh ? '适用仓库' : 'Repository'}: ${report.repository}`,
    `${zh ? '目标分支' : 'Target branch'}: ${target}`, '', report.instructions.trimEnd(), '',
    zh ? '可用 helper（PowerShell；替换占位参数后执行）：' : 'Available helpers (PowerShell; replace placeholder arguments before execution):',
  ];
  for (const helper of report.helpers.filter(helper => helper.available)) {
    lines.push(`[${helper.effect}] ${helper.description}`, '  ' + commandText(helper));
  }
  const blocked = report.helpers.filter(helper => !helper.available);
  if (blocked.length) {
    lines.push('', zh ? '以下 helper 暂不可用；按 doctor 提示修复配置或工具，缺少仓库入口时运行 gidd.pre.ensure.cmd --repo <仓库路径>：' :
      'These helpers are unavailable. Follow doctor guidance to repair configuration/tools; use gidd.pre.ensure.cmd --repo <repository-path> if the repository entry is missing:');
    for (const helper of blocked) lines.push(`  ${helper.id}: ${helper.reason}`);
  }
  return lines.join('\n');
}

export async function specCommand(repository, options, { execute = runCommand } = {}) {
  const report = { schema: 'gidd.spec/v1', status: 'needs_attention', repository, read_only: true };
  let settings;
  try {
    const path = configurationPath(repository);
    if (!existsSync(path)) {
      report.checks = inspectSpec(undefined, repository).checks;
      return { report, text: render(report, options.lang) };
    }
    settings = parseConfiguration(readConfigurationText(path));
  } catch {
    report.checks = [{ id: 'config_file', status: 'invalid', reason: 'spec_configuration_unreadable',
      hint: 'Run doctor --offline and repair the configuration it reports. No spec was selected.' }];
    return { report, text: render(report, options.lang) };
  }
  const { spec, checks } = inspectSpec(settings.spec.mode, repository);
  report.checks = checks;
  if (!spec) return { report, text: render(report, options.lang) };
  Object.assign(report, { status: 'ready', mode: spec.definition.id, version: spec.definition.version });
  if (options.action === 'template') {
    Object.assign(report, { template: 'issue', content: spec.templates[options.lang] });
  } else {
    let bindings = {};
    try { bindings = boundTools(toolsRoot(), []); } catch { /* Guidance remains available without tools. */ }
    Object.assign(report, { title: spec.definition.title[options.lang], instructions: spec.prompts[options.lang],
      target: await targetBranch(repository, settings.github, bindings, execute),
      helpers: helpersFor(spec, repository, settings.github, bindings, options.lang) });
  }
  return { report, text: render(report, options.lang) };
}
