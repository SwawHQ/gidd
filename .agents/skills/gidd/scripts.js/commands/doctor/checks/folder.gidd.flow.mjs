import { readFlowHistory } from '../../../shared/flow-history.mjs';
import { loadSavedFlow } from '../../../shared/flows.mjs';
import { readTasks, taskPath } from '../../../shared/task-records.mjs';
export const id = 'folder.gidd.flow';
export async function run(context) {
  const storage = await context.run('folder.gidd');
  if (storage.status !== 'ready')
    return { id, status: 'not_checked', reason: 'dependency_unavailable', blocked_by: 'folder.gidd' };
  try {
    const data = { path: storage.details.path };
    const history = readFlowHistory(data);
    const tasks = readTasks(data);
    for (const task of tasks) {
      const flow = loadSavedFlow(task.flow, taskPath(data, task.issue));
      if (!flow.available_languages.length) throw new Error('flow_language_unavailable');
    }
    return { id, status: 'ready', details: { entries: history.length, tasks: tasks.length } };
  } catch (error) { return { id, status: 'invalid', reason: error.message, details: {
    ...(error.path ? { path: error.path } : {}), ...(error.field ? { field: error.field } : {}),
    ...(error.conflicts ? { conflicts: error.conflicts } : {}) } }; }
}
