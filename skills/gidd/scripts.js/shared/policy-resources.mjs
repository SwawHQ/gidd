import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parse } from '../vendor/toml.mjs';
import { plainPath } from './storage.mjs';

export function policyFailure(reason, path, field) {
  return Object.assign(new Error(reason), { ...(path ? { path } : {}), ...(field ? { field } : {}) });
}

export function readPolicyResource(path) {
  try { plainPath(path); } catch { throw policyFailure('policy_resource_path_invalid', path); }
  if (!existsSync(path)) throw policyFailure('policy_resources_missing', path);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 65536) throw new Error();
    const bytes = readFileSync(path);
    if (bytes.length > 65536) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.trim() || text.includes('\0')) throw new Error();
    return text;
  } catch { throw policyFailure('policy_resources_invalid', path); }
}

export function readPolicyToml(path) {
  const text = readPolicyResource(path);
  try { return parse(text); }
  // Do not echo parser excerpts: resource contents belong in a successful prompt only.
  catch { throw policyFailure('policy_toml_invalid', path); }
}

// Relative to the declaring mode description, confined to this skill's references.
export function policyIssueTemplatePath(root, source, reference) {
  if (typeof reference !== 'string' || !reference.trim() || /[\x00-\x1f:*?"<>|]/.test(reference) ||
      isAbsolute(reference) || /^[\\/]/.test(reference)) throw policyFailure('policy_resource_path_invalid', source);
  const path = resolve(dirname(source), reference), boundary = resolve(root, '../references');
  const local = relative(boundary, path);
  if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local) || !path.endsWith('.json')) {
    throw policyFailure('policy_resource_path_invalid', source);
  }
  try { plainPath(path); } catch { throw policyFailure('policy_resource_path_invalid', path); }
  return path;
}
