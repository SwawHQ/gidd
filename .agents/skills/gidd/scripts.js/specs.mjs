import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainPath } from './storage.mjs';
import { parseSpecYaml, specLanguages, validateIssueForms } from './spec-data.mjs';

// Only shipped modes are selectable. Mode names never become arbitrary paths.
export const specModes = Object.freeze(['issue-direct']);
const skillRoot = fileURLToPath(new URL('../', import.meta.url));
export function validateSpecMode(mode) {
  if (!/^[a-z][a-z0-9-]*$/.test(mode || '') || mode === 'current' || !specModes.includes(mode)) throw new Error('spec_mode_unsupported');
}

// Names are fixed below; resource files must remain plain files within the skill.
function resource(root, name) {
  const path = join(root, name);
  plainPath(path);
  if (!existsSync(path)) throw new Error('spec_resources_missing');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 65536) throw new Error('spec_resources_invalid');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  if (!text.trim() || text.includes('\0')) throw new Error('spec_resources_invalid');
  return text;
}

export function loadSpec(mode) {
  validateSpecMode(mode);
  try {
    const root = join(skillRoot, `spec.${mode}`);
    const issueForms = validateIssueForms(Object.fromEntries(specLanguages.map(lang =>
      [lang, parseSpecYaml(resource(root, `issue.${lang}.yaml`))])));
    const prompts = {};
    for (const lang of specLanguages) {
      const name = `prompt.${lang}.md`;
      prompts[lang] = { path: join(root, name), content: resource(root, name) };
    }
    return { prompts, issueForms };
  } catch (error) {
    throw new Error(error.message === 'spec_resources_missing' ? error.message : 'spec_resources_invalid');
  }
}

export function inspectSpec(mode, repository, configurationReady = true) {
  const modeCheck = { id: 'config.spec.mode', status: 'ready' };
  const checks = [modeCheck];
  if (!configurationReady) {
    Object.assign(modeCheck, { status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' });
    return { checks };
  }
  if (!specModes.includes(mode)) {
    Object.assign(modeCheck, { status: mode === undefined ? 'missing' : 'invalid',
      reason: mode === undefined ? 'spec_mode_missing' : 'spec_mode_unsupported',
      details: { available_modes: [...specModes] },
      hint: 'Select a supported spec with gidd.link set spec.mode <mode>. Available modes: ' + specModes.join(', ') + '.',
      commands: specModes.map(value => ({ executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'),
        args: ['set', 'spec.mode', value] })) });
    return { checks };
  }
  modeCheck.details = { configured: mode };
  try {
    const spec = loadSpec(mode);
    return { checks, spec };
  } catch (error) {
    Object.assign(modeCheck, { status: 'invalid', reason: error.message,
      hint: `Restore or reinstall this GIDD skill including its spec.${mode} directory, then rerun doctor. Changing mode does not repair damaged resources.`,
      details: { configured: mode, path: join(skillRoot, `spec.${mode}`) } });
    return { checks };
  }
}
