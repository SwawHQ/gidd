import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { plainPath } from './storage.mjs';
import { parseList } from './git-worktrees.mjs';

const fail = reason => { throw new Error(reason); };
const canonical = path => existsSync(path) ? realpathSync.native(path) :
  dirname(resolve(path)) === resolve(path) ? resolve(path) : join(canonical(dirname(resolve(path))), basename(path));
export const samePath = (a, b) => canonical(a).toLowerCase() === canonical(b).toLowerCase();
const inside = (parent, child) => {
  const value = relative(canonical(parent), canonical(child));
  return value === '' || !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep);
};
export function readJson(path) {
  plainPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) fail('data_record_invalid');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail('data_record_invalid'); }
}
export function atomicWrite(path, content) {
  plainPath(path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(temporary, 'wx');
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
const writeJson = (path, record) => atomicWrite(path, JSON.stringify(record) + '\n');
function removeLockOwner(path, marker) {
  plainPath(path);
  try { unlinkSync(join(path, marker)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { rmdirSync(path); }
  catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; }
}
// First initialization and existing operations share the data-directory lock.
// It protects a command, not an agent session or task ownership.
// Only a provably dead PID is reclaimed.
export function acquireStorageLock(storage, lease) {
  if (lease?.path === storage.lock) return lease;
  plainPath(storage.lock);
  const created = !existsSync(dirname(storage.lock));
  mkdirSync(dirname(storage.lock), { recursive: true });
  const token = randomUUID(), marker = `owner-${token}.json`;
  // Competing lock preparation must not make an empty data directory occupied.
  const prepared = dirname(storage.lock) + '.lock-' + token + '.tmp';
  try {
    mkdirSync(prepared);
    writeFileSync(join(prepared, marker), JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
    for (let attempt = 0; attempt < 4; attempt++) {
      if (existsSync(storage.lock)) {
        let entries;
        try {
          plainPath(storage.lock);
          if (!lstatSync(storage.lock).isDirectory()) fail('data_locked');
          entries = readdirSync(storage.lock);
          if (!entries.length) {
            try { rmdirSync(storage.lock); }
            catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; }
            continue;
          }
          if (entries.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(entries[0])) fail('data_locked');
          const owner = readJson(join(storage.lock, entries[0]));
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || entries[0] !== `owner-${owner.token}.json`) fail('data_locked');
          try { process.kill(owner.pid, 0); fail('data_locked'); }
          catch (probe) { if (probe.code !== 'ESRCH') fail('data_locked'); }
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          fail('data_locked');
        }
        // A stale remover can delete only the marker it inspected.
        removeLockOwner(storage.lock, entries[0]);
        continue;
      }
      try { renameSync(prepared, storage.lock); }
      catch (error) { if (existsSync(storage.lock)) continue; throw error; }
      return { path: storage.lock, release() {
        removeLockOwner(storage.lock, marker);
        if (created) {
          try { rmdirSync(dirname(storage.lock)); }
          catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; }
        }
      } };
    }
    fail('data_locked');
  } finally {
    if (existsSync(prepared)) removeLockOwner(prepared, marker);
  }
}

export async function storageLocation(repository, git) {
  const rows = parseList(await git(repository, ['worktree', 'list', '--porcelain', '-z']));
  const main = rows[0];
  if (!main?.path || main.bare) fail('worktree_main_unavailable');
  const common = await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  plainPath(common);
  const path = canonical(main.path) + '.gidd';
  return { path, main: main.path, common, rows, lock: join(path, '.lock') };
}

export async function locateStorage(repository, git, { required = true } = {}) {
  return inspectStorage(await storageLocation(repository, git), { required });
}

export function inspectStorage(storage, { required = false } = {}) {
  const { path, main, common } = storage;
  plainPath(path);
  if (inside(main, path) || inside(path, main) || inside(common, path) || inside(path, common)) fail('data_path_overlap');
  storage.initialized = false;
  const manifest = join(path, 'storage.json');
  if (existsSync(manifest)) {
    const owner = readJson(manifest);
    if (owner.schema !== 'gidd.storage/v1' ||
        typeof owner.repository !== 'string' || !isAbsolute(owner.repository) || typeof owner.git_common_dir !== 'string' || !isAbsolute(owner.git_common_dir) ||
        !samePath(owner.repository, main) || !samePath(owner.git_common_dir, common)) fail('data_repository_mismatch');
    if (!owner.worktrees || typeof owner.worktrees !== 'object' || Array.isArray(owner.worktrees)) fail('data_record_invalid');
    storage.initialized = true;
  } else if (required) fail('data_missing');
  return storage;
}

export const registryLocation = storage => join(storage.path, 'storage.json');
export function readRegistry(path) {
  const record = readJson(path);
  if (!record.worktrees || typeof record.worktrees !== 'object' || Array.isArray(record.worktrees)) fail('data_record_invalid');
  return record;
}
export function updateRegistry(path, id, record) {
  const storage = readRegistry(path);
  if (record === undefined) delete storage.worktrees[id];
  else storage.worktrees[id] = storedWorktree(record);
  writeJson(path, storage);
}

// Durable records keep stable IDs. Absolute checkout paths exist only in the
// in-memory view and public reports.
export function storedWorktree(record) {
  const { path, ...fields } = record;
  return { ...fields, schema: 'gidd.worktree/v1' };
}
export function initializeStorage(storage) {
  if (!storage.initialized && existsSync(storage.path) && readdirSync(storage.path).some(name => join(storage.path, name) !== storage.lock)) fail('data_directory_occupied');
  mkdirSync(storage.path, { recursive: true });
  if (!storage.initialized) writeJson(join(storage.path, 'storage.json'), {
    schema: 'gidd.storage/v1', repository: storage.main, git_common_dir: storage.common, worktrees: {},
  });
  const notice = join(storage.path, 'README.md');
  if (!existsSync(notice)) atomicWrite(notice, readFileSync(new URL('../../references/worktree-directory.md', import.meta.url)));
  storage.initialized = true;
  return storage;
}
