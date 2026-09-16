import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseConfiguration, stringPattern } from './storage.mjs';
import { validateSpecMode, specModes } from './specs.mjs';
import { validateGitField, validateGitSettings } from './git-settings.mjs';

const initialConfiguration = 'schema_version = 1\n\n[repo]\nremote.name = "origin"\n';
const editableKey = /^(?:repo\.remote\.(?:name|url|account)|git\.(?:user\.(?:name|email)|credential\.mode)|spec\.mode)$/;
const hostnamePattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function normalizeRepositoryIdentity(value) {
  const match = typeof value === 'string' && !/[\s\\%?#]/.test(value) && /^https:\/\/([^/:@]+)\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/?$/i.exec(value);
  if (!match || !hostnamePattern.test(match[1]) || [match[2], match[3]].some(part => ['.', '..'].includes(part))) throw new Error('config_invalid_repo_remote_url');
  const name = match[3].replace(/\.git$/i, '');
  if (!name || ['.', '..'].includes(name)) throw new Error('config_invalid_repo_remote_url');
  return `https://${match[1]}/${match[2]}/${name}`.toLowerCase();
}

export function validateRemoteField(key, value) {
  if (key === 'url') { normalizeRepositoryIdentity(value); return; }
  const pattern = { name: /^[a-z0-9][a-z0-9._/-]*$/i, account: /^[a-z0-9][a-z0-9-]{0,99}$/i }[key];
  if (!pattern) throw new Error('config_unknown_repo_remote_field');
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value) || !pattern.test(value)) throw new Error('config_invalid_repo_remote_' + key);
}

export function validateRemoteSettings(remote, required = []) {
  for (const key of required) if (!Object.hasOwn(remote, key)) throw new Error('config_missing_repo_remote_' + key);
  for (const [key, value] of Object.entries(remote)) validateRemoteField(key, value);
  return remote;
}

export function githubTarget(remote) {
  const canonical = normalizeRepositoryIdentity(remote.url);
  return { hostname: new URL(canonical).hostname, repository: canonical, remote: remote.name, account: remote.account };
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

function validateSetting(key, value) {
  if (!editableKey.test(key || '')) throw new Error('config_unknown_key');
  if (key === 'spec.mode') return validateSpecMode(value);
  if (key.startsWith('git.')) return validateGitField(key.slice(4), value);
  validateRemoteField(key.slice('repo.remote.'.length), value);
}

export function editConfiguration(text, key, value) {
  validateSetting(key, value);
  parseConfiguration(text); // Other invalid values remain independently repairable.
  if (key === 'repo.remote.url') value = normalizeRepositoryIdentity(value);
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
      lines[i] = match[1] + JSON.stringify(value) + match[3] + (lines[i].endsWith('\r') ? '\r' : '');
      return lines.join('\n');
    }
  }
  const setting = field + ' = ' + JSON.stringify(value) + newline;
  if (start < 0) return text + (text.endsWith('\n') ? '' : newline) + newline + '[' + section + ']' + newline + setting;
  const offset = Math.min(text.length, lines.slice(0, end).reduce((sum, line) => sum + line.length + 1, 0));
  const prefix = text.slice(0, offset);
  return prefix + (prefix.endsWith('\n') ? '' : newline) + setting + text.slice(offset);
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

export function readRemoteConfiguration(repository, required = []) {
  const path = configPath(repository);
  if (!existsSync(path)) throw new Error('config_missing');
  return validateRemoteSettings(parseConfiguration(readText(path)).repo.remote, required);
}

export function readConfiguration(repository) {
  const path = configPath(repository);
  if (!existsSync(path)) throw new Error('config_missing');
  return parseConfiguration(readText(path));
}

export function configurationHint(reason) {
  if (reason === 'spec_mode_unsupported') return 'Available spec modes: ' + specModes.join(', ') + '. Use config set spec.mode <mode>.';
  if (reason === 'config_retired_structure') return 'Replace [github] with [repo] remote.name, remote.url and remote.account; remove hostname and [tools]. Tool sources are internal preparation policy. Preserve unrelated comments and [spec].';
  if (reason === 'config_missing') return 'Create config with: gidd.link.cmd config set repo.remote.account <login>. Then set repo.remote.url and review repo.remote.name.';
  if (reason === 'config_incomplete_git_user') return 'Set both git.user.name and git.user.email, or remove both to inherit Git identity.';
  if (/^config_(missing|invalid)_git_credential_mode$/.test(reason)) return 'Set git.credential.mode explicitly to gh or inherit with config set.';
  const field = /^config_(?:missing|invalid)_repo_remote_(name|url|account)$/.exec(reason);
  if (field) return `Run doctor --offline and repair repo.remote.${field[1]} with config set.`;
  if (reason.startsWith('config_')) return 'Check config.toml using config show/set. No configuration fallback or login was performed.';
  return '';
}

export function configure(repository, action, key, value) {
  const path = configPath(repository);
  plainPath(path);
  if (action === 'show') {
    if (!existsSync(path)) throw new Error('config_missing');
    const content = readText(path);
    const settings = parseConfiguration(content);
    validateRemoteSettings(settings.repo.remote);
    validateGitSettings(settings.git);
    return { schema: 'gidd.config/v1', status: 'ready', config_path: path, content };
  }
  if (action !== 'set') throw new Error('config_invalid_arguments');
  if (key === 'repo.remote.url') value = normalizeRepositoryIdentity(value);
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
