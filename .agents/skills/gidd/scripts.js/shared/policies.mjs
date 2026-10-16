import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { skillPath } from './paths.mjs';
import { plainPath } from './storage.mjs';
import { fields, nonemptyText, policyLanguages, validateIssueForms } from './policy-data.mjs';
import { readPolicyToml, readPolicyResource, policyIssueTemplatePath, policyFailure } from './policy-resources.mjs';
import { authorizationKeys, deliveryModeNames, deliveryModeDirectoryPattern, deliveryModePlan, parsePolicySelector, presetNamePattern, stepFiles, validPolicySnapshot } from './policy-definition.mjs';
import { diagnostic } from './diagnostics.mjs';

export const policyRoot = skillPath('policies/');
export const policySelectionHint = 'Run gidd policy.deliveries and policy.list <mode-id>. Read policy <mode-id>/<name>, then bind it with gidd <Issue编号> --policy <mode-id>/<name>.';
export const policyCatalogHint = 'Repair the mode description.toml, preset authorization, or referenced TOML/Issue templates, then rerun the command.';
const fail = (reason, path, field) => { throw policyFailure(reason, path, field); };
const shape = (value, required, optional, reason, path) => {
  try { fields(value, required, optional); } catch { fail(reason, path); }
};
const modeTranslations = (value, path) => {
  for (const lang of policyLanguages) {
    shape(value[lang], ['description'], [], 'policy_translation_invalid', path);
    if (typeof value[lang].description !== 'string' || /[\r\n]/.test(value[lang].description)) fail('policy_translation_invalid', path, lang);
  }
};

// Inspect directory names only: incomplete descriptions in other modes remain isolated.
export function discoverDeliveryModes(root = policyRoot) {
  let entries;
  try { plainPath(root); entries = readdirSync(root, { withFileTypes: true }); }
  catch { fail('policy_directory_invalid', root); }
  const modes = [];
  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.') || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const match = deliveryModeDirectoryPattern.exec(entry.name);
    if (!match) fail('policy_mode_directory_invalid', join(root, entry.name));
    modes.push({ id: match[1], name: match[2], directory: entry.name });
  }
  modes.sort((a, b) => a.directory.localeCompare(b.directory, 'en'));
  for (const field of ['id', 'name']) {
    const groups = new Map();
    for (const mode of modes) groups.set(mode[field], [...(groups.get(mode[field]) || []), mode.directory]);
    const conflicts = [...groups].filter(([, directories]) => directories.length > 1)
      .map(([value, directories]) => ({ [field]: value, directories }));
    if (conflicts.length) throw Object.assign(policyFailure('policy_mode_' + field + '_conflict', root, field), { conflicts });
  }
  return modes;
}

export function loadDeliveryMode(selector, root = policyRoot, catalog = discoverDeliveryModes(root)) {
  const entry = catalog.find(mode => [mode.id, mode.name, mode.directory].includes(selector));
  if (!entry) fail('policy_mode_missing', root, selector);
  const plan = deliveryModePlan(entry.name), path = join(root, entry.directory, 'description.toml');
  const data = readPolicyToml(path);
  shape(data, ['authorization_schema', ...policyLanguages, 'issue_template'], [], 'policy_mode_invalid', path);
  shape(data.authorization_schema, authorizationKeys, [], 'policy_schema_invalid', path);
  for (const key of authorizationKeys) {
    const values = data.authorization_schema[key], applicable = plan.applicable.has(key);
    // A schema may narrow an applicable stage to auto or ask, but cannot add or skip stages.
    if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length ||
        values.some(value => !(applicable ? ['auto', 'ask'] : ['not_applicable']).includes(value))) fail('policy_schema_invalid', path, key);
  }
  modeTranslations(data, path);
  shape(data.issue_template, policyLanguages, [], 'policy_issue_template_invalid', path);
  for (const ref of Object.values(data.issue_template)) policyIssueTemplatePath(root, path, ref);
  return { ...plan, ...entry, path, ...data };
}

function authorizationPresetFiles(mode, root) {
  const directory = join(root, mode);
  try {
    plainPath(directory);
    return readdirSync(directory).sort().filter(name => name.endsWith('.toml') && name !== 'description.toml' && !name.startsWith('_'));
  } catch { fail('policy_directory_invalid', directory); }
}

// A numeric shorthand matches filenames, never list position or availability.
function resolvePresetName(mode, name, root) {
  if (!/^[0-9]{2}$/.test(name)) return name;
  const matches = authorizationPresetFiles(mode, root).map(file => file.slice(0, -5))
    .filter(candidate => candidate.startsWith(name + '.') && presetNamePattern.test(candidate));
  if (matches.length !== 1) fail(matches.length ? 'policy_number_ambiguous' : 'policy_number_missing', join(root, mode), name);
  return matches[0];
}

// Read exactly the selected mode/preset: unrelated drafts cannot block it.
export function readPolicy(selector, root = policyRoot, catalog) {
  const parsed = parsePolicySelector(selector), definition = loadDeliveryMode(parsed.mode, root, catalog);
  const name = resolvePresetName(definition.directory, parsed.name, root);
  const path = join(root, definition.directory, name + '.toml'), data = readPolicyToml(path);
  shape(data, ['authorization'], [], 'policy_authorization_invalid', path);
  shape(data.authorization, authorizationKeys, [], 'policy_authorization_invalid', path);
  for (const key of authorizationKeys) {
    if (!definition.authorization_schema[key].includes(data.authorization[key])) fail('policy_authorization_invalid', path, key);
  }
  return { selector: definition.directory + '/' + name, mode: definition.name, name, path, definition, authorization: data.authorization };
}

export function loadIssueForms(policy, root = policyRoot) {
  const forms = {};
  for (const lang of policyLanguages) {
    const path = policyIssueTemplatePath(root, policy.definition.path, policy.definition.issue_template[lang]);
    const text = readPolicyResource(path);
    try { forms[lang] = JSON.parse(text); } catch { fail('policy_issue_template_invalid', path); }
  }
  try { return validateIssueForms(forms); } catch { fail('policy_issue_template_invalid', policy.definition.path); }
}

export function matchesDeliveryMode(pattern, mode) {
  // Only '*' is special, including across dots. No regex/glob evaluation.
  const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + expression + '$').test(mode);
}

function loadStepReference(step, mode, root) {
  const path = resolve(root, '../references/steps', stepFiles[step]);
  if (!existsSync(path)) return null;
  const data = readPolicyToml(path);
  shape(data, policyLanguages, [], 'policy_translation_invalid', path);
  const selected = {}, patternsByLanguage = [];
  for (const lang of policyLanguages) {
    const variants = data[lang];
    if (!variants || typeof variants !== 'object' || Array.isArray(variants)) fail('policy_pattern_invalid', path);
    const patterns = Object.keys(variants);
    if (!patterns.length || patterns.length > 32) fail('policy_pattern_invalid', path);
    for (const pattern of patterns) {
      if (!pattern || pattern.length > 128 || !/^[a-z0-9.*-]+$/.test(pattern) || !deliveryModeNames.some(name => matchesDeliveryMode(pattern, name))) fail('policy_pattern_invalid', path, pattern);
      shape(variants[pattern], ['title', 'body'], [], 'policy_translation_invalid', path);
      const text = variants[pattern];
      if (typeof text.title !== 'string' || /[\r\n]/.test(text.title) || typeof text.body !== 'string') fail('policy_translation_invalid', path);
    }
    if (deliveryModeNames.some(name => patterns.filter(pattern => matchesDeliveryMode(pattern, name)).length > 1)) fail('policy_pattern_ambiguous', path);
    const matching = patterns.filter(pattern => matchesDeliveryMode(pattern, mode));
    if (!matching.length) fail('policy_pattern_missing', path, mode);
    selected[lang] = variants[matching[0]];
    patternsByLanguage.push(patterns.sort());
  }
  if (JSON.stringify(patternsByLanguage[0]) !== JSON.stringify(patternsByLanguage[1])) fail('policy_pattern_mismatch', path);
  return { step, path, ...selected };
}

export function loadPolicy(selector, root = policyRoot, catalog) {
  return loadPolicyResources(readPolicy(selector, root, catalog), root);
}

export function loadSavedPolicy(saved, path, root = policyRoot) {
  if (!validPolicySnapshot(saved)) fail('task_invalid', path);
  const definition = loadDeliveryMode(saved.mode, root);
  return loadPolicyResources({ ...saved, path, definition }, root);
}

function loadPolicyResources(policy, root) {
  const { definition } = policy;
  policy.issueForms = loadIssueForms(policy, root);
  policy.stepReferences = ['common', ...definition.steps, ...definition.errors].map(step => loadStepReference(step, policy.mode, root)).filter(Boolean);
  const size = policy.stepReferences.reduce((total, item) => total + policyLanguages.reduce((sum, lang) => sum + Buffer.byteLength(item[lang].body), 0), 0);
  if (size > 262144) fail('policy_resources_too_large', policy.path);
  policy.available_languages = policyLanguages.filter(lang => nonemptyText(definition[lang].description) &&
    policy.stepReferences.every(item => !nonemptyText(item[lang].body) || nonemptyText(item[lang].title)));
  return policy;
}

export function requirePolicyLanguage(policy, lang) {
  if (!policyLanguages.includes(lang)) fail('policy_language_unavailable', policy.path, lang);
  if (!nonemptyText(policy.definition[lang].description)) fail('policy_language_unavailable', policy.definition.path, lang);
  for (const item of policy.stepReferences) {
    if (nonemptyText(item[lang].body) && !nonemptyText(item[lang].title)) fail('policy_language_unavailable', item.path, lang);
  }
}

export function listAuthorizationPresets(mode, root = policyRoot, catalog = discoverDeliveryModes(root)) {
  const definition = loadDeliveryMode(mode, root, catalog);
  return authorizationPresetFiles(definition.directory, root).map(file => {
    const name = file.slice(0, -5), selector = definition.directory + '/' + name;
    try {
      if (!presetNamePattern.test(name)) fail('policy_selector_invalid');
      const policy = loadPolicy(selector, root, catalog);
      return { name, authorization: policy.authorization,
        ...(!policy.available_languages.length ? { details: diagnostic('policy_language_unavailable') } : {}) };
    } catch (error) { return { name, details: diagnostic(error.message) }; }
  });
}

export function listDeliveryModes(lang = 'zh-CN', root = policyRoot) {
  const catalog = discoverDeliveryModes(root);
  return catalog.map(({ directory }) => {
    try {
      const mode = loadDeliveryMode(directory, root, catalog), presets = listAuthorizationPresets(directory, root, catalog);
      return { name: directory, description: mode[lang].description, presets: presets.filter(item => !item.details).length };
    } catch (error) { return { name: directory, presets: 0, details: diagnostic(error.message) }; }
  });
}
