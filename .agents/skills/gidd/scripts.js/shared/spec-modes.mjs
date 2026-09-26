import { specFailure } from './spec-resources.mjs';

// Workflow identities have no numbering; public IDs come from directory prefixes.
export const modeNames = Object.freeze(['issue', 'no-issue'].flatMap(issue =>
  ['current-worktree.direct-commit', 'dedicated-worktree.direct-merge', 'dedicated-worktree.pr-merge'].map(rest => issue + '.' + rest)));
const modePattern = '(?:issue|no-issue)\\.(?:current-worktree\\.direct-commit|dedicated-worktree\\.(?:direct-merge|pr-merge))';
export const modeDirectoryPattern = new RegExp('^([0-9]{2})\\.(' + modePattern + ')$');
const modeSelectorPattern = '(?:[0-9]{2}|(?:[0-9]{2}\\.)?' + modePattern + ')';
const modeSelector = new RegExp('^' + modeSelectorPattern + '$');
export const isModeSelector = value => typeof value === 'string' && modeSelector.test(value);
export const authorizationKeys = Object.freeze(['development', 'internal_acceptance', 'add', 'commit',
  'direct_merge', 'direct_merge_error', 'push', 'push_error', 'pr_merge', 'pr_merge_error', 'close_issue', 'cleanup_sync']);
export const stepFiles = Object.freeze(Object.fromEntries(['common', 'task_definition', 'workspace', 'development',
  'internal_acceptance', 'add', 'commit', 'direct_merge', 'direct_merge_error', 'push', 'push_error', 'pr',
  'pr_merge', 'pr_merge_error', 'close_issue', 'cleanup_sync']
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
  const issue = name.startsWith('issue.'), pr = name.endsWith('.pr-merge'), directMerge = name.endsWith('.direct-merge');
  const flow = ['task_definition', 'workspace', 'development', 'internal_acceptance', 'add', 'commit'];
  flow.push(...(pr ? ['push', 'pr', 'pr_merge'] : directMerge ? ['direct_merge', 'push'] : ['push']));
  if (issue) flow.push('close_issue');
  flow.push('cleanup_sync');
  const errors = flow.filter(step => ['push', 'direct_merge', 'pr_merge'].includes(step)).map(step => step + '_error');
  return { name, issue, pr, flow, errors, applicable: new Set([...flow, ...errors]) };
}
