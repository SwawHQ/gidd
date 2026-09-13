import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainPath } from './storage.mjs';

// Only shipped modes are selectable. Mode names never become arbitrary paths.
export const specModes = Object.freeze(['issue-direct']);
const specsRoot = fileURLToPath(new URL('../specs/', import.meta.url));
export const specHelpers = Object.freeze({
  'spec.template.issue': { tool: 'gidd', args: ['spec', 'template', 'issue'], effect: 'read',
    zh: '打印 Issue 模板；保存并补全后使用。', en: 'Print the Issue template; save and complete it before use.' },
  'doctor.offline': { tool: 'gidd', args: ['doctor', '--offline'], effect: 'read',
    zh: '检查本地环境和配置。', en: 'Check local prerequisites and configuration.' },
  'doctor.online': { tool: 'gidd', args: ['doctor'], effect: 'network-read',
    zh: '联网检查 GitHub 身份及远程读取；不代表有推送权限。', en: 'Check GitHub identity and remote reading; this does not prove push permission.' },
  'git.status': { tool: 'git', args: ['status', '--short'], effect: 'read',
    zh: '查看目标仓库的工作区改动。', en: 'Inspect working tree changes in the bound repository.' },
  'github.default-branch': { tool: 'gh', args: ['repo', 'view', '{repository}', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], effect: 'network-read',
    zh: '查询 GitHub 当前默认分支；本地记录缺失或需要确认时使用。', en: 'Read the current GitHub default branch when the local record is missing or needs confirmation.' },
  'github.issue.view': { tool: 'gh', args: ['issue', 'view', '<issue>', '--repo', '{repository}'], effect: 'network-read', inputs: ['issue'],
    zh: '读取指定 Issue，确认范围和验收条件。', en: 'Read the selected Issue, scope and acceptance criteria.' },
  'github.issue.create': { tool: 'gh', args: ['issue', 'create', '--title', '<title>', '--body-file', '<file>', '--repo', '{repository}'], effect: 'write', inputs: ['title', 'file'],
    zh: '用已补全的模板创建 Issue；执行会写入 GitHub。', en: 'Create an Issue from the completed template; this writes to GitHub.' },
  'github.issue.comment': { tool: 'gh', args: ['issue', 'comment', '<issue>', '--body-file', '<file>', '--repo', '{repository}'], effect: 'write', inputs: ['issue', 'file'],
    zh: '记录提交、验证结果及剩余事项；执行会写入 GitHub。', en: 'Record commits, validation and remaining work; this writes to GitHub.' },
  'github.issue.close': { tool: 'gh', args: ['issue', 'close', '<issue>', '--reason', 'completed', '--repo', '{repository}'], effect: 'write', inputs: ['issue'],
    zh: '确认远程交付且全部验收条件满足后关闭 Issue。', en: 'Close the Issue only after remote delivery and all acceptance criteria are satisfied.' },
});

export function validateSpecMode(mode) {
  if (!specModes.includes(mode)) throw new Error('spec_mode_unsupported');
}

function resource(root, relative) {
  if (typeof relative !== 'string' || isAbsolute(relative) || !relative || /[\\\x00-\x1f]/.test(relative)) throw new Error('spec_resources_invalid');
  const path = resolve(root, relative);
  if (!path.startsWith(resolve(root) + sep)) throw new Error('spec_resources_invalid');
  plainPath(path);
  if (!existsSync(path)) throw new Error('spec_resources_missing');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 65536) throw new Error('spec_resources_invalid');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  if (!text.trim()) throw new Error('spec_resources_invalid');
  return text;
}

export function loadSpec(mode) {
  validateSpecMode(mode);
  try {
    const root = join(specsRoot, mode);
    const definition = JSON.parse(resource(root, 'definition.json'));
    if (definition.schema !== 'gidd.spec-definition/v1' || definition.id !== mode ||
        definition.version !== 1 || !Array.isArray(definition.helpers) || !definition.helpers.length ||
        new Set(definition.helpers).size !== definition.helpers.length ||
        definition.helpers.some(id => !Object.hasOwn(specHelpers, id))) throw new Error('spec_resources_invalid');
    const prompts = {}, templates = {};
    for (const lang of ['zh-CN', 'en']) {
      if (typeof definition.title?.[lang] !== 'string' || !definition.title[lang].trim()) throw new Error('spec_resources_invalid');
      prompts[lang] = resource(root, definition.prompts?.[lang]);
      templates[lang] = resource(root, definition.templates?.issue?.[lang]);
    }
    return { definition, prompts, templates };
  } catch (error) {
    throw new Error(error.message === 'spec_resources_missing' ? error.message : 'spec_resources_invalid');
  }
}

export function inspectSpec(mode, repository, configurationReady = true) {
  const modeCheck = { id: 'config.spec.mode', status: 'ready' };
  const resourceCheck = { id: 'spec.resources', status: 'not_checked',
    reason: 'dependency_unavailable', blocked_by: modeCheck.id };
  const checks = [modeCheck, resourceCheck];
  if (!configurationReady) {
    Object.assign(modeCheck, { status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config_file' });
    return { checks };
  }
  if (!specModes.includes(mode)) {
    Object.assign(modeCheck, { status: mode === undefined ? 'missing' : 'invalid',
      reason: mode === undefined ? 'spec_mode_missing' : 'spec_mode_unsupported',
      details: { available_modes: [...specModes] },
      hint: 'Select a supported spec with config set spec.mode. Available modes: ' + specModes.join(', ') + '.',
      commands: specModes.map(value => ({ executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'),
        args: ['config', 'set', 'spec.mode', value] })) });
    return { checks };
  }
  modeCheck.details = { configured: mode };
  try {
    const spec = loadSpec(mode);
    Object.assign(resourceCheck, { status: 'ready', details: { mode, version: spec.definition.version } });
    delete resourceCheck.reason; delete resourceCheck.blocked_by;
    return { checks, spec };
  } catch (error) {
    Object.assign(resourceCheck, { status: 'invalid', reason: error.message,
      hint: 'Restore or reinstall this GIDD skill including its specs directory, then rerun doctor. Changing mode does not repair damaged resources.',
      details: { mode, path: join(specsRoot, mode) } });
    delete resourceCheck.blocked_by;
    return { checks };
  }
}
