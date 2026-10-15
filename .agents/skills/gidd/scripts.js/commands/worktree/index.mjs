import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { boundTools, boundExecutor } from '../../shared/bindings.mjs';
import { plainPath, toolsRoot } from '../../shared/storage.mjs';
import { noninteractiveEnvironment } from '../../shared/noninteractive.mjs';
import { withSignals } from '../../shared/signals.mjs';
import { validRemoteBinding } from '../../shared/remote-binding.mjs';
import { cleanupWorktree, validCleanupRecord } from './cleanup.mjs';
import { validLocalMerge } from '../../shared/local-delivery.mjs';
import { readTasks } from '../../shared/task-records.mjs';
import { parseList } from '../../shared/git-worktrees.mjs';
import { branchDetails } from '../../shared/workspace-branch.mjs';
import { inspectWorkspace, workspaceState } from '../../shared/workspace-state.mjs';
import { acquireStorageLock, locateStorage, initializeStorage, registryLocation, readRegistry, updateRegistry } from '../../shared/managed-storage.mjs';
export { parseList } from '../../shared/git-worktrees.mjs';

const schema = 'gidd.worktree/v1';
export const idPattern = /^gidd-wt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
// Git expands Windows 8.3 paths; normalize existing ancestors for paths that
// have not been created yet as well. Reparse points are checked separately.
const canonical = path => existsSync(path) ? realpathSync.native(path) :
  dirname(resolve(path)) === resolve(path) ? resolve(path) : join(canonical(dirname(resolve(path))), basename(path));
const key = path => canonical(path).toLowerCase();
const fail = reason => { throw new Error(reason); };
const argument = value => typeof value === 'string' && value.length > 0 && !value.startsWith('-') && !/[\x00-\x20\x7f]/.test(value);

export function validDeliveryContext(value) {
  return value && ['direct-commit', 'direct-merge', 'pr-merge'].includes(value.mode) &&
    Object.keys(value).every(field => ['mode', 'remote'].includes(field)) && validRemoteBinding(value.remote);
}

export function parseWorktreeArguments(route, args) {
  const action = route.slice('worktree.'.length);
  if (action === 'list' && args.length === 0) return { action };
  if (['show', 'remove'].includes(action) && args.length === 1 && typeof args[0] === 'string' && args[0] && !/[\x00-\x1f\x7f]/.test(args[0]) && !args[0].startsWith('-'))
    return { action, path: args[0] };
  fail('invalid_arguments');
}

export function readRecords(file, pool) {
  plainPath(file);
  if (!existsSync(file)) return [];
  const registry = readRegistry(file);
  return Object.keys(registry.worktrees).sort().map(id => readRecord(file, id, pool, registry));
}

function validRecord(record, name, previous = false) {
  if (!record || record.schema !== schema || !idPattern.test(record.id) || name !== record.id ||
      Object.keys(record).some(field => !['schema', 'id', 'issue', 'ready_head', 'branch', 'target_branch', 'start_commit', 'cleanup', 'delivery', 'preparation', 'local_merge'].includes(field)) ||
      (!Number.isSafeInteger(record.issue) || record.issue <= 0) ||
      (!validDeliveryContext(record.delivery) || record.delivery.mode === 'direct-commit') ||
      (record.cleanup !== undefined && !validCleanupRecord(record.cleanup)) ||
      (record.local_merge !== undefined && (record.delivery.mode !== 'direct-merge' || record.preparation || !validLocalMerge(record.local_merge))) ||
      (record.ready_head !== undefined && record.cleanup?.head !== record.ready_head) ||
      ['branch', 'target_branch', 'start_commit'].some(field => record[field] === undefined) ||
      (record.cleanup !== undefined && record.start_commit === undefined) ||
      ['branch', 'target_branch'].some(field => record[field] !== undefined && (!argument(record[field]) || record[field].startsWith('refs/'))) ||
      ['ready_head', 'start_commit'].some(field => record[field] !== undefined && !oidPattern.test(record[field]))) return false;
  const preparation = record.preparation;
  if (preparation !== undefined && (previous || record.ready_head || record.cleanup || !preparation || record.branch === record.target_branch ||
      Object.keys(preparation).some(field => !['branch', 'target_branch', 'start_commit', 'previous'].includes(field)) ||
      ['branch', 'target_branch', 'start_commit'].some(field => preparation[field] !== record[field] || record[field] === undefined) ||
      (preparation.previous !== undefined && (!validRecord(preparation.previous, name, true) || !preparation.previous.ready_head)))) return false;
  return true;
}

export function readRecord(file, name, pool, registry = readRegistry(file)) {
  const record = registry.worktrees[name];
  if (!validRecord(record, name)) fail('worktree_record_invalid');
  const checkout = join(pool, record.id);
  plainPath(checkout);
  return { ...record, path: checkout };
}

function saveRecord(file, record) {
  updateRegistry(file, record.id, record);
}

function ensurePool(pool) {
  plainPath(pool);
  mkdirSync(pool, { recursive: true });
  const path = join(pool, 'README.md');
  plainPath(path);
  try {
    writeFileSync(path, readFileSync(new URL('../../../references/worktree-directory.md', import.meta.url)), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Preserve local additions to the notice; never follow a replacement link.
    plainPath(path);
    if (!lstatSync(path).isFile()) fail('worktree_readme_invalid');
  }
}

// Only PR cleanup needs remote credentials and network access. Disable hooks
// and Git's lazy fetching for local operations; configured
// checkout filters still apply and may themselves launch external programs.
export async function worktreeCommand(repository, options, { execute, signal, storageLease } = {}) {
  let lease;
  try {
  if (options.action === 'acquire') {
    if (!Number.isSafeInteger(options.issue) || options.issue <= 0) fail('invalid_arguments');
    if (options.defer_commit !== undefined && typeof options.defer_commit !== 'boolean') fail('invalid_arguments');
    if (!validDeliveryContext(options.delivery) || options.delivery.mode === 'direct-commit') fail('delivery_context_invalid');
    if (options.base === undefined) fail('worktree_base_required');
  }
  const bindings = boundTools(toolsRoot(), ['git']);
  const invoke = boundExecutor(bindings, execute);
  const env = { ...noninteractiveEnvironment(bindings.git.path, process.env), GIT_NO_LAZY_FETCH: '1' };
  const git = async (path, args) => {
    const result = await invoke(bindings.git.path, ['-C', path, '-c', 'core.hooksPath=NUL', ...args],
      { env, signal, timeoutMs: 120000 });
    if (!result.ok) fail(result.reason === 'command_failed' ? 'worktree_git_failed' : result.reason);
    return result.text;
  };
  plainPath(repository);
  const top = await git(repository, ['rev-parse', '--show-toplevel']);
  if (key(top) !== key(repository)) fail('repository_root_mismatch');
  const common = await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  plainPath(common);
  const rows = () => git(repository, ['worktree', 'list', '--porcelain', '-z']).then(parseList);
  const initial = await rows(), main = initial[0];
  if (!main?.path || main.bare) fail('worktree_main_unavailable');
  // Protect the entry checkout even when the entry itself is a registered
  // dedicated worktree, rather than relying only on pool-path validation.
  if (['remove', 'abort'].includes(options.action) && options.path !== undefined && key(options.path) === key(repository))
    fail('worktree_target_repository_protected');
  let storage = await locateStorage(repository, git);
  if (!['list', 'show'].includes(options.action)) {
    lease = acquireStorageLock(storage, storageLease);
    storage = await locateStorage(repository, git);
  }
  const pool = storage.path;
  const directory = registryLocation(storage), lockPath = storage.lock;
  const report = fields => ({ schema, status: 'ready', target_repository: repository, ...fields });
  function selectRecord(records, path) {
    // Task commands resolve the Issue first and pass its registered path.
    if (typeof path !== 'string' || !path) fail('invalid_arguments');
    const matches = records.filter(item => key(item.path) === key(resolve(path)));
    if (!matches.length) fail('worktree_unknown_selector');
    if (matches.length !== 1) fail('worktree_selector_ambiguous');
    return matches[0];
  }

  const inspect = (row, includeIgnored = false) => inspectWorkspace(row, {
    git, common, same: (a, b) => key(a) === key(b), includeIgnored,
  });

  async function readyReason(record, row, includeIgnored = false) {
    if (!record.ready_head) return 'worktree_not_released';
    if (!row || !row.detached || row.head !== record.ready_head) return 'worktree_state_changed';
    return inspect(row, includeIgnored);
  }

  if (['list', 'show'].includes(options.action)) {
    const records = readRecords(directory, pool);
    const locked = !storageLease && existsSync(lockPath);
    const metadata = record => ({ issue: record?.issue, delivery: record?.delivery ?? null, recorded_branch: record?.branch ?? null,
      target_branch: record?.target_branch ?? null, start_commit: record?.start_commit ?? null });
    async function describe(row, record) {
      if (!row) return { id: record.id, path: record.path, ...metadata(record), state: 'needs_check',
        reason: record.preparation ? 'worktree_preparation_pending' : 'worktree_missing' };
      let reason;
      const branchMismatch = record?.branch && !record.ready_head && row.branch !== record.branch &&
        !(record.cleanup && row.detached && row.head === record.cleanup.head);
      if (record) {
        try {
          reason = locked ? 'worktree_registry_locked' : record.preparation ? 'worktree_preparation_pending' : !record.branch ? 'worktree_delivery_metadata_missing' :
            record.ready_head ? await readyReason(record, row) : branchMismatch ? 'worktree_branch_mismatch' :
            record.cleanup ? 'worktree_cleanup_pending' :
            (await inspect(row)) || (row.detached ? 'worktree_detached_unreleased' : null);
        } catch { reason = 'worktree_unreadable'; }
      }
      const state = workspaceState({ managed: !!record, released: !!record?.ready_head, reason });
      return { ...(record ? { id: record.id } : {}), ...row, ...metadata(record), state, ...(reason ? { reason } : {}),
        ...(['worktree_branch_mismatch', 'worktree_delivery_metadata_missing'].includes(reason)
          ? { details: branchDetails(record.branch, row.branch) }
          : reason === 'worktree_state_changed' && record.ready_head && row.branch
            ? { details: branchDetails(null, row.branch) } : {}) };
    }
    if (options.action === 'show') {
      const record = selectRecord(records, options.path);
      const row = initial.find(item => key(item.path) === key(record.path));
      return report({ worktree: await describe(row, record), record, git: row ?? null });
    }
    const worktrees = [];
    for (const row of initial) {
      if (key(row.path) === key(repository)) continue; // Already named by target_repository.
      const record = records.find(item => key(item.path) === key(row.path));
      worktrees.push(await describe(row, record));
    }
    for (const record of records) if (key(record.path) !== key(repository) && !initial.some(row => key(row.path) === key(record.path)))
      worktrees.push(await describe(null, record));
    return report({ worktrees });
  }

  // The storage lease covers this invocation, including bounded PR I/O.
  plainPath(directory);
    const records = readRecords(directory, pool), current = await rows();
    const localHead = async branch => {
      const ref = 'refs/heads/' + branch;
      const refs = await git(repository, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', ref]);
      const line = refs.split('\n').find(value => value.startsWith(ref + ' '));
      if (!line) return null;
      const [head, symbolic] = line.slice(ref.length + 1).split(' ');
      if (symbolic) fail('worktree_branch_changed');
      return head;
    };
    async function checkPreparationBranch(record, entries) {
      const head = await localHead(record.branch);
      if (head !== null && head !== record.start_commit) fail('worktree_branch_changed');
      if (entries.some(row => row.branch === record.branch && key(row.path) !== key(record.path))) fail('worktree_branch_checked_out_elsewhere');
      return head;
    }
    if (options.action === 'acquire') {
      const base = options.base;
      // Validate full refs rather than accepting revision expressions or the
      // special @{-1} shorthand accepted by check-ref-format --branch.
      for (const name of [options.branch, base]) {
        if (!argument(name) || name.startsWith('refs/')) fail('worktree_branch_invalid');
        await git(repository, ['check-ref-format', 'refs/heads/' + name]);
      }
      const branches = (await git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).split('\n');
      const pending = records.filter(item => item.preparation && item.issue === options.issue);
      if (pending.length > 1) fail('worktree_selector_ambiguous');
      let record = pending[0] ?? records.find(item => !item.ready_head && !item.cleanup && item.issue === options.issue && item.branch === options.branch);
      let start;
      if (record) {
        if (record.branch !== options.branch || record.target_branch !== base || !isDeepStrictEqual(record.delivery, options.delivery) ||
            (options.expected_start !== undefined && options.expected_start !== record.start_commit)) fail('worktree_preparation_mismatch');
        start = record.start_commit;
      } else {
        if (branches.some(ref => ref.toLowerCase() === ('refs/heads/' + options.branch).toLowerCase())) fail('worktree_branch_exists');
        if (records.some(item => item.cleanup && !item.ready_head && item.branch?.toLowerCase() === options.branch.toLowerCase())) fail('worktree_cleanup_pending');
        if (!branches.includes('refs/heads/' + base)) fail('worktree_base_missing');
        start = await git(repository, ['rev-parse', '--verify', 'refs/heads/' + base + '^{commit}']);
        // Save the verified tip once; retries never switch to a newer target.
        if (options.expected_start !== undefined && options.expected_start !== start) fail('delivery_target_changed');
        initializeStorage(storage);
        // Resource release can finish before the referring task is removed.
        const referenced = new Set(readTasks(storage).map(task => task.workspace));
        for (const candidate of records) {
          if (referenced.has(candidate.id)) continue;
          const row = current.find(item => key(item.path) === key(candidate.path));
          if (!await readyReason(candidate, row)) { record = candidate; break; }
        }
        let previous;
        if (record) { const { path, ...saved } = record; previous = saved; }
        else {
          const id = 'gidd-wt-' + randomUUID();
          record = { schema, id, path: join(pool, id) };
          plainPath(record.path);
          if (existsSync(record.path)) fail('worktree_path_exists');
        }
        ensurePool(pool);
        delete record.ready_head;
        delete record.cleanup;
        delete record.local_merge;
        Object.assign(record, { delivery: options.delivery, issue: options.issue, branch: options.branch,
          target_branch: base, start_commit: start,
          preparation: { branch: options.branch, target_branch: base, start_commit: start, ...(previous ? { previous } : {}) } });
        saveRecord(directory, record); // Revoke availability and save recovery evidence before Git.
      }
      const existing = current.find(item => key(item.path) === key(record.path));
      const branchHead = await checkPreparationBranch(record, current);
      if (existing?.branch === record.branch && existing.head === start) {
        const reason = await inspect(existing);
        if (reason) fail(reason);
      } else {
        if (!record.preparation) fail('worktree_state_changed');
        const previous = record.preparation.previous;
        if (previous) {
          const reason = await readyReason(previous, existing);
          if (reason) fail(reason);
          await git(record.path, ['checkout', '--no-overwrite-ignore', '--no-recurse-submodules',
            ...(branchHead === null ? ['--no-track', '-b', record.branch, start] : [record.branch]), '--']);
        } else {
          if (existing || existsSync(record.path)) fail('worktree_state_changed');
          await git(repository, ['-c', 'worktree.useRelativePaths=false', 'worktree', 'add',
            ...(branchHead === null ? ['--no-track', '-b', record.branch] : []), '--', record.path, branchHead === null ? start : record.branch]);
        }
      }
      const row = (await rows()).find(item => key(item.path) === key(record.path));
      if (!row || row.branch !== record.branch || row.head !== start) fail('worktree_state_changed');
      const reason = await inspect(row);
      if (reason) fail(reason);
      if (await checkPreparationBranch(record, await rows()) !== start) fail('worktree_state_changed');
      if (!options.defer_commit) {
        delete record.preparation;
        saveRecord(directory, record);
      }
      return report({ id: record.id, path: record.path, branch: row.branch, target_branch: base, start_commit: start, state: 'assigned' });
    }
    if (options.action === 'commit') {
      const record = selectRecord(records, options.path);
      if (!Number.isSafeInteger(options.issue) || options.issue <= 0) fail('invalid_arguments');
      if (record.issue !== options.issue || record.ready_head || record.cleanup || !record.branch) fail('worktree_preparation_mismatch');
      for (const branch of [record.branch, record.target_branch]) await git(repository, ['check-ref-format', 'refs/heads/' + branch]);
      const row = current.find(item => key(item.path) === key(record.path));
      if (!row || row.branch !== record.branch || row.head !== record.start_commit) fail('worktree_state_changed');
      const reason = await inspect(row);
      if (reason) fail(reason);
      if (await checkPreparationBranch(record, await rows()) !== record.start_commit) fail('worktree_state_changed');
      delete record.preparation;
      saveRecord(directory, record);
      return report({ id: record.id, path: record.path, branch: record.branch, target_branch: record.target_branch,
        start_commit: record.start_commit, state: 'assigned' });
    }
    if (options.action === 'abort') {
      const record = selectRecord(records, options.path), preparation = record.preparation;
      if (!preparation) fail('worktree_preparation_missing');
      for (const branch of [record.branch, record.target_branch]) await git(repository, ['check-ref-format', 'refs/heads/' + branch]);
      await checkPreparationBranch(record, current);
      const row = current.find(item => key(item.path) === key(record.path)), previous = preparation.previous;
      if (previous) {
        if (!row || !(row.branch === record.branch && row.head === record.start_commit ||
            row.detached && row.head === previous.ready_head)) fail('worktree_state_changed');
        const reason = await inspect(row);
        if (reason) fail(reason);
        if (!row.detached) await git(record.path, ['checkout', '--detach', '--no-overwrite-ignore', '--no-recurse-submodules', previous.ready_head, '--']);
        const restored = (await rows()).find(item => key(item.path) === key(record.path));
        const changed = await readyReason({ ...previous, path: record.path }, restored);
        if (changed) fail(changed);
      } else if (row) {
        if (row.branch !== record.branch || row.head !== record.start_commit) fail('worktree_state_changed');
        const reason = await inspect(row, true);
        if (reason) fail(reason);
        await git(repository, ['worktree', 'remove', '--', record.path]);
      } else if (existsSync(record.path)) {
        // Only an empty, unregistered new directory can be discarded.
        if (!lstatSync(record.path).isDirectory()) fail('worktree_state_changed');
        try { rmdirSync(record.path); } catch { fail('worktree_state_changed'); }
      }
      const after = await rows(), head = await checkPreparationBranch(record, after);
      if (after.some(item => item.branch === record.branch)) fail('worktree_branch_checked_out_elsewhere');
      if (head !== null) await git(repository, ['update-ref', '--no-deref', '-d', 'refs/heads/' + record.branch, record.start_commit]);
      if (previous) saveRecord(directory, previous);
      else updateRegistry(directory, record.id, undefined);
      return report({ id: record.id, path: record.path, aborted: true, state: previous ? 'available' : 'removed' });
    }
    if (options.action === 'cleanup') {
      const record = selectRecord(records, options.path);
      if (record.preparation) fail('worktree_preparation_pending');
      return await cleanupWorktree({ repository, record, git, rows, inspect, key, report,
        save: () => saveRecord(directory, record), execute, signal, account: options.github_account });
    }
    if (options.action === 'remove') {
      const record = selectRecord(records, options.path);
      const row = current.find(item => key(item.path) === key(record.path));
      const reason = await readyReason(record, row, true);
      if (reason) throw Object.assign(new Error(reason), reason === 'worktree_state_changed' && row?.branch ? {
        details: { path: record.path, ...branchDetails(null, row.branch) },
      } : {});
      if (readTasks(storage).some(task => task.workspace === record.id)) fail('task_cleanup_pending');
      // Exact managed path, common repository, release HEAD and files were
      // checked above. Let Git enforce its own removal constraints; never force.
      await git(repository, ['worktree', 'remove', '--', record.path]);
      updateRegistry(directory, record.id, undefined);
      return report({ id: record.id, path: record.path, removed: true });
    }
    fail('invalid_arguments');
  } finally { if (lease && lease !== storageLease) lease.release(); }
}

export const runWorktree = (repository, options) => withSignals(signal => worktreeCommand(repository, options, { signal }));
