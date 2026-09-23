import { lstatSync, readFileSync } from 'node:fs';
import { skillPath } from '../../shared/paths.mjs';

export const catalogPath = skillPath('references/doctor.toml');
const reportKeys = ['needs_attention', 'local_ready', 'checks_passed', 'checks_incomplete', 'online_incomplete', 'warning', 'offline', 'push'];
const languages = ['en', 'zh-CN'];
const translatedKeys = key => languages.map(lang => key + '.' + lang);
const placeholders = new Set(['id', 'reason', 'blocked_by', 'config_key', 'configured', 'repository']);
const string = String.raw`(?:"(?:[^"\\\x00-\x1f]|\\(?:["\\btnfr]|u[0-9a-fA-F]{4}))*"|'[^'\x00-\x1f]*')`;
const decode = value => value.startsWith("'") ? value.slice(1, -1) : JSON.parse(value);
const fail = (reason, line) => { throw new Error('doctor_catalog_' + reason + (line ? ':' + line : '')); };

// Deliberately small TOML schema: tables, single-line strings, string arrays,
// booleans and schema_version. Reject unsupported syntax rather than guessing.
function valueOf(source, line) {
  const scalar = new RegExp('^(' + string + '|true|false|1)\\s*(?:#.*)?$').exec(source);
  if (scalar) return scalar[1] === 'true' ? true : scalar[1] === 'false' ? false : scalar[1] === '1' ? 1 : decode(scalar[1]);
  if (!source.startsWith('[')) fail('invalid_syntax', line);
  const values = [];
  let rest = source.slice(1).trimStart();
  while (!rest.startsWith(']')) {
    const match = new RegExp('^(' + string + ')\\s*').exec(rest);
    if (!match) fail('invalid_syntax', line);
    values.push(decode(match[1])); rest = rest.slice(match[0].length);
    if (rest.startsWith(']')) break;
    if (!rest.startsWith(',')) fail('invalid_syntax', line);
    rest = rest.slice(1).trimStart();
  }
  if (!/^\]\s*(?:#.*)?$/.test(rest)) fail('invalid_syntax', line);
  return values;
}

function validateTemplate(value, allowed = placeholders) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_text');
  // Only named, known placeholders are allowed; never interpolate raw tool output.
  const rest = value.replace(/\{([a-z_]+)\}/g, (match, key) => {
    if (!allowed.has(key)) fail('unknown_placeholder');
    return '';
  });
  if (/[{}]/.test(rest)) fail('invalid_placeholder');
}
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);

export function parseCatalog(text, ids) {
  if (Buffer.byteLength(text) > 131072) fail('too_large');
  const catalog = { checks: new Map(), reasons: new Map(), commands: new Map(), report: {}, defaults: {} };
  const sections = new Set();
  let current, schema = false;
  for (const [offset, input] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = offset + 1, source = input.trim();
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(input)) fail('invalid_syntax', line);
    if (!source || source.startsWith('#')) continue;
    const section = /^\[(report|defaults|commands\."([a-z][a-z0-9_]*)"|reasons\."([a-z][a-z0-9_]*(?:\*)?)"|checks\."([a-z][a-z0-9_.]*)"(?:\.reasons\."([a-z][a-z0-9_]*(?:\*)?)")?)\]\s*(?:#.*)?$/.exec(source);
    if (section) {
      if (sections.has(section[1])) fail('duplicate_table', line);
      sections.add(section[1]);
      if (section[4]) {
        const id = section[4];
        if (!ids.has(id)) fail('unknown_check', line);
        if (!catalog.checks.has(id)) catalog.checks.set(id, { reasons: new Map() });
        current = catalog.checks.get(id);
        if (section[5]) { const rule = {}; current.reasons.set(section[5], rule); current = rule; }
      } else if (section[2] || section[3]) {
        current = {}; (section[2] ? catalog.commands : catalog.reasons).set(section[2] || section[3], current);
      } else current = catalog[section[1]];
      continue;
    }
    // Dotted text keys are standard TOML, stored flat here for rule merging.
    const assignment = /^([a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*)\s*=\s*(.*)$/.exec(source);
    if (!assignment) fail('invalid_syntax', line);
    const [, key, raw] = assignment, value = valueOf(raw, line);
    if (!current) {
      if (key !== 'schema_version' || value !== 1 || schema) fail('invalid_schema', line);
      schema = true;
    } else {
      if (Object.hasOwn(current, key)) fail('duplicate_key', line);
      current[key] = value;
    }
  }
  if (!schema) fail('invalid_schema');
  const validateTranslation = (rule, key, allowed = placeholders) => {
    for (const field of translatedKeys(key)) {
      if (!Object.hasOwn(rule, field)) fail('missing_translation');
      validateTemplate(rule[field], allowed);
    }
    const parameters = text => [...new Set(text.match(/\{[a-z_]+\}/g) || [])].sort().join(',');
    if (parameters(rule[key + '.en']) !== parameters(rule[key + '.zh-CN'])) fail('translation_placeholders_mismatch');
  };
  const validateRule = (rule, fields) => {
    if (Object.keys(rule).some(key => !fields.includes(key))) fail('unknown_field');
    if (translatedKeys('hint').some(key => Object.hasOwn(rule, key))) validateTranslation(rule, 'hint');
    if (Object.hasOwn(rule, 'commands') && (!strings(rule.commands) || rule.commands.some(name => !catalog.commands.has(name)))) fail('unknown_command');
  };
  const ruleFields = [...translatedKeys('hint'), 'commands'];
  validateRule(catalog.defaults, ruleFields);
  if (!catalog.defaults['hint.en']) fail('missing_hint');
  for (const rule of catalog.reasons.values()) validateRule(rule, ruleFields);
  for (const [id, check] of catalog.checks) {
    const notes = id === 'config.git.credential.mode' ? ['notes.gh', 'notes.inherit'] : [];
    validateRule(check, ['enabled', ...ruleFields, 'reasons', ...notes.flatMap(translatedKeys)]);
    if (typeof check.enabled !== 'boolean') fail('invalid_enabled');
    for (const key of notes) {
      if (translatedKeys(key).some(field => Object.hasOwn(check, field))) validateTranslation(check, key, new Set());
    }
    for (const rule of check.reasons.values()) validateRule(rule, ruleFields);
  }
  for (const command of catalog.commands.values()) {
    if (Object.keys(command).some(key => !['executable', 'args', 'required_inputs', 'requires_configuration_review'].includes(key))) fail('unknown_field');
    if (!['link', 'ensure', 'git'].includes(command.executable) || !strings(command.args)) fail('invalid_command');
    if (command.required_inputs !== undefined && !strings(command.required_inputs)) fail('invalid_command');
    if (command.requires_configuration_review !== undefined && typeof command.requires_configuration_review !== 'boolean') fail('invalid_command');
    for (const value of [...command.args, ...(command.required_inputs || [])]) validateTemplate(value);
  }
  if (Object.keys(catalog.report).some(key => !reportKeys.flatMap(translatedKeys).includes(key))) fail('unknown_field');
  for (const key of reportKeys) validateTranslation(catalog.report, key, new Set());
  // These messages describe scheduler states, including checks absent from TOML.
  for (const key of ['offline', 'disabled', 'not_declared', 'dependency_unavailable']) {
    if (!catalog.reasons.get(key)?.['hint.en']) fail('missing_hint');
  }
  return catalog;
}

export function loadCatalog(ids, path = catalogPath) {
  let text;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) fail('not_a_file');
    if (stat.size > 131072) fail('too_large');
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    if (error.message.startsWith('doctor_catalog_')) throw error;
    fail(error.code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  return parseCatalog(text, ids);
}

export function reasonRule(rules, reason = '') {
  if (rules.has(reason)) return rules.get(reason);
  // Prefixes cover parameterized error codes; the longest prefix wins.
  const key = [...rules.keys()].filter(key => key.endsWith('*') && reason.startsWith(key.slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
  return rules.get(key);
}

export function render(text, values) {
  return text.replace(/\{([a-z_]+)\}/g, (_, key) => values[key] ?? '');
}
