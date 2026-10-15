import { issueNumber } from '../../shared/issues.mjs';
import { resolveLanguage } from '../../shared/language.mjs';
import { withSignals } from '../../shared/signals.mjs';
import { executeTaskOperation } from '../../shared/task-operations.mjs';
import { runIssueTaskFlow } from './flow.mjs';

const fail = reason => { throw new Error(reason); };

export function parseIssueTaskArguments(route, args) {
  const taskRoute = /^([1-9][0-9]*)(?:\.(push|merge|target-sync|close-issue|cleanup|flow(?:\.set)?))?$/.exec(route);
  if (!taskRoute || !issueNumber(taskRoute[1])) fail('invalid_arguments');
  const action = taskRoute[2] ?? (args.length ? 'workspace' : 'status'), result = { action, issue: Number(taskRoute[1]) }, rest = [...args];
  if (action === 'flow') {
    if (!rest.length) return result;
    if (rest.length !== 2 || rest[0] !== '--lang' || typeof rest[1] !== 'string' || !rest[1] || rest[1].startsWith('--')) fail('invalid_arguments');
    result.lang = resolveLanguage(rest[1]);
    return result;
  }
  if (action === 'flow.set') {
    if (rest.length !== 1) fail('invalid_arguments');
    result.flow = rest.shift();
    if (typeof result.flow !== 'string' || !result.flow.trim() || result.flow.startsWith('-') || /[\x00-\x1f\x7f]/.test(result.flow)) fail('invalid_arguments');
    return result;
  }
  if (action === 'workspace') {
    if (rest.length !== 2 || rest[0] !== '--flow' || typeof rest[1] !== 'string' || !rest[1].trim() ||
        rest[1].startsWith('-') || /[\x00-\x1f\x7f]/.test(rest[1])) fail('invalid_arguments');
    result.flow = rest[1];
    return result;
  }
  while (rest.length) {
    const flag = rest.shift();
    if (action === 'merge' && ['--merge', '--squash', '--rebase'].includes(flag) && !result.method) result.method = flag.slice(2);
    else if (action === 'merge' && flag === '--message' && result.message === undefined &&
      typeof rest[0] === 'string' && rest[0].trim() && !/[\x00-\x1f\x7f]/.test(rest[0])) result.message = rest.shift();
    else fail('invalid_arguments');
  }
  if (result.method === 'rebase' && result.message) fail('invalid_arguments');
  return result;
}

export const issueTaskCommand = executeTaskOperation;

export const runIssueTask = (repository, options) => options.action === 'flow'
  ? runIssueTaskFlow(repository, options)
  : withSignals(signal => issueTaskCommand(repository, options, { signal }));
