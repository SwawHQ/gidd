import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export const stringPattern = String.raw`(?:"(?:[^"\\]|\\["\\])*"|'[^']*')`;
export const decodeString = text => text[0] === "'" ? text.slice(1, -1) : JSON.parse(text);
export const platformName = () => process.platform === 'win32' && process.arch === 'x64' ? 'windows-x64' : `${process.platform}-${process.arch}`;
export const executableName = name => process.platform === 'win32' ? `${name}.exe` : name;
// MinGit must retain its layout so git.exe can locate helpers and libraries.
export const managedExecutable = name => name === 'git' ? 'cmd/git.exe' : executableName(name);

export function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

export function plainPath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('reparse_path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}

export function readConfigurationText(path) {
  plainPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error('config_not_a_file');
  if (stat.size > 16384) throw new Error('config_too_large');
  const bytes = readFileSync(path);
  if (bytes.length > 16384) throw new Error('config_too_large');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('config_invalid_utf8'); }
}

// User preferences are shared by all repositories; task choices stay local.
export function parseConfiguration(text) {
  if (Buffer.byteLength(text) > 16384) throw new Error('config_too_large');
  const result = { ui: {} }, tables = new Set(), seen = new Set();
  let section = '', schema = false;
  for (const [index, input] of text.replace(/^\uFEFF/, '').split('\n').entries()) {
    const line = input.replace(/\r$/, '');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line)) throw new Error('config_control_character:' + (index + 1));
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const table = /^[ \t]*\[(ui)\][ \t]*(?:#.*)?$/.exec(line);
    if (table) {
      section = table[1];
      if (tables.has(section)) throw new Error('config_duplicate_' + section + '_table');
      tables.add(section); continue;
    }
    if (!section && /^[ \t]*schema_version[ \t]*=[ \t]*1[ \t]*(?:#.*)?$/.test(line)) {
      if (schema) throw new Error('config_duplicate_schema_version');
      schema = true; continue;
    }
    const names = section === 'ui' ? 'language' : '(?!)';
    const field = new RegExp('^[ \\t]*(' + names + ')[ \\t]*=[ \\t]*(' + stringPattern + ')[ \\t]*(?:#.*)?$').exec(line);
    if (!field) throw new Error('config_unsupported_syntax_or_field:' + (index + 1));
    const key = section + '.' + field[1];
    if (seen.has(key)) throw new Error('config_duplicate_key:' + key);
    seen.add(key);
    result.ui.language = decodeString(field[2]);
  }
  if (!schema) throw new Error('config_missing_key:schema_version');
  return result;
}

export function repositoryRoot(path) {
  if (!path || !isAbsolute(path)) throw new Error('repository_must_be_absolute');
  const target = resolve(path);
  if (!lstatSync(target).isDirectory()) throw new Error('repository_directory_missing');
  plainPath(target);
  for (let current = target; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return target;
  }
}

export function configurationPath() {
  return join(toolsRoot(), 'config.toml');
}

export function toolsRoot() {
  const home = process.platform === 'win32' ? process.env.USERPROFILE || homedir() : homedir();
  if (!isAbsolute(home) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(home))) throw new Error('user_home_absolute_local_path_required');
  return resolve(home, '.agents/skills.tools/gidd');
}
