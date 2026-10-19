import { existsSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { plainPath } from './storage.mjs';
import { parseList } from '../commands/worktree/index.mjs';
import { sameRepositoryPath } from './repository-command.mjs';
import { readPolicy } from './policies.mjs';
import { policySnapshot, samePolicySnapshot } from './policy-definition.mjs';
import { readPolicyHistory, recordPolicyUse } from './policy-history.mjs';
import { resolveRemoteBinding, remoteIdentity, sameRemoteBinding } from './remote-binding.mjs';
import { newTask, readTasks, readTask, saveTask, taskPath, issuePath, saveIssue } from './task-records.mjs';

export function completeTaskRegistration(storage, planned, text) {
  let task = planned;
  if (existsSync(taskPath(storage, planned.issue))) {
    task = readTask(storage, planned.issue);
    if (task.target_branch !== planned.target_branch || task.github_account !== planned.github_account ||
        !samePolicySnapshot(task.policy, planned.policy) || !sameRemoteBinding(task.delivery.remote, planned.delivery.remote))
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
  recordPolicyUse(storage, task.policy, task.registration.id);
  task = { ...task, registration: { ...task.registration, complete: true } };
  saveTask(storage, task);
  return task;
}

// Creation and first workspace preparation validate the same saved task plan.
export async function prepareTaskRegistration(repository, options, { storage, git }) {
  readPolicyHistory(storage);
  const tasks = readTasks(storage);
  if (!options.policy) throw new Error('task_policy_required');
  const policy = readPolicy(options.policy);
  const rows = parseList(await git(repository, ['worktree', 'list', '--porcelain', '-z']));
  const base = rows.find(row => sameRepositoryPath(row.path, repository))?.branch;
  if (!base) throw new Error('delivery_target_branch_required');
  if (/^[-/.]|[\x00-\x20\x7f\\:]/.test(base) || base.startsWith('refs/')) throw new Error('delivery_context_invalid');
  await git(repository, ['check-ref-format', 'refs/heads/' + base]);
  await git(repository, ['rev-parse', '--verify', 'refs/heads/' + base + '^{commit}']);
  const delivery = { mode: policy.mode, remote: remoteIdentity(await resolveRemoteBinding(git, repository, base)) };
  const task = newTask(options.issue, delivery, base);
  task.policy = policySnapshot(policy);
  return { task, tasks };
}
