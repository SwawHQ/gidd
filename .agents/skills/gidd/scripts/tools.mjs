import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { runCommand } from './github.mjs';
import { compareVersions, executableName, managedExecutable, managedToolValid, versionPattern } from './storage.mjs';

export const check = (id, status, reason, details = {}) => ({ id, status, reason, details });
// Runtime discovery here is diagnostic/installation work, not a startup gate.
// Compatibility policy lives only in runtime-compat.mjs, invoked by bootstrap.
export const minimums = { bun: '0.0.0', node: '0.0.0', git: '2.0.0', gh: '2.98.0' };
export const patterns = { bun: /^(\d+\.\d+\.\d+)$/, node: /^v(\d+\.\d+\.\d+)$/, gh: /^gh version (\d+\.\d+\.\d+)(?:\s|$)/, git: /^git version (\d+\.\d+\.\d+)/ };

export function pathCandidates(name, env = process.env) {
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  return [...new Set(path.split(delimiter).map(part => part.replace(/^"(.*)"$/, '$1')).filter(isAbsolute)
    .map(part => join(part, executableName(name))).filter(existsSync))];
}

// One process-local environment per command, shared by Git and gh subprocesses.
// A launcher is unnecessary after JS starts; execute the selected absolute path.
export function toolEnvironment(git, env = process.env) {
  const result = { ...env };
  if (!git) return result;
  const path = Object.entries(result).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const key of Object.keys(result)) if (/^(path|git_exec_path)$/i.test(key)) delete result[key];
  result.PATH = dirname(git) + (path ? delimiter + path : '');
  return result;
}

export async function findTool(name, { root = '', requested = '', minimum = minimums[name], source = 'auto', execute = runCommand } = {}) {
  const managed = root ? join(root, name, managedExecutable(name)) : '';
  const candidates = [];
  if (source !== 'path' && managed && existsSync(managed)) candidates.push({ path: managed, source: 'managed' });
  if (source !== 'managed') for (const path of pathCandidates(name)) candidates.push({ path, source: 'path' });
  const rejected = [];
  for (const candidate of candidates) {
    const isManaged = candidate.source === 'managed' || (managed && (resolve(candidate.path).toLowerCase() === resolve(managed).toLowerCase() || name === 'git' && resolve(candidate.path).toLowerCase().startsWith(resolve(root, name).toLowerCase() + sep)));
    if (isManaged && !managedToolValid(join(root, name), name)) {
      rejected.push({ ...candidate, reason: 'managed_integrity_failed', version: null }); continue;
    }
    const probe = await execute(candidate.path, ['--version'], { timeoutMs: 5000 });
    const version = probe.ok && patterns[name].exec(probe.text)?.[1] || null;
    const reason = !probe.ok ? probe.reason : !version ? 'unrecognized_version' :
      versionPattern.test(requested) && version !== requested ? 'configured_version_mismatch' :
        compareVersions(version, minimum) < 0 ? 'version_below_minimum' : 'usable';
    if (reason === 'usable') return check(`tool.${name}`, 'ready', reason, { ...candidate, version, minimum, requested_version: requested, rejected });
    rejected.push({ ...candidate, reason, version });
  }
  return check(`tool.${name}`, candidates.length ? 'invalid' : 'missing', 'no_usable_candidate', { minimum, requested_version: requested, rejected });
}
