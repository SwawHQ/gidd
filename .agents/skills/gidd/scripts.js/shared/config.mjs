import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { configurationPath, parseConfiguration, stringPattern } from './storage.mjs';
import { policySelectionHint, policyCatalogHint } from './policies.mjs';
import { validateUiLanguage } from './language.mjs';

const initialConfiguration = 'schema_version = 1\n';
const editableKey = /^ui\.language$/;
const hostnamePattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function normalizeRepositoryIdentity(value) {
  const match = typeof value === 'string' && !/[\s\\%?#]/.test(value) && /^https:\/\/([^/:@]+)\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/?$/i.exec(value);
  if (!match || !hostnamePattern.test(match[1]) || [match[2], match[3]].some(part => ['.', '..'].includes(part))) throw new Error('remote_address_unsupported');
  const name = match[3].replace(/\.git$/i, '');
  if (!name || ['.', '..'].includes(name)) throw new Error('remote_address_unsupported');
  return `https://${match[1]}/${match[2]}/${name}`.toLowerCase();
}

// Never return raw transport addresses: they can contain credentials.
export function remoteAddress(text) {
  if (/[\s\\%?#]/.test(text)) return null;
  let protocol = 'https', match = /^https:\/\/([^/:@]+)\/([^/]+)\/([^/]+)\/?$/i.exec(text);
  if (!match) { protocol = 'ssh'; match = /^git@([^/:@]+):([^/]+)\/([^/]+)\/?$/i.exec(text); }
  if (!match) match = /^ssh:\/\/git@([^/:@]+)(?::[0-9]+)?\/([^/]+)\/([^/]+)\/?$/i.exec(text);
  if (!match) return null;
  try {
    const identity = normalizeRepositoryIdentity(`https://${match[1]}/${match[2]}/${match[3]}`);
    return { protocol, hostname: new URL(identity).hostname, repository: identity.slice('https://'.length).split('/').slice(1).join('/'), identity };
  } catch { return null; }
}

function validateKey(key) {
  if (!editableKey.test(key || '')) throw new Error('config_unknown_key');
}

function validateSetting(key, value) {
  validateKey(key);
  return validateUiLanguage(value);
}

export function editConfiguration(text, key, value, { clear = false } = {}) {
  if (clear) validateKey(key); else validateSetting(key, value);
  parseConfiguration(text); // Other invalid values remain independently repairable.
  const [section, ...parts] = key.split('.'), field = parts.join('.');
  const lines = text.split('\n'), newline = text.includes('\r\n') ? '\r\n' : '\n';
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\uFEFF/, '').replace(/\r$/, '');
    const table = /^[ \t]*\[([^\]]+)\][ \t]*(?:#.*)?$/.exec(line);
    if (table) {
      if (start >= 0) { end = i; break; }
      if (table[1] === section) start = i;
      continue;
    }
    if (start < 0) continue;
    const match = new RegExp('^([ \\t]*' + field.replaceAll('.', '\\.') + '[ \\t]*=[ \\t]*)(' + stringPattern + ')([ \\t]*(?:#.*)?)$').exec(line);
    if (match) {
      const ending = lines[i].endsWith('\r') ? '\r' : '';
      if (clear) {
        const comment = match[3].trimStart();
        if (comment) lines[i] = /^[ \t]*/.exec(line)[0] + comment + ending;
        else if (i === lines.length - 1) lines[i] = '';
        else lines.splice(i, 1);
      } else lines[i] = match[1] + JSON.stringify(value) + match[3] + ending;
      return lines.join('\n');
    }
  }
  if (clear) return text;
  const setting = field + ' = ' + JSON.stringify(value) + newline;
  if (start < 0) return text + (text.endsWith('\n') ? '' : newline) + newline + '[' + section + ']' + newline + setting;
  const offset = Math.min(text.length, lines.slice(0, end).reduce((sum, line) => sum + line.length + 1, 0));
  const prefix = text.slice(0, offset);
  return prefix + (prefix.endsWith('\n') ? '' : newline) + setting + text.slice(offset);
}

export const configPath = configurationPath;

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

export function readConfiguration(repository) {
  const path = configPath(repository);
  if (!existsSync(path)) return { ui: {} };
  return parseConfiguration(readText(path));
}

export function configurationHint(reason) {
  if (reason.startsWith('remote_')) return 'Inspect Git remotes and target branch settings. Use for.swaw.gidd to select a dedicated remote with one fetch URL and at most one push URL.';
  if (reason === 'delivery_remote_changed') return 'Inspect the recorded source repository, fetch branch and delivery repository with doctor, then resolve the Git configuration change. The task binding is retained.';
  if (reason === 'config_invalid_ui_language') return 'Use gidd lang.set zh or gidd lang.set en; use gidd lang.clear to follow the system language.';
  if (['policy_selector_invalid', 'policy_number_missing', 'policy_mode_missing'].includes(reason)) return policySelectionHint;
  if (reason === 'policy_number_ambiguous') return 'This number matches multiple presets. Use the full preset name, for example 00/00.auto.';
  if (reason === 'policy_mode_id_conflict' || reason === 'policy_mode_name_conflict') return 'Run gidd policy.deliveries to locate conflicting mode directories; their IDs and mode names must be unique.';
  if (reason.startsWith('policy_')) return policyCatalogHint;
  if (reason === 'config_missing') return 'Set optional language preferences with gidd lang.set zh or gidd lang.set en.';
  if (reason.startsWith('config_')) return 'Use the error code to check the requested settings and config.toml, then rerun the command.';
  return '';
}

export function configure(repository, action, key, value) {
  const path = configPath(repository);
  plainPath(path);
  if (action === 'show') {
    if (!existsSync(path)) throw new Error('config_missing');
    const content = readText(path);
    return { schema: 'gidd.config/v1', status: 'ready', config_path: path, content };
  }
  if (!['set', 'clear'].includes(action) || action === 'clear' && value !== undefined) throw new Error('config_invalid_arguments');
  const clear = action === 'clear';
  if (clear) validateKey(key); else validateSetting(key, value);
  const report = { schema: 'gidd.config/v1', status: 'ready', config_path: path, action, key, ...(!clear ? { value } : {}) };
  if (clear && !existsSync(path)) return { ...report, changed: false };
  if (!clear) mkdirSync(dirname(path), { recursive: true });
  plainPath(path);
  const lockPath = path + '.lock', temporary = path + '.' + randomUUID() + '.tmp';
  let lock;
  try {
    try { lock = openSync(lockPath, 'wx'); writeFileSync(lock, JSON.stringify({ pid: process.pid }) + '\n'); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('config_locked'); throw error; }
    const original = existsSync(path) ? readText(path) : null;
    if (clear && original === null) return { ...report, changed: false };
    const text = original ?? initialConfiguration;
    let result = editConfiguration(text, key, value, { clear });
    if (clear && result === original) return { ...report, changed: false };
    parseConfiguration(result);
    const fd = openSync(temporary, 'wx');
    try { writeFileSync(fd, result, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    plainPath(path);
    if ((existsSync(path) ? readText(path) : null) !== original) throw new Error('config_changed_during_edit');
    renameSync(temporary, path);
    return { ...report, ...(clear ? { changed: true } : {}) };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}
