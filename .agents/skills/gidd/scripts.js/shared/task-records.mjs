import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { atomicWrite, initializeStorage, readJson } from './managed-storage.mjs';
import { plainPath } from './storage.mjs';
import { validRemoteBinding } from './remote-binding.mjs';
import { validFlowSnapshot } from './flow-definition.mjs';

const fail = () => { throw new Error('task_invalid'); };
const number = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function taskDirectory(storage, issue) {
  if (!number(issue)) fail();
  const path = join(storage.path, String(issue));
  if (dirname(resolve(path)) !== resolve(storage.path)) fail();
  plainPath(path);
  return path;
}
export const taskPath = (storage, issue) => join(taskDirectory(storage, issue), 'state.json');
export const issuePath = (storage, issue) => join(taskDirectory(storage, issue), 'issue.md');
export function readDraft(path) {
  plainPath(path);
  if (!existsSync(path)) throw new Error('issue_draft_missing');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('issue_draft_invalid');
  const bytes = readFileSync(path);
  if (bytes.length > 1024 * 1024) throw new Error('issue_draft_invalid');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('issue_draft_invalid'); }
  const match = /^\uFEFF?(?:[ \t]*\r?\n)*# ([^\r\n]*)(?:\r?\n|$)/.exec(text);
  if (!match || /[\x00-\x1f\x7f]/.test(match[1])) throw new Error('issue_draft_invalid');
  const subject = match[1].trim().replace(/^(?:\[gidd\]\s*)+/i, '').trim();
  if (!subject) throw Object.assign(new Error('issue_title_empty'), { details: { path, title: match[1] } });
  const title = '[gidd] ' + subject;
  // Keep the source file untouched. The stored copy uses the submitted title
  // and preserves the draft's body, line endings and optional UTF-8 BOM.
  return { title, sha256: createHash('sha256').update(bytes).digest('hex'), body: text.slice(match[0].length).replace(/^\r?\n/, ''),
    text: text.replace(/^(\uFEFF?(?:[ \t]*\r?\n)*# )[^\r\n]*/, (_, heading) => heading + title) };
}
export const saveIssue = (storage, issue, text) => atomicWrite(issuePath(storage, issue), text);
export function validTask(record) {
  return record?.schema === 'gidd.task/v1' &&
    Object.keys(record).every(key => ['schema', 'target_branch', 'delivery', 'issue', 'workspace', 'start_commit', 'flow', 'github_account', 'registration', 'preparation'].includes(key)) &&
    (record.registration === undefined || record.registration && Object.keys(record.registration).length === 2 &&
      uuid(record.registration.id) && typeof record.registration.complete === 'boolean') &&
    (record.preparation === undefined || record.preparation &&
      Object.keys(record.preparation).every(key => ['start_commit', 'previous_commit', 'reference'].includes(key)) &&
      oid(record.preparation.start_commit) && oid(record.preparation.previous_commit) &&
      (record.preparation.reference === undefined || typeof record.preparation.reference === 'string' && record.preparation.reference.startsWith('refs/gidd/delivery/') &&
        uuid(record.preparation.reference.slice('refs/gidd/delivery/'.length)))) &&
    validFlowSnapshot(record.flow) && record.flow.mode === record.delivery?.mode &&
    typeof record.github_account === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/i.test(record.github_account) &&
    typeof record.target_branch === 'string' && !!record.target_branch &&
    !/^[-/.]|[\x00-\x20\x7f\\:]/.test(record.target_branch) && !record.target_branch.startsWith('refs/') &&
    record.delivery && Object.keys(record.delivery).length === 2 &&
    ['direct-commit', 'direct-merge', 'pr-merge'].includes(record.delivery.mode) && validRemoteBinding(record.delivery.remote) &&
    Number.isSafeInteger(record.issue) && record.issue > 0 &&
    (record.workspace === undefined ? record.start_commit === undefined :
      record.delivery.mode === 'direct-commit' ? record.workspace === 'target' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.start_commit) :
        typeof record.workspace === 'string' && /^gidd-wt-[a-f0-9-]{36}$/.test(record.workspace) && record.start_commit === undefined);
}
export function readTask(storage, issue) {
  const path = taskPath(storage, issue);
  plainPath(path);
  if (!existsSync(path)) throw new Error('task_required');
  if (!lstatSync(path).isFile() || lstatSync(path).size > 4096) fail();
  const record = readJson(path);
  if (!validTask(record) || record.issue !== Number(issue)) fail();
  return record;
}
export function readTasks(storage) {
  plainPath(storage.path);
  return (existsSync(storage.path) ? readdirSync(storage.path).sort() : [])
    .filter(name => number(name) && existsSync(taskPath(storage, name))).map(name => readTask(storage, name));
}
export function saveTask(storage, record) {
  if (!validTask(record)) fail();
  initializeStorage(storage);
  atomicWrite(taskPath(storage, record.issue), JSON.stringify(record) + '\n');
}
export function newTask(issue, delivery, target_branch) {
  return { schema: 'gidd.task/v1', issue, target_branch, delivery };
}
export function prepareTaskStorage(storage) {
  initializeStorage(storage);
  const probe = join(storage.path, '.' + randomUUID() + '.tmp');
  writeFileSync(probe, '', { flag: 'wx' });
  unlinkSync(probe);
}
export function removeTask(storage, issue) {
  const directory = taskDirectory(storage, issue);
  readTask(storage, issue);
  // Audit this numeric directory before any recursive removal. Reparse points
  // cannot redirect cleanup outside the repository's data directory.
  const inspect = path => {
    plainPath(path);
    if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
  };
  inspect(directory);
  // Keep state until other files are gone, so locked files leave a retryable task.
  for (const name of readdirSync(directory)) if (name !== 'state.json')
    rmSync(join(directory, name), { recursive: true });
  unlinkSync(taskPath(storage, issue));
  rmdirSync(directory);
}
