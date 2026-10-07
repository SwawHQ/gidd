import { specFailure } from './spec-resources.mjs';

// Workflow identities have no numbering; public IDs come from directory prefixes.
export const modeNames = Object.freeze(['direct-commit', 'direct-merge', 'pr-merge']);
const modePattern = '(?:' + modeNames.join('|') + ')';
export const modeDirectoryPattern = new RegExp('^([0-9]{2})\\.(' + modePattern + ')$');
const modeSelectorPattern = '(?:[0-9]{2}|(?:[0-9]{2}\\.)?' + modePattern + ')';
const modeSelector = new RegExp('^' + modeSelectorPattern + '$');
export const isModeSelector = value => typeof value === 'string' && modeSelector.test(value);
export const authorizationKeys = Object.freeze(['development', 'internal_acceptance', 'add', 'commit',
  'direct_merge', 'direct_merge_error', 'push', 'push_error', 'pr_merge', 'pr_merge_error',
  'target_sync', 'target_sync_error', 'close_issue', 'cleanup']);
export const stepFiles = Object.freeze(Object.fromEntries(['common', 'task_definition', 'workspace', 'development',
  'internal_acceptance', 'add', 'commit', 'direct_merge', 'direct_merge_error', 'push', 'push_error', 'pr_create',
  'pr_merge', 'pr_merge_error', 'target_sync', 'target_sync_error', 'close_issue', 'cleanup']
  .map((step, index) => [step, String(index).padStart(2, '0') + '.' + step.replaceAll('_', '-') + '.toml'])));
const presetPattern = '(?:[0-9]{2}\\.)?[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)*';
export const presetNamePattern = new RegExp('^' + presetPattern + '$');
const specNamePattern = new RegExp('^' + modeSelectorPattern + '/(?:[0-9]{2}|' + presetPattern + ')$');

export function parseSpecName(selector) {
  if (typeof selector !== 'string' || !specNamePattern.test(selector)) throw specFailure('spec_current_unsupported');
  const [mode, name] = selector.split('/');
  if (name === 'description' || name.endsWith('.toml')) throw specFailure('spec_current_unsupported');
  return { mode, name };
}

// Product modes, not a configurable workflow engine. Error branches are separate
// from the normal path and never inherit another stage's grant.
export function modePlan(name) {
  if (!modeNames.includes(name)) throw specFailure('spec_mode_unsupported');
  const pr = name === 'pr-merge', directMerge = name === 'direct-merge';
  const flow = ['task_definition', 'workspace', 'development', 'internal_acceptance', 'add', 'commit'];
  flow.push(...(pr ? ['push', 'pr_create', 'pr_merge'] : directMerge ? ['direct_merge', 'push'] : ['push']));
  // PR delivery updates the remote target. Synchronize the local target before
  // closing the Issue; a blocked sync preserves the delivered result and resources.
  if (pr) flow.push('target_sync');
  flow.push('close_issue');
  flow.push('cleanup');
  const errors = flow.filter(step => ['push', 'direct_merge', 'pr_merge', 'target_sync'].includes(step)).map(step => step + '_error');
  return { name, pr, flow, errors, applicable: new Set([...flow, ...errors]) };
}
