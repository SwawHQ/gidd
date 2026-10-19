import { readPolicyHistory } from '../../../shared/policy-history.mjs';
import { loadSavedPolicy } from '../../../shared/policies.mjs';
import { readTasks, taskPath } from '../../../shared/task-records.mjs';
export const id = 'folder.gidd.policy';
export async function run(context) {
  const storage = await context.run('folder.gidd');
  if (storage.status !== 'ready')
    return { id, status: 'not_checked', reason: 'dependency_unavailable', blocked_by: 'folder.gidd' };
  try {
    const data = { path: storage.details.path };
    const history = readPolicyHistory(data);
    const tasks = readTasks(data);
    for (const task of tasks) {
      const policy = loadSavedPolicy(task.policy, taskPath(data, task.issue));
      if (!policy.available_languages.length) throw new Error('policy_language_unavailable');
    }
    return { id, status: 'ready', details: { entries: history.length, tasks: tasks.length } };
  } catch (error) { return { id, status: 'invalid', reason: error.message, details: {
    ...(error.path ? { path: error.path } : {}), ...(error.field ? { field: error.field } : {}),
    ...(error.conflicts ? { conflicts: error.conflicts } : {}) } }; }
}
