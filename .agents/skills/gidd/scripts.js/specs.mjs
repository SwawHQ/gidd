import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainPath } from './storage.mjs';
import { fields, nonemptyText, parseSpecYaml, specLanguages, validateIssueForms } from './spec-data.mjs';

const skillRoot = fileURLToPath(new URL('../', import.meta.url));
export const specSelectionHint = 'Run gidd.link spec.list to see names and summaries, then gidd.link spec.<name> to read the full instructions before selecting one with gidd.link set spec.current <name>.';
export const specCatalogHint = 'Repair the spec.<name> directories and their bilingual description.json files, then rerun doctor.';

export function loadSpecCatalog() {
  let directories;
  try {
    plainPath(skillRoot);
    directories = readdirSync(skillRoot).filter(name => name.startsWith('spec.')).sort();
  } catch { throw new Error('spec_directory_invalid'); }
  if (!directories.length) throw new Error('spec_list_empty');
  const catalogs = Object.fromEntries(specLanguages.map(lang => [lang, []]));
  for (const directory of directories) {
    const name = directory.slice('spec.'.length), path = join(skillRoot, directory);
    try {
      plainPath(path);
      if (!/^[a-z][a-z0-9-]*$/.test(name) || ['current', 'list'].includes(name) || !lstatSync(path).isDirectory()) throw new Error();
    } catch { throw new Error('spec_directory_invalid'); }
    let descriptions;
    try {
      descriptions = JSON.parse(resource(path, 'description.json'));
      fields(descriptions, specLanguages);
      if (!specLanguages.every(lang => nonemptyText(descriptions[lang]))) throw new Error();
    } catch (error) {
      throw new Error(error.message === 'spec_resources_missing' ? 'spec_description_missing' : 'spec_description_invalid');
    }
    for (const lang of specLanguages) catalogs[lang].push({ name, description: descriptions[lang] });
  }
  return catalogs;
}

export function validateSpecName(name, catalog = loadSpecCatalog()) {
  if (!catalog.en.some(spec => spec.name === name)) throw new Error('spec_current_unsupported');
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

export function loadSpec(mode, catalog = loadSpecCatalog()) {
  validateSpecName(mode, catalog);
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
  const modeCheck = { id: 'config.spec.current', status: 'ready' };
  const checks = [modeCheck];
  if (!configurationReady) {
    Object.assign(modeCheck, { status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' });
    return { checks };
  }
  let catalog;
  try { catalog = loadSpecCatalog(); }
  catch (error) {
    Object.assign(modeCheck, { status: 'invalid', reason: error.message, hint: specCatalogHint });
    return { checks };
  }
  const names = catalog.en.map(spec => spec.name);
  if (!names.includes(mode)) {
    Object.assign(modeCheck, { status: mode === undefined ? 'missing' : 'invalid',
      reason: mode === undefined ? 'spec_current_missing' : 'spec_current_unsupported',
      details: { available_names: names },
      hint: specSelectionHint,
      commands: [
        { executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'), args: ['spec.list'] },
        { executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'), args: ['spec.<name>'], required_inputs: ['spec.current'] },
        { executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'), args: ['set', 'spec.current', '<name>'], required_inputs: ['spec.current'] },
      ] });
    return { checks };
  }
  modeCheck.details = { configured: mode };
  try {
    const spec = loadSpec(mode, catalog);
    return { checks, spec };
  } catch (error) {
    Object.assign(modeCheck, { status: 'invalid', reason: error.message,
      hint: `Restore or reinstall this GIDD skill including its spec.${mode} directory, then rerun doctor. Changing mode does not repair damaged resources.`,
      details: { configured: mode, path: join(skillRoot, `spec.${mode}`) } });
    return { checks };
  }
}
