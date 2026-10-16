import { policyFailure } from './policy-resources.mjs';

// Delivery mode names have no numbering; public IDs come from directory prefixes.
export const deliveryModeNames = Object.freeze(['direct-commit', 'direct-merge', 'pr-merge']);
const deliveryModePattern = '(?:' + deliveryModeNames.join('|') + ')';
export const deliveryModeDirectoryPattern = new RegExp('^([0-9]{2})\\.(' + deliveryModePattern + ')$');
const deliveryModeSelectorPattern = '(?:[0-9]{2}|(?:[0-9]{2}\\.)?' + deliveryModePattern + ')';
const deliveryModeSelector = new RegExp('^' + deliveryModeSelectorPattern + '$');
export const isDeliveryModeSelector = value => typeof value === 'string' && deliveryModeSelector.test(value);
export const authorizationKeys = Object.freeze(['development', 'internal_acceptance', 'add', 'commit',
  'direct_merge', 'direct_merge_error', 'push', 'push_error', 'pr_merge', 'pr_merge_error',
  'target_sync', 'target_sync_error', 'close_issue', 'cleanup']);
export const stepFiles = Object.freeze(Object.fromEntries(['common', 'task_definition', 'workspace', 'development',
  'internal_acceptance', 'add', 'commit', 'direct_merge', 'direct_merge_error', 'push', 'push_error', 'pr_create',
  'pr_merge', 'pr_merge_error', 'target_sync', 'target_sync_error', 'close_issue', 'cleanup']
  .map((step, index) => [step, String(index).padStart(2, '0') + '.' + step.replaceAll('_', '-') + '.toml'])));
const presetPattern = '(?:[0-9]{2}\\.)?[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)*';
export const presetNamePattern = new RegExp('^' + presetPattern + '$');
const policySelectorPattern = new RegExp('^' + deliveryModeSelectorPattern + '/(?:[0-9]{2}|' + presetPattern + ')$');

export function parsePolicySelector(selector) {
  if (typeof selector !== 'string' || !policySelectorPattern.test(selector)) throw policyFailure('policy_selector_invalid');
  const [mode, name] = selector.split('/');
  if (name === 'description' || name.endsWith('.toml')) throw policyFailure('policy_selector_invalid');
  return { mode, name };
}

// Product modes define fixed steps. Error branches are separate
// from the normal path and never inherit another stage's grant.
export function deliveryModePlan(name) {
  if (!deliveryModeNames.includes(name)) throw policyFailure('policy_mode_unsupported');
  const pr = name === 'pr-merge', directMerge = name === 'direct-merge';
  const steps = ['task_definition', 'workspace', 'development', 'internal_acceptance', 'add', 'commit'];
  steps.push(...(pr ? ['push', 'pr_create', 'pr_merge'] : directMerge ? ['direct_merge', 'push'] : ['push']));
  // PR delivery updates the remote target. Synchronize the local target before
  // closing the Issue; a blocked sync preserves the delivered result and resources.
  if (pr) steps.push('target_sync');
  steps.push('close_issue');
  steps.push('cleanup');
  const errors = steps.filter(step => ['push', 'direct_merge', 'pr_merge', 'target_sync'].includes(step)).map(step => step + '_error');
  return { name, pr, steps, errors, applicable: new Set([...steps, ...errors]) };
}

export const policySnapshot = policy => ({ selector: policy.selector, mode: policy.mode,
  authorization: Object.fromEntries(authorizationKeys.map(key => [key, policy.authorization[key]])) });
export const samePolicySnapshot = (left, right) => left.selector === right.selector && left.mode === right.mode &&
  authorizationKeys.every(key => left.authorization[key] === right.authorization[key]);
export function validPolicySnapshot(policy) {
  try {
    if (!policy || Object.keys(policy).some(key => !['selector', 'mode', 'authorization'].includes(key))) return false;
    const parsed = parsePolicySelector(policy.selector);
    if (!/^[0-9]{2}\./.test(parsed.mode) || !parsed.mode.endsWith('.' + policy.mode)) return false;
    const { applicable } = deliveryModePlan(policy.mode);
    return policy.authorization && Object.keys(policy.authorization).length === authorizationKeys.length &&
      authorizationKeys.every(key => (applicable.has(key) ? ['auto', 'ask'] : ['not_applicable']).includes(policy.authorization[key]));
  } catch { return false; }
}
