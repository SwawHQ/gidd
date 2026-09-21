import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainPath } from './storage.mjs';
import { specLanguages, validateIssueForms } from './spec-data.mjs';
import { expandSpecPrompt, readSpecPrompt, readSpecResource, specResourcePath } from './spec-resources.mjs';

export const specRoot = fileURLToPath(new URL('../specs/', import.meta.url));
export const specNamePattern = /^(?:[0-9]{2}\.)?[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
export const specSelectionHint = 'Run gidd.link spec.list to see names and summaries, then gidd.link spec <name> to read the full instructions before selecting one with gidd.link set spec.current <name>.';
export const specCatalogHint = 'Repair specs/<name>/prompt.en.md and prompt.zh-CN.md, including their front matter, then rerun doctor.';

function promptsAt(root, name) {
  const prompts = Object.fromEntries(specLanguages.map(lang => [lang, readSpecPrompt(join(root, name, 'prompt.' + lang + '.md'))]));
  if (Object.hasOwn(prompts.en.metadata, 'issue_template') !== Object.hasOwn(prompts['zh-CN'].metadata, 'issue_template') ||
      JSON.stringify(prompts.en.metadata.description) !== JSON.stringify(prompts['zh-CN'].metadata.description)) throw new Error('spec_metadata_mismatch');
  for (const prompt of Object.values(prompts)) {
    if (prompt.metadata.issue_template) specResourcePath(root, prompt.path, prompt.metadata.issue_template);
  }
  return prompts;
}

export function loadSpecCatalog(root = specRoot) {
  let directories;
  try { plainPath(root); directories = readdirSync(root).sort(); }
  catch { throw new Error('spec_directory_invalid'); }
  const catalogs = Object.fromEntries(specLanguages.map(lang => [lang, []]));
  for (const name of directories) {
    if (name.startsWith('_')) continue;
    const path = join(root, name);
    try {
      plainPath(path);
      if (!lstatSync(path).isDirectory()) continue;
      if (!specNamePattern.test(name)) throw new Error();
    } catch { throw new Error('spec_directory_invalid'); }
    // Empty placeholders are not selectable. Once either prompt exists, both
    // translations and their metadata must be valid.
    if (!specLanguages.some(lang => existsSync(join(path, 'prompt.' + lang + '.md')))) continue;
    const prompts = promptsAt(root, name);
    for (const lang of specLanguages) catalogs[lang].push({ name, description: prompts[lang].metadata.description });
  }
  if (!catalogs.en.length) throw new Error('spec_list_empty');
  return catalogs;
}

export function validateSpecName(name, catalog = loadSpecCatalog()) {
  if (!catalog.en.some(spec => spec.name === name)) throw new Error('spec_current_unsupported');
}

export function loadSpec(mode, catalog = loadSpecCatalog(), root = specRoot) {
  validateSpecName(mode, catalog);
  const entries = promptsAt(root, mode), prompts = {}, forms = {};
  for (const lang of specLanguages) {
    const prompt = entries[lang];
    prompts[lang] = { path: prompt.path, content: expandSpecPrompt(root, prompt) };
    if (prompt.metadata.issue_template) {
      const path = specResourcePath(root, prompt.path, prompt.metadata.issue_template);
      if (!path.toLowerCase().endsWith('.json')) throw new Error('spec_resources_invalid');
      const text = readSpecResource(path);
      try { forms[lang] = JSON.parse(text); } catch { throw new Error('spec_resources_invalid'); }
    }
  }
  return { prompts, issueForms: Object.keys(forms).length ? validateIssueForms(forms) : undefined };
}

export function inspectSpec(mode, repository, configurationReady = true) {
  const modeCheck = { id: 'config.spec.current', status: 'ready' }, checks = [modeCheck];
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
      details: { available_names: names }, hint: specSelectionHint,
      commands: [
        { executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'), args: ['spec.list'] },
        { executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'), args: ['spec', '<name>'], required_inputs: ['spec.current'] },
        { executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'), args: ['set', 'spec.current', '<name>'], required_inputs: ['spec.current'] },
      ] });
    return { checks };
  }
  modeCheck.details = { configured: mode };
  try { return { checks, spec: loadSpec(mode, catalog) }; }
  catch (error) {
    Object.assign(modeCheck, { status: 'invalid', reason: error.message,
      hint: 'Repair specs/' + mode + '/ and its referenced Markdown and Issue templates, then rerun doctor.',
      details: { configured: mode, path: join(specRoot, mode) } });
    return { checks };
  }
}
