import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { boundTools, boundExecutor } from '../../shared/bindings.mjs';
import { plainPath, toolsRoot } from '../../shared/storage.mjs';
import { noninteractiveEnvironment } from '../../shared/noninteractive.mjs';
import { withSignals } from '../../shared/signals.mjs';
import { remoteAddress } from '../../shared/config.mjs';
import { cleanupWorktree, validCleanupRecord } from './cleanup.mjs';
import { parseList } from '../../shared/git-worktrees.mjs';
import { acquireStorageLock, locateStorage, initializeStorage, registryLocation, storedWorktree } from '../../shared/managed-storage.mjs';
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

export function validWorkflowContext(value) {
  return value && ['direct-commit', 'direct-merge', 'pr-merge'].includes(value.mode) &&
    Object.keys(value).every(field => ['mode', 'remote', 'identity'].includes(field)) &&
    typeof value.remote === 'string' && /^[a-z0-9][a-z0-9._/-]*$/i.test(value.remote) &&
    typeof value.identity === 'string' && remoteAddress(value.identity)?.identity === value.identity;
}

export function parseWorktreeArguments(route, args) {
  const action = route.slice('worktree.'.length);
  if (action === 'list' && args.length === 0) return { action };
  if (['show', 'remove'].includes(action) && args.length === 1 && typeof args[0] === 'string' && args[0] && !/[\x00-\x1f\x7f]/.test(args[0]) && !args[0].startsWith('-'))
    return { action, path: args[0] };
  fail('invalid_arguments');
}

export function readRecords(directory, pool) {
  plainPath(directory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => readRecord(directory, name, pool));
}

export function readRecord(directory, name, pool) {
  const path = join(directory, name);
  plainPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 4096) fail('worktree_record_invalid');
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('worktree_record_invalid'); }
  if (!record || record.schema !== schema || !idPattern.test(record.id) || name !== record.id + '.json' ||
      Object.keys(record).some(field => !['schema', 'id', 'issue', 'ready_head', 'branch', 'target_branch', 'start_commit', 'cleanup', 'workflow'].includes(field)) ||
      (!Number.isSafeInteger(record.issue) || record.issue <= 0) ||
      (!validWorkflowContext(record.workflow) || record.workflow.mode === 'direct-commit') ||
      (record.cleanup !== undefined && !validCleanupRecord(record.cleanup)) ||
      (record.ready_head !== undefined && record.cleanup?.head !== record.ready_head) ||
      (![0, 3].includes(['branch', 'target_branch', 'start_commit'].filter(field => record[field] !== undefined).length)) ||
      (record.cleanup !== undefined && record.start_commit === undefined) ||
      ['branch', 'target_branch'].some(field => record[field] !== undefined && (!argument(record[field]) || record[field].startsWith('refs/'))) ||
      ['ready_head', 'start_commit'].some(field => record[field] !== undefined && !oidPattern.test(record[field]))) fail('worktree_record_invalid');
  const checkout = join(pool, record.id);
  plainPath(checkout);
  return { ...record, path: checkout };
}

function saveRecord(directory, record) {
  const path = join(directory, record.id + '.json'), temporary = path + '.' + randomUUID() + '.tmp';
  plainPath(path);
  const fd = openSync(temporary, 'wx');
  try { writeFileSync(fd, JSON.stringify(storedWorktree(record)) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
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
    if (!validWorkflowContext(options.workflow) || options.workflow.mode === 'direct-commit') fail('workflow_context_invalid');
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
  if (options.action === 'remove' && options.path !== undefined && key(options.path) === key(repository))
    fail('worktree_target_repository_protected');
  let storage = await locateStorage(repository, git);
  if (!['list', 'show'].includes(options.action)) {
    lease = acquireStorageLock(storage, storageLease);
    storage = await locateStorage(repository, git);
  }
  const pool = storage.path;
  const stateRoot = storage.state, directory = registryLocation(storage), lockPath = storage.lock;
  plainPath(stateRoot);
  const report = fields => ({ schema, status: 'ready', target_repository: repository, ...fields });
  function selectRecord(records, path) {
    // Workflow resolves the Issue first and passes its exact registered path.
    if (typeof path !== 'string' || !path) fail('invalid_arguments');
    const matches = records.filter(item => key(item.path) === key(resolve(path)));
    if (!matches.length) fail('worktree_unknown_selector');
    if (matches.length !== 1) fail('worktree_selector_ambiguous');
    return matches[0];
  }

  async function inspect(row, includeIgnored = false) {
    if (!row || !existsSync(row.path)) return 'worktree_missing';
    try { plainPath(row.path); } catch { return 'worktree_reparse_path'; }
    if (row.bare || row.locked || row.prunable) return 'worktree_unavailable';
    if (key(await git(row.path, ['rev-parse', '--show-toplevel'])) !== key(row.path) ||
        key(await git(row.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== key(common)) return 'worktree_repository_mismatch';
    const gitDir = await git(row.path, ['rev-parse', '--absolute-git-dir']);
    plainPath(gitDir);
    const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START', 'index.lock', 'HEAD.lock'];
    if (operations.some(name => existsSync(join(gitDir, name)))) return 'worktree_operation_in_progress';
    // status can hide edits behind assume-unchanged/skip-worktree flags. Do not
    // switch or remove such a checkout based on an apparently clean status.
    const index = await git(row.path, ['ls-files', '-v', '-z']);
    if (index.split('\0').some(entry => /^[a-zS] /.test(entry))) return 'worktree_index_flags';
    if (await git(row.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])) return 'worktree_dirty';
    // Release/reuse preserves ignored caches. Removal must not erase them.
    if (includeIgnored && await git(row.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])) return 'worktree_ignored_files';
    return null;
  }

  async function readyReason(record, row, includeIgnored = false) {
    if (!record.ready_head) return 'worktree_not_released';
    if (!row || !row.detached || row.head !== record.ready_head) return 'worktree_state_changed';
    return inspect(row, includeIgnored);
  }

  if (['list', 'show'].includes(options.action)) {
    const records = readRecords(directory, pool);
    const locked = !storageLease && existsSync(lockPath);
    const metadata = record => ({ issue: record?.issue, workflow: record?.workflow ?? null, recorded_branch: record?.branch ?? null,
      target_branch: record?.target_branch ?? null, start_commit: record?.start_commit ?? null });
    async function describe(row, record) {
      if (!row) return { id: record.id, path: record.path, ...metadata(record), state: 'needs_check', reason: 'worktree_missing' };
      let state = 'unmanaged', reason;
      if (record) {
        try {
          reason = locked ? 'worktree_registry_locked' : !record.branch ? 'worktree_delivery_metadata_missing' :
            record.ready_head ? await readyReason(record, row) : record.cleanup ? 'worktree_cleanup_pending' :
            record.branch && row.branch !== record.branch ? 'worktree_branch_mismatch' :
            (await inspect(row)) || (row.detached ? 'worktree_detached_unreleased' : null);
        } catch { reason = 'worktree_unreadable'; }
        state = reason && !(reason === 'worktree_dirty' && !record.ready_head && row.branch) ? 'needs_check' : record.ready_head ? 'available' : 'unreleased';
      }
      return { ...(record ? { id: record.id } : {}), ...row, ...metadata(record), state, ...(reason ? { reason } : {}) };
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
    if (options.action === 'acquire') {
      const base = options.base;
      // Validate full refs rather than accepting revision expressions or the
      // special @{-1} shorthand accepted by check-ref-format --branch.
      for (const name of [options.branch, base]) {
        if (!argument(name) || name.startsWith('refs/')) fail('worktree_branch_invalid');
        await git(repository, ['check-ref-format', 'refs/heads/' + name]);
      }
      const branches = (await git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).split('\n');
      if (branches.some(ref => ref.toLowerCase() === ('refs/heads/' + options.branch).toLowerCase())) fail('worktree_branch_exists');
      if (records.some(item => item.cleanup && !item.ready_head && item.branch?.toLowerCase() === options.branch.toLowerCase())) fail('worktree_cleanup_pending');
      if (!branches.includes('refs/heads/' + base)) fail('worktree_base_missing');
      const start = await git(repository, ['rev-parse', '--verify', 'refs/heads/' + base + '^{commit}']);
      // Workspace preparation has already synchronized and verified this tip.
      // Do not silently allocate from a native concurrent branch update.
      if (options.expected_start !== undefined && options.expected_start !== start) fail('workflow_target_changed');
      initializeStorage(storage);
      mkdirSync(directory, { recursive: true });
      let record;
      for (const candidate of records) {
        const row = current.find(item => key(item.path) === key(candidate.path));
        if (!await readyReason(candidate, row)) { record = candidate; break; }
      }
      const reused = !!record;
      if (!record) {
        const id = 'gidd-wt-' + randomUUID();
        record = { schema, id, path: join(pool, id) };
        plainPath(record.path);
        if (existsSync(record.path)) fail('worktree_path_exists');
      }
      ensurePool(pool);
      delete record.ready_head;
      // A failed allocation must not describe the previous use as the new one.
      delete record.branch;
      delete record.target_branch;
      delete record.start_commit;
      delete record.cleanup;
      record.workflow = options.workflow;
      record.issue = options.issue;
      saveRecord(directory, record); // revoke availability BEFORE touching Git
      if (reused) await git(record.path, ['checkout', '--no-overwrite-ignore', '--no-recurse-submodules', '--no-track', '-b', options.branch, start, '--']);
      else await git(repository, ['-c', 'worktree.useRelativePaths=false', 'worktree', 'add', '--no-track', '-b', options.branch, '--', record.path, start]);
      const row = (await rows()).find(item => key(item.path) === key(record.path));
      if (!row || row.branch !== options.branch || row.head !== start) fail('worktree_state_changed');
      const reason = await inspect(row);
      if (reason) fail(reason);
      Object.assign(record, { branch: options.branch, target_branch: base, start_commit: start });
      saveRecord(directory, record);
      return report({ id: record.id, path: record.path, branch: row.branch, target_branch: base, start_commit: start });
    }
    if (options.action === 'cleanup') {
      const record = selectRecord(records, options.path);
      return await cleanupWorktree({ repository, record, git, rows, inspect, key, report,
        save: () => saveRecord(directory, record), execute, signal });
    }
    if (options.action === 'remove') {
      const record = selectRecord(records, options.path);
      const row = current.find(item => key(item.path) === key(record.path));
      const reason = await readyReason(record, row, true);
      if (reason) fail(reason);
      // Exact managed path, common repository, release HEAD and files were
      // checked above. Let Git enforce its own removal constraints; never force.
      delete record.ready_head;
      saveRecord(directory, record);
      await git(repository, ['worktree', 'remove', '--', record.path]);
      unlinkSync(join(directory, record.id + '.json'));
      return report({ id: record.id, path: record.path, removed: true });
    }
    fail('invalid_arguments');
  } finally { if (lease && lease !== storageLease) lease.release(); }
}

export const runWorktree = (repository, options) => withSignals(signal => worktreeCommand(repository, options, { signal }));
