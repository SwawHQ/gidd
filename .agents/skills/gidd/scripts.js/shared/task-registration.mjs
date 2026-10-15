import { existsSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { plainPath } from './storage.mjs';
import { parseList } from '../commands/worktree/index.mjs';
import { sameRepositoryPath } from './repository-command.mjs';
import { readFlow } from './flows.mjs';
import { flowSnapshot, sameFlowSnapshot } from './flow-definition.mjs';
import { readFlowHistory, recordFlowUse } from './flow-history.mjs';
import { resolveRemoteBinding, remoteIdentity, sameRemoteBinding } from './remote-binding.mjs';
import { newTask, readTasks, readTask, saveTask, taskPath, issuePath, saveIssue } from './task-records.mjs';

export function completeTaskRegistration(storage, planned, text) {
  let task = planned;
  if (existsSync(taskPath(storage, planned.issue))) {
    task = readTask(storage, planned.issue);
    if (task.target_branch !== planned.target_branch || task.github_account !== planned.github_account ||
        !sameFlowSnapshot(task.flow, planned.flow) || !sameRemoteBinding(task.delivery.remote, planned.delivery.remote))
      throw new Error('issue_registered');
  }
  const copy = issuePath(storage, task.issue);
  plainPath(copy);
  if (existsSync(copy) && !lstatSync(copy).isFile()) throw new Error('issue_draft_invalid');
  if (task.registration?.complete && existsSync(copy)) return task;
  if (task.registration?.complete) task = { ...task, registration: { ...task.registration, complete: false } };
  if (!task.registration) task = { ...task, registration: { id: randomUUID(), complete: false } };
  saveTask(storage, task);
  if (!existsSync(issuePath(storage, task.issue))) {
    if (typeof text !== 'string') throw new Error('issue_copy_required');
    saveIssue(storage, task.issue, text);
  }
  recordFlowUse(storage, task.flow, task.registration.id);
  task = { ...task, registration: { ...task.registration, complete: true } };
  saveTask(storage, task);
  return task;
}

// Creation and first workspace preparation validate the same saved task plan.
export async function prepareTaskRegistration(repository, options, { storage, git }) {
  readFlowHistory(storage);
  const tasks = readTasks(storage);
  if (!options.flow) throw new Error('task_flow_required');
  const flow = readFlow(options.flow);
  const rows = parseList(await git(repository, ['worktree', 'list', '--porcelain', '-z']));
  const base = rows.find(row => sameRepositoryPath(row.path, repository))?.branch;
  if (!base) throw new Error('delivery_target_branch_required');
  if (/^[-/.]|[\x00-\x20\x7f\\:]/.test(base) || base.startsWith('refs/')) throw new Error('delivery_context_invalid');
  await git(repository, ['check-ref-format', 'refs/heads/' + base]);
  await git(repository, ['rev-parse', '--verify', 'refs/heads/' + base + '^{commit}']);
  const delivery = { mode: flow.mode, remote: remoteIdentity(await resolveRemoteBinding(git, repository, base)) };
  const task = newTask(options.issue, delivery, base);
  task.flow = flowSnapshot(flow);
  return { task, tasks };
}
