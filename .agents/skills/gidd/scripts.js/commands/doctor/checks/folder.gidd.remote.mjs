import { readRecords } from '../../worktree/index.mjs';
import { verifyRemoteBinding } from '../../../shared/remote-binding.mjs';
import { safeReason } from '../shared/result.mjs';
import { storageLocation, registryLocation } from '../../../shared/managed-storage.mjs';
import { readTasks } from '../../../shared/task-records.mjs';

export const id = 'folder.gidd.remote';
export async function run(context) {
  const data = await context.run('folder.gidd');
  if (data.status === 'ready' && !data.details.initialized) return { id, status: 'ready' };
  for (const dependency of ['folder.gidd', 'folder.git.remote']) {
    if ((await context.run(dependency)).status !== 'ready')
      return { id, status: 'not_checked', reason: 'dependency_unavailable', blocked_by: dependency };
  }
  try {
    const git = async (path, args) => {
      const result = await context.invoke(['-C', path, ...args]);
      if (!result.ok) throw new Error('remote_unavailable');
      return result.text;
    };
    const issues = [];
    const storage = await storageLocation(context.configRoot, git);
    const tasks = readTasks(storage);
    const records = readRecords(registryLocation(storage), storage.path).filter(record => !record.ready_head);
    for (const record of [...tasks, ...records.filter(record => !tasks.some(task => task.issue === record.issue))]) {
      try { await verifyRemoteBinding(git, context.configRoot, record); }
      catch (error) { issues.push({ issue: record.issue,
        code: safeReason(error, 'remote_unavailable'), ...error.details }); }
    }
    return { id, status: issues.length ? 'invalid' : 'ready',
      ...(issues.length ? { reason: 'delivery_remote_changed', details: { issues } } : {}) };
  } catch (error) { return { id, status: 'invalid', reason: safeReason(error, 'remote_unavailable') }; }
}
