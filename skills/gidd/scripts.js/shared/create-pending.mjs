import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { atomicWrite, readJson, samePath } from './managed-storage.mjs';
import { validTask } from './task-records.mjs';
import { parsePolicySelector } from './policy-definition.mjs';

export const createPendingPath = storage => join(storage.path, 'create-pending.json');
const fail = () => { throw new Error('issue_creation_record_invalid'); };
function validRecord(record) {
  try {
    const confirmed = ['created', 'ready'].includes(record?.phase);
    return record?.schema === 'gidd.create-pending/v1' &&
      Object.keys(record).every(key => ['schema', 'request', 'source', 'sha256', 'policy', 'phase', 'task'].includes(key)) &&
      typeof record.request === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.request) &&
      typeof record.source === 'string' && isAbsolute(record.source) && !/[\x00-\x1f\x7f]/.test(record.source) &&
      typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256) &&
      ['planned', 'creating', 'created', 'ready'].includes(record.phase) && !!parsePolicySelector(record.policy) &&
      record.task && ['workspace', 'start_commit', 'registration', 'preparation'].every(key => record.task[key] === undefined) &&
      (confirmed ? Number.isSafeInteger(record.task.issue) && record.task.issue > 0 : record.task.issue === undefined) &&
      validTask({ ...record.task, issue: confirmed ? record.task.issue : 1 });
  } catch { return false; }
}
export function readCreatePending(storage) {
  const path = createPendingPath(storage);
  if (!existsSync(path)) return null;
  let record;
  try { record = readJson(path); } catch { fail(); }
  if (!validRecord(record)) fail();
  return record;
}
export function saveCreatePending(storage, record) {
  if (!validRecord(record)) fail();
  atomicWrite(createPendingPath(storage), JSON.stringify(record) + '\n');
}
export const sameCreationRequest = (record, source, sha256, policy) =>
  samePath(record.source, source) && record.sha256 === sha256 && record.policy === policy;
export const newCreatePending = (source, sha256, policy, task) => ({
  schema: 'gidd.create-pending/v1', request: randomUUID(), source, sha256, policy, phase: 'planned', task,
});
