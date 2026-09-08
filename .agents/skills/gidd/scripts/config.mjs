import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const fields = new Set(['hostname', 'account', 'remote']);
const stringLiteral = String.raw`(?:"(?:[^"\\]|\\["\\])*"|'[^']*')`;
const assignment = new RegExp(`^([ \\t]*)(hostname|account|remote)([ \\t]*=[ \\t]*)(${stringLiteral})([ \\t]*(?:#.*)?)$`);
const decode = literal => literal[0] === "'" ? literal.slice(1, -1) : JSON.parse(literal);
const editableKey = /^(?:github\.(?:hostname|account|remote)|tools\.(?:node|bun|gh)\.(?:version|source))$/;

function validateSetting(key, value) {
  if (!editableKey.test(key || '')) throw new Error('config_unknown_key');
  if (key.startsWith('github.')) return validateGitHubField(key.slice(7), value);
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('config_invalid_tool_value');
  if (key.endsWith('.version')) {
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value) && value !== 'latest' && !(key === 'tools.node.version' && value === 'lts')) throw new Error('config_invalid_tool_version');
  } else if (key.endsWith('.source')) {
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
    if (consumed !== inline[3].length || !entry.fields.version || !entry.fields.source) throw new Error('config_invalid_tool_table');
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
  const doc = parseTools(text), [, name, field] = key.split('.'), entry = doc.entries[name];
  const literal = JSON.stringify(value);
  if (entry) {
    const { offset, literal: previous } = entry.fields[field];
    const content = entry.inline[3];
    const line = entry.inline[1] + content.slice(0, offset) + literal + content.slice(offset + previous.length) + entry.inline[4];
    doc.lines[entry.index] = line + (doc.lines[entry.index].endsWith('\r') ? '\r' : '');
    text = doc.lines.join('\n');
  } else {
    // A missing inline table gets its companion field from the published template.
    const defaults = parseTools(readFileSync(new URL('../assets/config.example.toml', import.meta.url), 'utf8')).entries[name].fields;
    const version = field === 'version' ? value : defaults.version.value;
    const source = field === 'source' ? value : defaults.source.value;
    const setting = `${name} = { version = ${JSON.stringify(version)}, source = ${JSON.stringify(source)} }`;
    text = insertSetting(text, doc, 'tools', setting);
  }
  parseGitHub(text);
  if (Buffer.byteLength(text) > 16384) throw new Error('config_too_large');
  return text;
}

function validateCandidate(repository, path) {
  const shell = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  env.PSModulePath = join(dirname(shell), 'Modules');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./windows/validate-config.ps1', import.meta.url)), '-RepositoryPath', repository, '-CandidatePath', path],
  { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
  if (result.error || result.status !== 0) throw new Error('config_candidate_invalid');
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
  const patterns = {
    hostname: /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i,
    account: /^[a-z0-9][a-z0-9-]{0,99}$/i,
    remote: /^[a-z0-9][a-z0-9._/-]*$/i,
  };
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value) || !patterns[key].test(value)) throw new Error(`config_invalid_github_${key}`);
}

// The shell validates the full bootstrap schema; this reader owns GitHub settings.
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
  const { github } = parseGitHub(readText(path));
  for (const key of required) if (!Object.hasOwn(github, key)) throw new Error(`config_missing_github_${key}`);
  return github;
}

export function configurationHint(reason) {
  const missing = /^config_missing_github_(hostname|account|remote)$/.exec(reason);
  if (missing) return `Set github.${missing[1]} with: gidd.cmd config set github.${missing[1]} <value>`;
  if (reason === 'config_missing') return 'Create repository config with: gidd.cmd config set github.account <login>';
  if (reason.startsWith('config_')) return 'Check repository config.toml and use gidd.cmd config show/set. No login or configuration fallback was performed.';
  return '';
}

export function editGitHub(text, key, value) {
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
  parseGitHub(text);
  if (Buffer.byteLength(text) > 16384) throw new Error('config_too_large');
  return text;
}

export function configure(repository, action, key, value) {
  const path = configPath(repository);
  plainPath(path);
  if (action === 'show') {
    if (!existsSync(path)) throw new Error('config_missing');
    const content = readText(path); parseGitHub(content);
    return { schema: 'gidd.config/v1', status: 'ready', config_path: path, content };
  }
  if (action !== 'set') throw new Error('config_invalid_arguments');
  validateSetting(key, value);
  mkdirSync(dirname(path), { recursive: true });
  plainPath(path);
  const lockPath = path + '.lock', temporary = path + '.' + randomUUID() + '.tmp';
  let lock;
  try {
    try { lock = openSync(lockPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('config_locked'); throw error; }
    const original = existsSync(path) ? readText(path) : null;
    const text = original ?? readFileSync(new URL('../assets/config.example.toml', import.meta.url), 'utf8');
    const result = editConfiguration(text, key, value);
    const fd = openSync(temporary, 'wx');
    try { writeFileSync(fd, result, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    if (key.startsWith('tools.')) validateCandidate(repository, temporary);
    plainPath(path);
    if ((existsSync(path) ? readText(path) : null) !== original) throw new Error('config_changed_during_edit');
    renameSync(temporary, path);
    return { schema: 'gidd.config/v1', status: 'ready', config_path: path, action: 'set', key, value };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let args = process.argv.slice(2);
    if (args[0] === '--encoded-arguments') {
      if (args.length !== 2) throw new Error('config_invalid_arguments');
      try { args = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8')); }
      catch { throw new Error('config_invalid_arguments'); }
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('config_invalid_arguments');
    }
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!args[i].startsWith('--') || !['repository', 'action', 'key', 'value'].includes(key) || Object.hasOwn(options, key) || args[i + 1] === undefined) throw new Error('config_invalid_arguments');
      options[key] = args[i + 1];
    }
    console.log(JSON.stringify(configure(options.repository, options.action, options.key, options.value)));
  } catch (error) {
    const reason = /^(config_[a-z_]+|repository_must_be_absolute)$/.test(error.message) ? error.message : 'config_operation_failed';
    const hint = configurationHint(reason); if (hint) console.error(hint);
    console.log(JSON.stringify({ schema: 'gidd.config/v1', status: 'error', reason }));
    process.exitCode = 2;
  }
}
