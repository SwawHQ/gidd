import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { plainPath } from './storage.mjs';
import { inspectStorage, registryLocation, samePath } from './managed-storage.mjs';
import { idPattern, readRecord } from '../commands/worktree/index.mjs';

const reasonOf = error => /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'data_unreadable';
const key = path => resolve(path).toLowerCase();

// Read-only and independent of config validity. Keep inspecting Git entries
// even when the data manifest or individual records cannot be read. Prefixes
// reserve the current GIDD namespace; other worktrees are outside this check.
export async function inspectData(storage, git, { initializing = false } = {}) {
  const issues = [], entries = new Map(), records = new Map();
  const issue = (reason, path, fields = {}) => issues.push({ reason, path, ...fields });
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
      const empty = !existsSync(storage.path) || readdirSync(storage.path).length === 0;
      if (!empty) issue('data_manifest_missing', storage.path);
      else if (!initializing) issue('data_missing', storage.path);
    }
  } catch (error) { issue(reasonOf(error), storage.path); }

  const directory = registryLocation(storage);
  if (readable) {
    try {
      plainPath(directory);
      for (const name of existsSync(directory) ? readdirSync(directory).sort() : []) {
        if (!name.endsWith('.json')) continue;
        try {
          const record = readRecord(directory, name, storage.path);
          records.set(key(record.path), record);
          entry(record.path).recorded = true;
        } catch (error) { issue(reasonOf(error), join(directory, name)); }
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
    Object.assign(entry(row.path), { registered: true, head: row.head, checked_out_branch: row.branch });
  }
  for (const item of entries.values()) {
    const id = basename(item.path), record = records.get(key(item.path));
    if (!idPattern.test(id)) issue('worktree_id_invalid', item.path);
    if (!samePath(item.path, item.expected_path))
      issue('worktree_path_mismatch', item.path, { expected_path: item.expected_path });
    if (!item.registered) issue('worktree_unregistered', item.path);
    if (!record) issue('worktree_record_missing', item.path);
    try {
      plainPath(item.path);
      item.exists = existsSync(item.path);
      if (!item.exists) { issue('worktree_missing', item.path); continue; }
      if (!lstatSync(item.path).isDirectory()) { issue('worktree_not_directory', item.path); continue; }
      const top = await git(item.path, ['rev-parse', '--show-toplevel']);
      const common = await git(item.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (!samePath(top, item.path) || !samePath(common, storage.common))
        issue('worktree_repository_mismatch', item.path);
    } catch (error) { issue(reasonOf(error), item.path); continue; }
    if (!record || !item.registered) continue;
    if (!record.branch || !record.target_branch || !record.start_commit)
      issue('worktree_delivery_metadata_missing', item.path);
    else if (record.ready_head ? item.checked_out_branch || record.ready_head !== item.head :
      item.checked_out_branch !== record.branch && !(record.cleanup && !item.checked_out_branch && record.cleanup.head === item.head))
      issue('worktree_state_changed', item.path);
  }
  return { path: storage.path, initialized: !!storage.initialized, worktrees: [...entries.values()], issues };
}
