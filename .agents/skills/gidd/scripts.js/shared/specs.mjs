import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { skillPath } from './paths.mjs';
import { plainPath } from './storage.mjs';
import { fields, nonemptyText, specLanguages, validateIssueForms } from './spec-data.mjs';
import { readSpecToml, readSpecResource, specIssueTemplatePath, specFailure } from './spec-resources.mjs';
import { authorizationKeys, modeNames, modeDirectoryPattern, modePlan, parseSpecName, presetNamePattern, stepFiles } from './spec-modes.mjs';

export const specRoot = skillPath('specs/');
export const specSelectionHint = 'Run gidd.link spec.modes, then gidd.link spec.list <mode-id>. Read gidd.link spec <mode-id>/<name> before selecting it with gidd.link set spec.current <mode-id>/<name>.';
export const specCatalogHint = 'Repair the mode description.toml, preset authorization, or referenced TOML/Issue templates, then rerun the command.';
const fail = (reason, path, field) => { throw specFailure(reason, path, field); };
const shape = (value, required, optional, reason, path) => {
  try { fields(value, required, optional); } catch { fail(reason, path); }
};
const modeTranslations = (value, path) => {
  for (const lang of specLanguages) {
    shape(value[lang], ['description'], [], 'spec_translation_invalid', path);
    if (typeof value[lang].description !== 'string' || /[\r\n]/.test(value[lang].description)) fail('spec_translation_invalid', path, lang);
  }
};

// Inspect directory names only: incomplete descriptions in other modes remain isolated.
export function discoverModes(root = specRoot) {
  let entries;
  try { plainPath(root); entries = readdirSync(root, { withFileTypes: true }); }
  catch { fail('spec_directory_invalid', root); }
  const modes = [];
  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.') || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const match = modeDirectoryPattern.exec(entry.name);
    if (!match) fail('spec_mode_directory_invalid', join(root, entry.name));
    modes.push({ id: match[1], name: match[2], directory: entry.name });
  }
  modes.sort((a, b) => a.directory.localeCompare(b.directory, 'en'));
  for (const field of ['id', 'name']) {
    const groups = new Map();
    for (const mode of modes) groups.set(mode[field], [...(groups.get(mode[field]) || []), mode.directory]);
    const conflicts = [...groups].filter(([, directories]) => directories.length > 1)
      .map(([value, directories]) => ({ [field]: value, directories }));
    if (conflicts.length) throw Object.assign(specFailure('spec_mode_' + field + '_conflict', root, field), { conflicts });
  }
  return modes;
}

export function loadMode(selector, root = specRoot, catalog = discoverModes(root)) {
  const entry = catalog.find(mode => [mode.id, mode.name, mode.directory].includes(selector));
  if (!entry) fail('spec_mode_missing', root, selector);
  const plan = modePlan(entry.name), path = join(root, entry.directory, 'description.toml');
  const data = readSpecToml(path);
  shape(data, ['authorization_schema', ...specLanguages, ...(plan.issue ? ['issue_template'] : [])], [], 'spec_mode_invalid', path);
  shape(data.authorization_schema, authorizationKeys, [], 'spec_schema_invalid', path);
  for (const key of authorizationKeys) {
    const values = data.authorization_schema[key], applicable = plan.applicable.has(key);
    // A schema may narrow an applicable stage to auto or ask, but cannot add or skip stages.
    if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length ||
        values.some(value => !(applicable ? ['auto', 'ask'] : ['not_applicable']).includes(value))) fail('spec_schema_invalid', path, key);
  }
  modeTranslations(data, path);
  if (plan.issue) {
    shape(data.issue_template, specLanguages, [], 'spec_issue_template_invalid', path);
    for (const ref of Object.values(data.issue_template)) specIssueTemplatePath(root, path, ref);
  }
  return { ...plan, ...entry, path, ...data };
}

function specFiles(mode, root) {
  const directory = join(root, mode);
  try {
    plainPath(directory);
    return readdirSync(directory).sort().filter(name => name.endsWith('.toml') && name !== 'description.toml' && !name.startsWith('_'));
  } catch { fail('spec_directory_invalid', directory); }
}

// A numeric shorthand matches filenames, never list position or availability.
function resolvePresetName(mode, name, root) {
  if (!/^[0-9]{2}$/.test(name)) return name;
  const matches = specFiles(mode, root).map(file => file.slice(0, -5))
    .filter(candidate => candidate.startsWith(name + '.') && presetNamePattern.test(candidate));
  if (matches.length !== 1) fail(matches.length ? 'spec_number_ambiguous' : 'spec_number_missing', join(root, mode), name);
  return matches[0];
}

// Read exactly the selected mode/preset: unrelated drafts cannot block it.
export function readSpec(selector, root = specRoot, catalog) {
  const parsed = parseSpecName(selector), definition = loadMode(parsed.mode, root, catalog);
  const name = resolvePresetName(definition.directory, parsed.name, root);
  const path = join(root, definition.directory, name + '.toml'), data = readSpecToml(path);
  shape(data, ['authorization'], [], 'spec_authorization_invalid', path);
  shape(data.authorization, authorizationKeys, [], 'spec_authorization_invalid', path);
  for (const key of authorizationKeys) {
    if (!definition.authorization_schema[key].includes(data.authorization[key])) fail('spec_authorization_invalid', path, key);
  }
  return { selector: definition.directory + '/' + name, mode: definition.name, name, path, definition, authorization: data.authorization };
}

export function loadIssueForms(spec, root = specRoot) {
  if (!spec.definition.issue) return undefined;
  const forms = {};
  for (const lang of specLanguages) {
    const path = specIssueTemplatePath(root, spec.definition.path, spec.definition.issue_template[lang]);
    const text = readSpecResource(path);
    try { forms[lang] = JSON.parse(text); } catch { fail('spec_issue_template_invalid', path); }
  }
  try { return validateIssueForms(forms); } catch { fail('spec_issue_template_invalid', spec.definition.path); }
}

export function matchesMode(pattern, mode) {
  // Only '*' is special, including across dots. No regex/glob evaluation.
  const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + expression + '$').test(mode);
}

function loadExperience(step, mode, root) {
  const path = resolve(root, '../references/workflow', stepFiles[step]);
  const data = readSpecToml(path);
  shape(data, specLanguages, [], 'spec_translation_invalid', path);
  const selected = {}, patternsByLanguage = [];
  for (const lang of specLanguages) {
    const variants = data[lang];
    if (!variants || typeof variants !== 'object' || Array.isArray(variants)) fail('spec_pattern_invalid', path);
    const patterns = Object.keys(variants);
    if (!patterns.length || patterns.length > 32) fail('spec_pattern_invalid', path);
    for (const pattern of patterns) {
      if (!pattern || pattern.length > 128 || !/^[a-z0-9.*-]+$/.test(pattern) || !modeNames.some(name => matchesMode(pattern, name))) fail('spec_pattern_invalid', path, pattern);
      shape(variants[pattern], ['title', 'body'], [], 'spec_translation_invalid', path);
      const text = variants[pattern];
      if (typeof text.title !== 'string' || /[\r\n]/.test(text.title) || typeof text.body !== 'string') fail('spec_translation_invalid', path);
    }
    if (modeNames.some(name => patterns.filter(pattern => matchesMode(pattern, name)).length > 1)) fail('spec_pattern_ambiguous', path);
    const matching = patterns.filter(pattern => matchesMode(pattern, mode));
    if (!matching.length) fail('spec_pattern_missing', path, mode);
    selected[lang] = variants[matching[0]];
    patternsByLanguage.push(patterns.sort());
  }
  if (JSON.stringify(patternsByLanguage[0]) !== JSON.stringify(patternsByLanguage[1])) fail('spec_pattern_mismatch', path);
  return { step, path, ...selected };
}

export function loadSpec(selector, root = specRoot, catalog) {
  const spec = readSpec(selector, root, catalog), { definition } = spec;
  spec.issueForms = loadIssueForms(spec, root);
  spec.experiences = ['common', ...definition.flow, ...definition.errors].map(step => loadExperience(step, spec.mode, root));
  const size = spec.experiences.reduce((total, item) => total + specLanguages.reduce((sum, lang) => sum + Buffer.byteLength(item[lang].body), 0), 0);
  if (size > 262144) fail('spec_resources_too_large', spec.path);
  spec.available_languages = specLanguages.filter(lang => nonemptyText(definition[lang].description) &&
    spec.experiences.every(item => nonemptyText(item[lang].title) && nonemptyText(item[lang].body)));
  return spec;
}

export function requireSpecLanguage(spec, lang) {
  if (!specLanguages.includes(lang)) fail('spec_language_unavailable', spec.path, lang);
  if (!nonemptyText(spec.definition[lang].description)) fail('spec_language_unavailable', spec.definition.path, lang);
  for (const item of spec.experiences) {
    if (!nonemptyText(item[lang].title) || !nonemptyText(item[lang].body)) fail('spec_language_unavailable', item.path, lang);
  }
}

export function validateSpecName(selector) {
  const spec = loadSpec(selector);
  if (!spec.available_languages.length) fail('spec_language_unavailable', spec.path);
}

export function listSpecs(mode, root = specRoot, catalog = discoverModes(root)) {
  const definition = loadMode(mode, root, catalog);
  return specFiles(definition.directory, root).map(file => {
    const name = file.slice(0, -5), selector = definition.directory + '/' + name;
    try {
      if (!presetNamePattern.test(name)) fail('spec_current_unsupported');
      const spec = loadSpec(selector, root, catalog);
      return { name, authorization: spec.authorization,
        ...(!spec.available_languages.length ? { error: 'spec_language_unavailable' } : {}) };
    } catch (error) { return { name, error: error.message }; }
  });
}

export function listModes(lang = 'zh-CN', root = specRoot) {
  const catalog = discoverModes(root);
  return catalog.map(({ directory }) => {
    try {
      const mode = loadMode(directory, root, catalog), specs = listSpecs(directory, root, catalog);
      return { name: directory, description: mode[lang].description, specs: specs.filter(item => !item.error).length };
    } catch (error) { return { name: directory, specs: 0, error: error.message }; }
  });
}
