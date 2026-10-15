import { resolve } from 'node:path';
import { createIssue } from '../../shared/issues.mjs';
import { repositoryConnection } from '../../shared/repository-remote.mjs';
import { repositoryCommandContext } from '../../shared/repository-command.mjs';
import { completeTaskRegistration, prepareTaskRegistration } from '../../shared/task-registration.mjs';
import { sameRemoteBinding, verifyRemoteBinding } from '../../shared/remote-binding.mjs';
import { readDraft, readTask, prepareTaskStorage } from '../../shared/task-records.mjs';
import { createPendingPath, newCreatePending, readCreatePending, sameCreationRequest, saveCreatePending } from '../../shared/create-pending.mjs';
import { executeTaskOperation } from '../../shared/task-operations.mjs';
import { withSignals } from '../../shared/signals.mjs';

export function parseIssueArguments(route, args) {
  if (route !== 'issue') throw new Error('invalid_arguments');
  const result = { action: 'create' }, rest = [...args];
  while (rest.length) {
    const flag = rest.shift(), value = rest.shift();
    if (!['--flow', '--file'].includes(flag) || typeof value !== 'string' || !value.trim() ||
        value.startsWith('-') || /[\x00-\x1f\x7f]/.test(value) || Object.hasOwn(result, flag.slice(2))) throw new Error('invalid_arguments');
    result[flag.slice(2)] = value;
  }
  if (result.file === undefined) throw new Error('invalid_arguments');
  return result;
}

export async function issueCommand(repository, options, { execute, signal, cwd = process.cwd() } = {}) {
  if (options.action !== 'create') throw new Error('invalid_arguments');
  const context = await repositoryCommandContext(repository, { execute, signal, cwd, required: false });
  const { storage, lease } = context;
  let task;
  try {
    // Read the complete body before authentication or remote writes.
    const source = resolve(cwd, options.file), draft = readDraft(source), sha256 = draft.sha256;
    let pending = readCreatePending(storage), tasks;
    if (pending && !sameCreationRequest(pending, source, sha256, options.flow)) {
      if (pending.phase === 'created') {
        let saved;
        try { saved = readTask(storage, pending.task.issue); }
        catch (error) { if (error.message !== 'task_required') throw error; }
        const planned = pending.task;
        if (saved?.registration?.complete && saved.workspace && !saved.preparation &&
            saved.target_branch === planned.target_branch && saved.github_account === planned.github_account &&
            sameRemoteBinding(saved.delivery.remote, planned.delivery.remote)) {
          pending.phase = 'ready'; saveCreatePending(storage, pending);
        }
      }
      if (pending.phase !== 'ready') throw Object.assign(new Error('issue_creation_pending'), {
        details: { path: createPendingPath(storage), source: pending.source, request: pending.request, issue: pending.task.issue },
      });
      pending = null;
    }
    if (pending) {
      task = pending.task;
      if (pending.phase === 'creating') throw Object.assign(new Error('issue_creation_unconfirmed'), {
        details: { path: createPendingPath(storage), source: pending.source, request: pending.request },
      });
    } else ({ task, tasks } = await prepareTaskRegistration(repository, options, context));
    await verifyRemoteBinding(context.git, repository, task);
    await context.ensureData();
    prepareTaskStorage(storage);
    if (!pending || pending.phase === 'planned') {
      const connection = await repositoryConnection(repository, { execute, signal, github: true, record: task });
      task.github_account = connection.target.account;
      if (!pending) {
        pending = newCreatePending(source, sha256, options.flow, task);
        saveCreatePending(storage, pending);
      }
      const issue = await createIssue(connection, draft.title, draft.body, { beforeWrite: () => {
        pending.phase = 'creating'; saveCreatePending(storage, pending);
      } });
      task.issue = issue.number;
      pending.phase = 'created'; saveCreatePending(storage, pending);
      // A changed remote must not replace a task with the same Issue number.
      if (tasks?.some(item => item.issue === task.issue)) throw new Error('issue_registered');
    }
    task = completeTaskRegistration(storage, task, draft.text);
    const report = await executeTaskOperation(repository, { action: 'workspace', issue: task.issue },
      { execute, signal, cwd, context });
    if (report.status === 'ready') { pending.phase = 'ready'; saveCreatePending(storage, pending); }
    return { ...report, issue_created: true };
  } catch (error) {
    if (task) error.workspace = { ...error.workspace,
      issue: task.issue, target_repository: repository, target_branch: task.target_branch,
      delivery: task.delivery, flow: task.flow, github_account: task.github_account,
      ...(task.issue ? { issue_created: true,
        ...(error.message === 'issue_registered' ? {} : { retry: task.issue + ' --flow ' + task.flow.selector }) } : {}) };
    throw error;
  } finally { lease.release(); }
}

export const runIssue = (repository, options) => withSignals(signal => issueCommand(repository, options, { signal }));
