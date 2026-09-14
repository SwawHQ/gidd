import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainPath } from './storage.mjs';
import { validateIssueRules, validateIssueTemplate } from './issue-check.mjs';

// Only shipped modes are selectable. Mode names never become arbitrary paths.
export const specModes = Object.freeze(['issue-direct']);
const skillRoot = fileURLToPath(new URL('../', import.meta.url));
export function validateSpecMode(mode) {
  if (!/^[a-z][a-z0-9-]*$/.test(mode || '') || mode === 'current' || !specModes.includes(mode)) throw new Error('spec_mode_unsupported');
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
    const root = join(skillRoot, `spec.${mode}`);
    const definition = JSON.parse(resource(root, 'definition.json'));
    if (definition.schema !== 'gidd.spec-definition/v1' || definition.id !== mode ||
        definition.version !== 1) throw new Error('spec_resources_invalid');
    const issueRules = validateIssueRules(JSON.parse(resource(root, definition.checks?.issue)));
    const prompts = {}, templates = {};
    for (const lang of ['zh-CN', 'en']) {
      if (typeof definition.title?.[lang] !== 'string' || !definition.title[lang].trim()) throw new Error('spec_resources_invalid');
      prompts[lang] = resource(root, definition.prompts?.[lang]);
      templates[lang] = resource(root, definition.templates?.issue?.[lang]);
      validateIssueTemplate(templates[lang], issueRules, lang);
    }
    return { definition, prompts, templates, issueRules };
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
      hint: `Restore or reinstall this GIDD skill including its spec.${mode} directory, then rerun doctor. Changing mode does not repair damaged resources.`,
      details: { mode, path: join(skillRoot, `spec.${mode}`) } });
    delete resourceCheck.blocked_by;
    return { checks };
  }
}
