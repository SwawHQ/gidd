import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { plainPath } from './storage.mjs';
import { inspectStorage, registryLocation, samePath, readRegistry } from './managed-storage.mjs';
import { idPattern, readRecord } from '../commands/worktree/index.mjs';
import { branchDetails } from './workspace-branch.mjs';
import { readTask } from './task-records.mjs';
import { createPendingPath, readCreatePending } from './create-pending.mjs';

const reasonOf = error => /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'data_unreadable';
const key = path => resolve(path).toLowerCase();

// Read-only and independent of config validity. Keep inspecting Git entries
// even when the data manifest or individual records cannot be read. Prefixes
// reserve the current GIDD namespace; other worktrees are outside this check.
export async function inspectData(storage, git, { initializing = false } = {}) {
  const issues = [], entries = new Map(), records = new Map();
  const issue = (code, path, fields = {}) => issues.push({ code, path, ...fields });
  const entry = path => {
    path = resolve(path);
    const id = key(path);
    if (!entries.has(id)) entries.set(id, { path, expected_path: join(storage.path, basename(path)) });
    return entries.get(id);
  };
  let readable = false;
  try {
    plainPath(storage.path);
    if (existsSync(storage.path) && !lstatSync(storage.path).isDirectory()) throw new Error('data_not_directory');
    readable = true;
    inspectStorage(storage);
    if (!storage.initialized) {
      const empty = !existsSync(storage.path) || readdirSync(storage.path).every(name => join(storage.path, name) === storage.lock);
      if (!empty) issue('data_manifest_missing', storage.path);
      else if (!initializing) issue('data_missing', storage.path);
    }
  } catch (error) { issue(reasonOf(error), storage.path); }

  const directory = registryLocation(storage);
  if (readable) {
    try {
      const pending = readCreatePending(storage);
      if (pending && pending.phase !== 'ready') issue(pending.phase === 'creating' ? 'issue_creation_unconfirmed' : 'issue_creation_pending',
        createPendingPath(storage), { ...(pending.task.issue ? { issue: pending.task.issue } : {}) });
    } catch (error) { issue(reasonOf(error), createPendingPath(storage)); }
    try {
      for (const name of existsSync(storage.path) ? readdirSync(storage.path) : []) {
        if (!/^[1-9][0-9]*$/.test(name)) continue;
        try {
          const task = readTask(storage, name), path = join(storage.path, name, 'state.json');
          if (task.registration?.complete === false) issue('task_registration_pending', path, { issue: task.issue });
          if (task.preparation) issue('worktree_preparation_pending', path, { issue: task.issue });
        }
        catch (error) { issue(reasonOf(error), join(storage.path, name, 'state.json')); }
      }
    } catch (error) { issue(reasonOf(error), storage.path); }
    try {
      if (existsSync(directory)) {
        const registry = readRegistry(directory);
        for (const id of Object.keys(registry.worktrees).sort()) {
          try {
            const record = readRecord(directory, id, storage.path, registry);
            records.set(key(record.path), record);
            entry(record.path).recorded = true;
          } catch (error) { issue(reasonOf(error), directory, { worktree: id }); }
        }
      }
    } catch (error) { issue(reasonOf(error), directory); }
    try {
      for (const name of existsSync(storage.path) ? readdirSync(storage.path).sort() : [])
        if (name.startsWith('gidd-wt-')) entry(join(storage.path, name));
    } catch (error) { issue(reasonOf(error), storage.path); }
  }

  for (const row of storage.rows) {
    if (!basename(row.path).startsWith('gidd-wt-')) continue;
    // The target checkout is never a managed dedicated worktree, even if the
    // user chose a repository name starting with the reserved prefix.
    if (samePath(row.path, storage.main)) continue;
    Object.assign(entry(row.path), { registered: true, head: row.head });
  }
  for (const item of entries.values()) {
    const id = basename(item.path), record = records.get(key(item.path));
    if (record?.branch) item.branch = record.branch;
    if (!idPattern.test(id)) issue('worktree_id_invalid', item.path);
    if (!samePath(item.path, item.expected_path))
      issue('worktree_path_mismatch', item.path, { expected_path: item.expected_path });
    if (record?.preparation) issue('worktree_preparation_pending', item.path, { issue: record.issue });
    if (!item.registered && !record?.preparation) issue('worktree_unregistered', item.path);
    if (!record) issue('worktree_record_missing', item.path);
    try {
      plainPath(item.path);
      item.exists = existsSync(item.path);
      if (!item.exists) { if (!record?.preparation) issue('worktree_missing', item.path); continue; }
      if (!lstatSync(item.path).isDirectory()) { issue('worktree_not_directory', item.path); continue; }
      const top = await git(item.path, ['rev-parse', '--show-toplevel']);
      const common = await git(item.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (!samePath(top, item.path) || !samePath(common, storage.common))
        issue('worktree_repository_mismatch', item.path);
    } catch (error) { issue(reasonOf(error), item.path); continue; }
    if (!record || !item.registered || record.preparation) continue;
    if (!record.branch || !record.target_branch || !record.start_commit)
      issue('worktree_delivery_metadata_missing', item.path);
    else {
      const checkout = storage.rows.find(row => samePath(row.path, item.path));
      const mismatch = record.ready_head ? checkout.branch || record.ready_head !== item.head :
        checkout.branch !== record.branch && !(record.cleanup && checkout.detached && record.cleanup.head === item.head);
      if (mismatch) issue('worktree_state_changed', item.path, {
        ...branchDetails(record.ready_head ? null : record.branch, checkout.branch),
      });
    }
  }
  return { path: storage.path, initialized: !!storage.initialized, worktrees: [...entries.values()], issues };
}
