import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const defaults = Object.freeze({
  node: { version: 'lts', source: 'https://nodejs.org/dist' },
  bun: { version: 'latest', source: 'https://github.com/oven-sh/bun/releases' },
  gh: { version: 'latest', source: 'https://github.com/cli/cli/releases' },
});
export const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export const stringPattern = String.raw`(?:"(?:[^"\\]|\\["\\])*"|'[^']*')`;
export const decodeString = text => text[0] === "'" ? text.slice(1, -1) : JSON.parse(text);
export const platformName = () => process.platform === 'win32' && process.arch === 'x64' ? 'windows-x64' : `${process.platform}-${process.arch}`;
export const executableName = name => process.platform === 'win32' ? `${name}.exe` : name;
// MinGit must retain its layout so git.exe can locate helpers and libraries.
export const managedExecutable = name => name === 'git' ? 'cmd/git.exe' : executableName(name);
export const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');

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

export function validateToolSettings(name, settings) {
  if (!versionPattern.test(settings.version) && settings.version !== 'latest' && !(name === 'node' && settings.version === 'lts')) throw new Error(`config_invalid_version:${name}`);
  let url;
  try { url = new URL(settings.source); } catch { throw new Error(`config_invalid_source:${name}`); }
  if (!settings.source.startsWith('https://') || /[\s\\]/.test(settings.source) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error(`config_invalid_source:${name}`);
  return { version: settings.version, source: settings.source.replace(/\/+$/, '') };
}

// The same small schema is accepted by stage0. Editing keeps the original text;
// parsing never rewrites comments or invents GitHub identity fields.
export function parseConfiguration(text) {
  if (Buffer.byteLength(text) > 16384) throw new Error('config_too_large');
  const result = { tools: structuredClone(defaults), github: {} };
  const tables = new Set(), seen = new Set();
  let section = '', schema = false;
  for (const [index, input] of text.replace(/^\uFEFF/, '').split('\n').entries()) {
    const line = input.replace(/\r$/, '');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line)) throw new Error(`config_control_character:${index + 1}`);
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    if (/^[ \t]*\[bootstrap\]/.test(line)) throw new Error('config_retired_field:bootstrap');
    const table = /^[ \t]*\[(tools|github)\][ \t]*(?:#.*)?$/.exec(line);
    if (table) {
      section = table[1];
      if (tables.has(section)) throw new Error(`config_duplicate_${section}_table`);
      tables.add(section); continue;
    }
    if (!section && /^[ \t]*schema_version[ \t]*=[ \t]*1[ \t]*(?:#.*)?$/.test(line)) {
      if (schema) throw new Error('config_duplicate_schema_version');
      schema = true; continue;
    }
    if (section === 'github') {
      const names = 'hostname|account|remote';
      const field = new RegExp(`^[ \\t]*(${names})[ \\t]*=[ \\t]*(${stringPattern})[ \\t]*(?:#.*)?$`).exec(line);
      if (!field) throw new Error(`config_unsupported_syntax_or_field:${index + 1}`);
      const key = `${section}.${field[1]}`;
      if (seen.has(key)) throw new Error(`config_duplicate_key:${key}`);
      seen.add(key);
      const value = decodeString(field[2]);
      result[section][field[1]] = value; continue;
    }
    const tool = section === 'tools' && /^[ \t]*(node|bun|gh)[ \t]*=[ \t]*\{(.*?)\}[ \t]*(?:#.*)?$/.exec(line);
    if (tool) {
      const name = tool[1], settings = {};
      if (seen.has(name)) throw new Error(`config_duplicate_key:${name}`);
      seen.add(name);
      let tail = tool[2].trim();
      while (tail) {
        const field = new RegExp(`^(version|source)[ \\t]*=[ \\t]*(${stringPattern})[ \\t]*(.*)$`).exec(tail);
        if (!field) throw new Error(`config_invalid_tool_table:${name}`);
        if (field[1] === 'version') throw new Error(`config_retired_field:tools.${name}.version`);
        if (Object.hasOwn(settings, field[1])) throw new Error(`config_duplicate_tool_field:${name}:${field[1]}`);
        settings[field[1]] = decodeString(field[2]);
        if (!field[3]) break;
        if (!field[3].startsWith(',') || !field[3].slice(1).trim()) throw new Error(`config_invalid_tool_table:${name}`);
        tail = field[3].slice(1).trim();
      }
      if (!Object.hasOwn(settings, 'source')) throw new Error(`config_missing_tool_field:${name}`);
      result.tools[name] = validateToolSettings(name, { ...defaults[name], ...settings }); continue;
    }
    throw new Error(`config_unsupported_syntax_or_field:${index + 1}`);
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

export function configurationPath(repository) {
  if (!repository || !isAbsolute(repository)) throw new Error('repository_must_be_absolute');
  return join(repository, '.agents/skills/gidd/config.toml');
}

export function toolsRoot() {
  const home = process.platform === 'win32' ? process.env.USERPROFILE || homedir() : homedir();
  if (!isAbsolute(home) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(home))) throw new Error('user_home_absolute_local_path_required');
  return resolve(home, '.agents/skills.tools/gidd');
}

export function inspectToolTree(root) {
  plainPath(root);
  if (!existsSync(root)) return;
  if (!lstatSync(root).isDirectory()) throw new Error('tools_directory_not_a_directory');
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) {
        // Bootstrap validates the selected binding; external tool trees are not owned here.
        if (directory === root && /^\.runtime-path-[a-f0-9]{64}$/.test(item.name)) continue;
        throw new Error('reparse_tools_directory');
      }
      if (['skill.md', 'config.toml', '.git'].includes(item.name.toLowerCase())) throw new Error('tools_directory_contains_project_or_skill');
      if (item.isDirectory()) pending.push(join(directory, item.name));
    }
  }
}

export function resolveStorage(repository, { inspect = true } = {}) {
  const path = repository ? configurationPath(repository) : null;
  if (path) plainPath(path);
  const configured = !!path && existsSync(path);
  const settings = configured ? parseConfiguration(readConfigurationText(path)) : { tools: structuredClone(defaults), github: {} };
  const root = toolsRoot(); if (inspect) inspectToolTree(root);
  return { tools_root: root, config_path: path, configured, ...settings };
}

export function safePayloadName(name) {
  return typeof name === 'string' && name.length <= 240 && name.split('/').every(part =>
    /^[a-z0-9_.+@-]+$/i.test(part) && !['.', '..'].includes(part) && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) &&
    !['install.json', 'skill.md', 'config.toml', '.git'].includes(part.toLowerCase()));
}

export function payloadFiles(root, nested = false) {
  const files = [];
  function visit(directory, prefix = '') {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && item.name === 'install.json') continue;
      const name = prefix + item.name, path = join(directory, item.name);
      if (item.isFile()) files.push(name);
      else if (nested && item.isDirectory()) {
        const before = files.length; visit(path, name + '/');
        if (files.length === before) throw new Error('empty_payload_directory');
      } else throw new Error('invalid_payload_entry');
      if (files.length > 10000) throw new Error('too_many_payload_files');
    }
  }
  visit(root); return files.sort();
}

export function managedToolValid(root, name, { allowDamaged = false } = {}) {
  try {
    plainPath(root);
    const recordPath = join(root, 'install.json'); plainPath(recordPath);
    const stat = lstatSync(recordPath);
    if (!stat.isFile() || stat.size > (name === 'git' ? 4 * 1024 * 1024 : 65536)) return false;
    const record = JSON.parse(readFileSync(recordPath, 'utf8').replace(/^\uFEFF/, ''));
    if (record.schema !== (name === 'git' ? 'gidd.install/v2' : 'gidd.install/v1') || record.name !== name || record.platform !== platformName() || !versionPattern.test(record.version) || !/^[a-f0-9]{64}$/.test(record.archive_sha256) || !Array.isArray(record.files)) return false;
    if (record.files.length > 10000) return false;
    const names = new Set();
    for (const file of record.files) {
      if (!(name === 'git' ? safePayloadName(file.name) : /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(file.name)) || names.has(file.name.toLowerCase()) || file.name.toLowerCase() === 'install.json') return false;
      names.add(file.name.toLowerCase());
      if (!Number.isSafeInteger(file.length) || file.length < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
      const path = join(root, file.name); plainPath(path);
      if (allowDamaged && !existsSync(path)) continue;
      const actual = lstatSync(path);
      if (!actual.isFile() || (!allowDamaged && (actual.size !== file.length || hashFile(path) !== file.sha256))) return false;
    }
    if (!names.has(managedExecutable(name).toLowerCase())) return false;
    if (allowDamaged) {
      const allowed = new Set(names);
      for (const file of names) {
        const parts=file.split('/'); parts.pop();
        while(parts.length) { allowed.add(parts.join('/')); parts.pop(); }
      }
      function owned(directory,prefix='') {
        return readdirSync(directory,{withFileTypes:true}).every(item=>{
          if (!prefix && item.name === 'install.json') return item.isFile();
          const path=prefix+item.name;
          return allowed.has(path.toLowerCase()) && (item.isFile() || (item.isDirectory() && owned(join(directory,item.name),path+'/')));
        });
      }
      return owned(root);
    }
    const actual = payloadFiles(root, name === 'git');
    return actual.length === names.size && actual.every(file => names.has(file.toLowerCase()));
  } catch { return false; }
}
