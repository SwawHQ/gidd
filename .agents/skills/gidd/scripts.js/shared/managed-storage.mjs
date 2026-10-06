import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { configurationPath, plainPath } from './storage.mjs';
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
export function ensureLocalIgnore(repository) {
  const path = join(dirname(configurationPath(repository)), '.gitignore');
  plainPath(path);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const missing = ['/config.toml', '/config.toml.*', '/gidd.link.cmd', '/gidd.link.cmd.*'].filter(rule => !text.split(/\r?\n/).includes(rule));
  if (missing.length) atomicWrite(path, text + (text && !text.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}

// Keep the lock beside config so first initialization and existing operations
// share one lock. It protects a command, not an agent session or task ownership.
// Only a provably dead PID is reclaimed.
export function acquireStorageLock(storage, lease) {
  if (lease?.path === storage.lock) return lease;
  plainPath(storage.lock);
  mkdirSync(dirname(storage.lock), { recursive: true });
  let fd;
  for (let attempt = 0; ; attempt++) {
    try { fd = openSync(storage.lock, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = readJson(storage.lock); } catch { fail('data_locked'); }
      if (attempt || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail('data_locked');
      try { process.kill(owner.pid, 0); fail('data_locked'); }
      catch (probe) { if (probe.code !== 'ESRCH') fail('data_locked'); }
      unlinkSync(storage.lock);
    }
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  return { path: storage.lock, release() { closeSync(fd); unlinkSync(storage.lock); } };
}

export async function storageLocation(repository, git) {
  const rows = parseList(await git(repository, ['worktree', 'list', '--porcelain', '-z']));
  const main = rows[0];
  if (!main?.path || main.bare) fail('worktree_main_unavailable');
  const common = await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const config = configurationPath(main.path);
  plainPath(config); plainPath(common);
  const path = canonical(main.path) + '.gidd';
  return { path, main: main.path, common, config, rows,
    state: join(path, 'state'), lock: config + '.lock' };
}

export async function locateStorage(repository, git) {
  return inspectStorage(await storageLocation(repository, git), { required: true });
}

export function inspectStorage(storage, { required = false } = {}) {
  const { path, main, common } = storage;
  plainPath(path);
  if (inside(main, path) || inside(path, main) || inside(common, path) || inside(path, common)) fail('data_path_overlap');
  storage.initialized = false;
  const manifest = join(path, 'state/storage.json');
  if (existsSync(manifest)) {
    const owner = readJson(manifest);
    if (owner.schema !== 'gidd.storage/v1' ||
        typeof owner.repository !== 'string' || !isAbsolute(owner.repository) || typeof owner.git_common_dir !== 'string' || !isAbsolute(owner.git_common_dir) ||
        !samePath(owner.repository, main) || !samePath(owner.git_common_dir, common)) fail('data_repository_mismatch');
    storage.initialized = true;
  } else if (required) fail('data_missing');
  return storage;
}

export const contextName = gitDir => createHash('sha256').update(canonical(gitDir).toLowerCase()).digest('hex') + '.json';
export function contextLocation(storage, gitDir) {
  return join(storage.state, 'workflows', contextName(gitDir));
}
export const registryLocation = storage => join(storage.state, 'worktrees');

// Durable records keep stable IDs. Absolute checkout paths exist only in the
// in-memory view and public reports.
export function storedWorktree(record) {
  const { path, ...fields } = record;
  return { ...fields, schema: 'gidd.worktree/v1' };
}
export function initializeStorage(storage) {
  if (!storage.initialized && existsSync(storage.path) && readdirSync(storage.path).length) fail('data_directory_occupied');
  ensureLocalIgnore(storage.main);
  mkdirSync(storage.state, { recursive: true });
  if (!storage.initialized) writeJson(join(storage.state, 'storage.json'), {
    schema: 'gidd.storage/v1', repository: storage.main, git_common_dir: storage.common,
  });
  const notice = join(storage.path, 'README.md');
  if (!existsSync(notice)) atomicWrite(notice, readFileSync(new URL('../../references/worktree-directory.md', import.meta.url)));
  storage.initialized = true;
  return storage;
}
