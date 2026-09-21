import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { plainPath } from './storage.mjs';
import { fields, nonemptyText, parseSpecYaml } from './spec-data.mjs';

const fail = reason => { throw new Error(reason); };
const requirementValues = ['required', 'optional', 'agent_decides', 'user_decides'];
const handlingValues = ['auto', 'ask', 'agent_decides', 'user_decides'];
const descriptionValues = {
  issue: requirementValues,
  branch_pr: requirementValues,
  stage_commit_push: handlingValues,
  merge_and_related_failures: handlingValues,
  close_issue: handlingValues,
  other_steps: handlingValues,
};

// Array order belongs to the author. Validate every dimension without sorting
// or flattening it; agent/user_decides also covers whether a step applies.
function validateDescription(description) {
  if (!Array.isArray(description) || description.length !== Object.keys(descriptionValues).length) fail('spec_metadata_invalid');
  const seen = new Set();
  for (const item of description) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('spec_metadata_invalid');
    const keys = Object.keys(item), key = keys[0];
    if (keys.length !== 1 || !Object.hasOwn(descriptionValues, key) || seen.has(key) ||
        !descriptionValues[key].includes(item[key])) fail('spec_metadata_invalid');
    seen.add(key);
  }
}

export function specResourcePath(root, source, reference) {
  if (typeof reference !== 'string' || !reference.trim() || /[\x00-\x1f:*?"<>|]/.test(reference) || isAbsolute(reference) || /^[\\/]/.test(reference)) fail('spec_resource_path_invalid');
  const path = resolve(dirname(source), reference);
  const local = relative(resolve(root), path);
  if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local)) fail('spec_resource_path_invalid');
  return path;
}

export function readSpecResource(path) {
  try { plainPath(path); } catch { fail('spec_resource_path_invalid'); }
  if (!existsSync(path)) fail('spec_resources_missing');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 65536) fail('spec_resources_invalid');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    if (!text.trim() || text.includes('\0')) fail('spec_resources_invalid');
    return text;
  } catch (error) {
    if (error.message.startsWith('spec_')) throw error;
    fail('spec_resources_invalid');
  }
}

export function readSpecPrompt(path) {
  const text = readSpecResource(path);
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) fail('spec_metadata_invalid');
  let metadata;
  try {
    metadata = parseSpecYaml(match[1]);
    fields(metadata, ['description'], ['issue_template']);
    validateDescription(metadata.description);
    if (Object.hasOwn(metadata, 'issue_template') && !nonemptyText(metadata.issue_template)) fail('spec_metadata_invalid');
  } catch { fail('spec_metadata_invalid'); }
  const content = text.slice(match[0].length);
  if (!content.trim()) fail('spec_resources_invalid');
  return { path, metadata, content };
}

// Includes are standalone directives outside fenced/indented code. Expansion is
// buffered so a missing dependency never produces a partial workflow on stdout.
export function expandSpecPrompt(root, prompt) {
  const active = new Set();
  let visits = 0, bytes = 0;
  const expand = (path, content, depth) => {
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (active.has(key)) fail('spec_include_cycle');
    if (depth > 16 || ++visits > 256) fail('spec_include_limit');
    active.add(key);
    const output = [];
    let fence;
    for (const line of content.match(/[^\n]*\n|[^\n]+$/g) || []) {
      const text = line.replace(/\r?\n$/, '');
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
      let value = line;
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      } else if (marker) fence = marker[1];
      else if (/^ {0,3}@include\b/.test(text)) {
        const include = /^ {0,3}@include[ \t]+(.+?)@[ \t]*$/.exec(text);
        if (!include) fail('spec_include_invalid');
        const target = specResourcePath(root, path, include[1]);
        if (!target.toLowerCase().endsWith('.md')) fail('spec_include_invalid');
        const fragment = readSpecResource(target);
        if (/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.test(fragment)) fail('spec_include_metadata');
        value = expand(target, fragment, depth + 1);
        if (line.endsWith('\n') && !value.endsWith('\n')) { value += '\n'; bytes++; }
        if (bytes > 262144) fail('spec_include_limit');
        // Included bytes were counted by the recursive call.
        output.push(value); continue;
      }
      bytes += Buffer.byteLength(value);
      if (bytes > 262144) fail('spec_include_limit');
      output.push(value);
    }
    active.delete(key);
    return output.join('');
  };
  return expand(prompt.path, prompt.content, 0);
}
