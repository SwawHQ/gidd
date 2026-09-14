import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseConfiguration } from './storage.mjs';
import { validateSpecMode, specModes } from './specs.mjs';

const fields = new Set(['hostname', 'account', 'remote', 'repository']);
const stringLiteral = String.raw`(?:"(?:[^"\\]|\\["\\])*"|'[^']*')`;
const assignment = new RegExp(`^([ \\t]*)(hostname|account|remote|repository)([ \\t]*=[ \\t]*)(${stringLiteral})([ \\t]*(?:#.*)?)$`);
const decode = literal => literal[0] === "'" ? literal.slice(1, -1) : JSON.parse(literal);
const editableKey = /^(?:github\.(?:hostname|account|remote|repository)|tools\.(?:node|bun|gh)\.source|spec\.mode)$/;
const initialConfiguration = 'schema_version = 1\n\n[github]\nhostname = "github.com"\nremote = "origin"\n';

function validateSetting(key, value) {
  if (!editableKey.test(key || '')) throw new Error('config_unknown_key');
  if (key === 'spec.mode') return validateSpecMode(value);
  if (key.startsWith('github.')) return validateGitHubField(key.slice(7), value);
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('config_invalid_tool_value');
  if (key.endsWith('.source')) {
    let url;
    try { url = new URL(value); } catch { throw new Error('config_invalid_tool_source'); }
    if (!value.startsWith('https://') || /[\s\\]/.test(value) || url.username || url.password || url.search || url.hash) throw new Error('config_invalid_tool_source');
  }
}

function parseTools(text) {
  const lines = text.split('\n'), entries = {};
  let section = '', start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\uFEFF/, '').replace(/\r$/, '');
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const table = /^[ \t]*\[([^\]]+)\][ \t]*(?:#.*)?$/.exec(line);
    if (table) {
      if (section === 'tools') end = i;
      section = table[1];
      if (section === 'tools') {
        if (start !== -1) throw new Error('config_duplicate_tools_table');
        start = i;
      }
      continue;
    }
    if (section !== 'tools') continue;
    const inline = /^([ \t]*(node|bun|gh)[ \t]*=[ \t]*\{)(.*?)(\}[ \t]*(?:#.*)?)$/.exec(line);
    if (!inline) throw new Error('config_invalid_tools_syntax');
    const name = inline[2];
    if (Object.hasOwn(entries, name)) throw new Error('config_duplicate_tool');
    const entry = { index: i, inline, fields: {} };
    const pattern = new RegExp(`(^|,)([ \\t]*)(version|source)([ \\t]*=[ \\t]*)(${stringLiteral})([ \\t]*)(?=,|$)`, 'g');
    let consumed = 0;
    for (const match of inline[3].matchAll(pattern)) {
      if (match.index !== consumed || Object.hasOwn(entry.fields, match[3])) throw new Error('config_invalid_tool_table');
      consumed += match[0].length;
      const offset = match.index + match[1].length + match[2].length + match[3].length + match[4].length;
      entry.fields[match[3]] = { offset, literal: match[5], value: decode(match[5]) };
    }
    if (consumed !== inline[3].length || !entry.fields.source || entry.fields.version) throw new Error('config_invalid_tool_table');
    entries[name] = entry;
  }
  return { lines, start, end, entries };
}

function insertSetting(text, doc, section, setting) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (doc.start === -1) return text + (text.endsWith('\n') ? '' : newline) + newline + `[${section}]` + newline + setting + newline;
  const offset = Math.min(text.length, doc.lines.slice(0, doc.end).reduce((sum, line) => sum + line.length + 1, 0));
  const prefix = text.slice(0, offset);
  return prefix + (prefix.endsWith('\n') ? '' : newline) + setting + newline + text.slice(offset);
}

export function editConfiguration(text, key, value) {
  validateSetting(key, value);
  if (key.startsWith('github.')) return editGitHub(text, key.slice(7), value);
  if (key === 'spec.mode') return editSpec(text, value);
  const doc = parseTools(text), [, name, field] = key.split('.'), entry = doc.entries[name];
  const literal = JSON.stringify(value);
  if (entry) {
    const { offset, literal: previous } = entry.fields[field];
    const content = entry.inline[3];
    const line = entry.inline[1] + content.slice(0, offset) + literal + content.slice(offset + previous.length) + entry.inline[4];
    doc.lines[entry.index] = line + (doc.lines[entry.index].endsWith('\r') ? '\r' : '');
    text = doc.lines.join('\n');
  } else {
    const setting = `${name} = { source = ${literal} }`;
    text = insertSetting(text, doc, 'tools', setting);
  }
  parseGitHub(text, { validate: false });
  if (Buffer.byteLength(text) > 16384) throw new Error('config_too_large');
  return text;
}

export function configPath(repository) {
  if (!repository || !isAbsolute(repository)) throw new Error('repository_must_be_absolute');
  return join(repository, '.agents/skills/gidd/config.toml');
}

function plainPath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('config_reparse_path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}

function readText(path) {
  plainPath(path);
  if (!lstatSync(path).isFile()) throw new Error('config_not_a_file');
  const bytes = readFileSync(path);
  if (bytes.length > 16384) throw new Error('config_too_large');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('config_invalid_utf8'); }
}

export function validateGitHubField(key, value) {
  if (!fields.has(key)) throw new Error('config_unknown_github_field');
  if (key === 'repository') { normalizeRepositoryIdentity(value); return; }
  const patterns = {
    hostname: /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i,
    account: /^[a-z0-9][a-z0-9-]{0,99}$/i,
    remote: /^[a-z0-9][a-z0-9._/-]*$/i,
  };
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value) || !patterns[key].test(value)) throw new Error(`config_invalid_github_${key}`);
}

// Store one transport-independent identity, not a commit, branch or push target.
export function normalizeRepositoryIdentity(value) {
  const match = typeof value === 'string' && /^https:\/\/([^/:@]+)\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/?$/i.exec(value);
  if (!match) throw new Error('config_invalid_github_repository');
  const [, hostname, owner, name] = match;
  try { validateGitHubField('hostname', hostname); }
  catch { throw new Error('config_invalid_github_repository'); }
  if (![owner, name].every(part => part && !['.', '..'].includes(part))) throw new Error('config_invalid_github_repository');
  return `https://${hostname}/${owner}/${name}`.toLowerCase();
}

// The shared JavaScript parser validates the schema; this reader owns GitHub values.
// Keep offsets and literal spelling so editing one field preserves all other text.
export function parseGitHub(text, { validate = true } = {}) {
  const lines = text.split('\n'), github = {}, entries = {};
  let section = '', start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\uFEFF/, '').replace(/\r$/, '');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line)) throw new Error('config_control_character');
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const table = /^[ \t]*\[([^\]]+)\][ \t]*(?:#.*)?$/.exec(line);
    if (table) {
      if (section === 'github') end = i;
      section = table[1];
      if (section === 'github') {
        if (start !== -1) throw new Error('config_duplicate_github_table');
        start = i;
      }
      continue;
    }
    if (section !== 'github') continue;
    const match = assignment.exec(line);
    if (!match) throw new Error('config_invalid_github_syntax');
    const key = match[2];
    if (Object.hasOwn(github, key)) throw new Error(`config_duplicate_github_${key}`);
    github[key] = decode(match[4]); entries[key] = { index: i, match };
    if (validate) validateGitHubField(key, github[key]);
  }
  return { github, entries, lines, start, end };
}

export function readGitHubConfiguration(repository, required) {
  const path = configPath(repository);
  if (!existsSync(path)) throw new Error('config_missing');
  const content = readText(path); parseConfiguration(content);
  const { github } = parseGitHub(content);
  for (const key of required) if (!Object.hasOwn(github, key)) throw new Error(`config_missing_github_${key}`);
  return github;
}

export function configurationHint(reason) {
  if (reason === 'spec_mode_unsupported') return 'Available spec modes: ' + specModes.join(', ') + '. Use config set spec.mode <mode>.';
  if (reason === 'config_invalid_github_repository' || reason === 'config_missing_github_repository') return 'Run gidd.link.cmd doctor --offline, review the repository configuration, then record the canonical HTTPS identity reported by doctor with config set github.repository.';
  const missing = /^config_missing_github_(hostname|account|remote)$/.exec(reason);
  if (missing) return `Set github.${missing[1]} with: gidd.link.cmd config set github.${missing[1]} <value>`;
  if (reason === 'config_missing') return 'Create repository config with: gidd.link.cmd config set github.account <login>';
  if (reason.startsWith('config_retired_field:')) return 'Remove [bootstrap] and all tool version fields from config.toml; bootstrap owns tool version policy.';
  if (reason.startsWith('config_')) return 'Check repository config.toml and use gidd.link.cmd config show/set. No login or configuration fallback was performed.';
  return '';
}

function editSpec(text, value) {
  // Parse first, but allow unsupported mode values to be repaired in place.
  parseConfiguration(text);
  const lines = text.split('\n');
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\uFEFF/, '').replace(/\r$/, '');
    if (/^[ \t]*\[spec\][ \t]*(?:#.*)?$/.test(line)) { start = i; continue; }
    if (start < 0) continue;
    if (/^[ \t]*\[/.test(line)) { end = i; break; }
    const match = new RegExp(`^([ \\t]*mode[ \\t]*=[ \\t]*)(${stringLiteral})([ \\t]*(?:#.*)?)$`).exec(line);
    if (match) {
      lines[i] = match[1] + JSON.stringify(value) + match[3] + (lines[i].endsWith('\r') ? '\r' : '');
      return lines.join('\n');
    }
  }
  return insertSetting(text, { lines, start, end }, 'spec', 'mode = ' + JSON.stringify(value));
}

export function editGitHub(text, key, value) {
  if (key === 'repository') value = normalizeRepositoryIdentity(value);
  validateGitHubField(key, value);
  const doc = parseGitHub(text, { validate: false });
  const literal = JSON.stringify(value);
  if (doc.entries[key]) {
    const { index, match } = doc.entries[key];
    doc.lines[index] = `${match[1]}${key}${match[3]}${literal}${match[5]}${doc.lines[index].endsWith('\r') ? '\r' : ''}`;
    text = doc.lines.join('\n');
  } else {
    text = insertSetting(text, doc, 'github', `${key} = ${literal}`);
  }
  // Validate the edited value above; other invalid fields can be repaired in later calls.
  parseGitHub(text, { validate: false });
  if (Buffer.byteLength(text) > 16384) throw new Error('config_too_large');
  return text;
}

export function configure(repository, action, key, value) {
  const path = configPath(repository);
  plainPath(path);
  if (action === 'show') {
    if (!existsSync(path)) throw new Error('config_missing');
    const content = readText(path); parseConfiguration(content); parseGitHub(content);
    return { schema: 'gidd.config/v1', status: 'ready', config_path: path, content };
  }
  if (action !== 'set') throw new Error('config_invalid_arguments');
  if (key === 'github.repository') value = normalizeRepositoryIdentity(value);
  validateSetting(key, value);
  mkdirSync(dirname(path), { recursive: true });
  plainPath(path);
  const lockPath = path + '.lock', temporary = path + '.' + randomUUID() + '.tmp';
  let lock;
  try {
    try { lock = openSync(lockPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('config_locked'); throw error; }
    const original = existsSync(path) ? readText(path) : null;
    const text = original ?? initialConfiguration;
    const result = editConfiguration(text, key, value);
    parseConfiguration(result);
    const fd = openSync(temporary, 'wx');
    try { writeFileSync(fd, result, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    plainPath(path);
    if ((existsSync(path) ? readText(path) : null) !== original) throw new Error('config_changed_during_edit');
    renameSync(temporary, path);
    return { schema: 'gidd.config/v1', status: 'ready', config_path: path, action: 'set', key, value };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}
