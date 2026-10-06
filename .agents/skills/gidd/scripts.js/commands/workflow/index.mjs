import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { boundExecutor, boundTools } from '../../shared/bindings.mjs';
import { githubTarget, readConfiguration, validateRemoteSettings } from '../../shared/config.mjs';
import { executionScope } from '../../shared/execution-scope.mjs';
import { noninteractiveEnvironment } from '../../shared/noninteractive.mjs';
import { repositoryConnection } from '../../shared/repository-remote.mjs';
import { plainPath, toolsRoot } from '../../shared/storage.mjs';
import { withSignals } from '../../shared/signals.mjs';
import { parseList, validWorkflowContext, worktreeCommand, readRecords } from '../worktree/index.mjs';
import { prConnection } from '../../shared/pull-requests.mjs';
import { issueNumber, readWorkflowIssue } from '../../shared/issue-workflow.mjs';
import { readSpec } from '../../shared/specs.mjs';
import { acquireStorageLock, locateStorage, initializeStorage, contextLocation, registryLocation, readJson } from '../../shared/managed-storage.mjs';

const schema = 'gidd.workflow/v1';
const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const branchName = value => typeof value === 'string' && !!value && !/^[-/.]|[\x00-\x20\x7f\\:]/.test(value) && !value.startsWith('refs/');
const canonical = path => existsSync(path) ? realpathSync.native(path) :
  dirname(resolve(path)) === resolve(path) ? resolve(path) : join(canonical(dirname(resolve(path))), basename(path));
const same = (a, b) => canonical(a).toLowerCase() === canonical(b).toLowerCase();
const fail = reason => { throw new Error(reason); };

export function parseWorkflowArguments(route, args) {
  const action = route.slice('workflow.'.length);
  if (action === 'workspace' && args.length === 2 && args[0] === '--resume' && issueNumber(args[1]))
    return { action, resume: true, issue: Number(args[1]) };
  if (!['workspace', 'push', 'merge', 'target-sync', 'cleanup'].includes(action) || !issueNumber(args[0])) fail('invalid_arguments');
  const result = { action, issue: Number(args[0]) }, rest = args.slice(1);
  while (rest.length) {
    const flag = rest.shift();
    if (action === 'merge' && ['--merge', '--squash', '--rebase'].includes(flag) && !result.method) result.method = flag.slice(2);
    else if (action === 'merge' && flag === '--message' && result.message === undefined &&
      typeof rest[0] === 'string' && rest[0].trim() && !/[\x00-\x1f\x7f]/.test(rest[0])) result.message = rest.shift();
    else fail('invalid_arguments');
  }
  if (result.method === 'rebase' && result.message) fail('invalid_arguments');
  return result;
}

function saveContext(path, record) {
  plainPath(path);
  const temporary = path + '.' + randomUUID() + '.tmp', fd = openSync(temporary, 'wx');
  try { writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export async function workflowCommand(repository, options, { execute, signal, cwd = process.cwd() } = {}) {
  let lease;
  try {
  const bindings = boundTools(toolsRoot(), ['git']), invoke = boundExecutor(bindings, execute);
  const env = { ...noninteractiveEnvironment(bindings.git.path, process.env), GIT_NO_LAZY_FETCH: '1' };
  await executionScope(repository, { bindings, env, signal, cwd });
  const git = async (path, args) => {
    const result = await invoke(bindings.git.path, ['-C', path, ...args], { env, signal, timeoutMs: 60000 });
    if (!result.ok) throw new Error(result.reason === 'command_failed' ? 'workflow_git_failed' : result.reason);
    return result.text;
  };
  const rows = async () => parseList(await git(repository, ['worktree', 'list', '--porcelain', '-z']));
  const common = await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const entryGit = await git(repository, ['rev-parse', '--absolute-git-dir']);
  let storage = await locateStorage(repository, git);
  lease = acquireStorageLock(storage);
  storage = await locateStorage(repository, git);
  const root = storage.state, contextPath = contextLocation(storage, entryGit);
  plainPath(root); plainPath(contextPath);
  const report = fields => ({ schema, status: 'ready', target_repository: repository, issue: options.issue, ...fields });
  const worktree = action => worktreeCommand(repository, action, { execute, signal, storageLease: lease });
  const refHead = async branch => {
    if (!branchName(branch)) fail('workflow_context_invalid');
    await git(repository, ['check-ref-format', 'refs/heads/' + branch]);
    return git(repository, ['rev-parse', '--verify', 'refs/heads/' + branch + '^{commit}']);
  };
  const ancestor = async (from, to) => (await invoke(bindings.git.path,
    ['-C', repository, 'merge-base', '--is-ancestor', from, to], { env, signal })).ok;
  const snapshot = mode => {
    const settings = readConfiguration(repository);
    validateRemoteSettings(settings.repo.remote, ['name', 'url']);
    const target = githubTarget(settings.repo.remote);
    return { mode, remote: target.remote, identity: target.repository };
  };
  const matchRemote = context => {
    const current = snapshot();
    if (current.remote !== context.workflow.remote || current.identity !== context.workflow.identity) fail('workflow_remote_changed');
  };
  async function context() {
    const dedicated = readRecords(registryLocation(storage), storage.path).filter(record => record.issue === options.issue);
    let direct;
    if (existsSync(contextPath)) {
      plainPath(contextPath);
      const stat = lstatSync(contextPath);
      if (!stat.isFile() || stat.size > 4096) fail('workflow_context_invalid');
      let record;
      try { record = JSON.parse(readFileSync(contextPath, 'utf8')); } catch { fail('workflow_context_invalid'); }
      if (!record || record.schema !== 'gidd.workflow.context/v1' || !Number.isSafeInteger(record.issue) || record.issue <= 0 || !validWorkflowContext(record.workflow) ||
          record.workflow.mode !== 'direct-commit' || !branchName(record.target_branch) || !oid(record.start_commit) ||
          Object.keys(record).some(key => !['schema', 'issue', 'workflow', 'target_branch', 'start_commit'].includes(key))) fail('workflow_context_invalid');
      if (record.issue === options.issue) direct = record;
    }
    if (dedicated.length + (direct ? 1 : 0) > 1) fail('workflow_issue_ambiguous');
    if (direct) {
      const row = (await rows()).find(row => same(row.path, repository));
      if (row?.branch !== direct.target_branch) fail('workflow_branch_changed');
      return { ...direct, path: repository, branch: null, state: 'current', git: row };
    }
    if (!dedicated.length) fail('workflow_context_required');
    const result = await worktree({ action: 'show', path: dedicated[0].path });
    if (!result.record.workflow || result.record.workflow.mode === 'direct-commit') fail('workflow_context_required');
    const record = result.record;
    if (!record.branch || !record.target_branch || !oid(record.start_commit)) fail('workflow_context_invalid');
    if (options.action !== 'cleanup' && record.ready_head) fail('workflow_workspace_released');
    if (record.cleanup && !['cleanup', 'workspace'].includes(options.action)) fail('workflow_cleanup_pending');
    if (!record.cleanup && !record.ready_head && result.git?.branch !== record.branch) fail('workflow_branch_changed');
    return { ...record, state: result.worktree.state, git: result.git, reason: result.worktree.reason };
  }
  const remoteHead = async (connection, branch) => {
    await connection.verifyRemote();
    const ref = 'refs/heads/' + branch;
    const text = await connection.git(repository, ['ls-remote', '--refs', connection.target.remote, ref]);
    if (!text) return null;
    const lines = text.split('\n'), fields = lines[0].split('\t');
    if (lines.length !== 1 || fields[1] !== ref || !oid(fields[0])) fail('workflow_remote_response_invalid');
    return fields[0];
  };
  // Fetch a single branch into a private temporary ref, never rewrite a local
  // branch or rely on FETCH_HEAD. Delete only the ref value we actually fetched.
  async function withRemoteTarget(connection, branch, action) {
    await connection.verifyRemote();
    const temporary = 'refs/gidd/workflow/' + randomUUID();
    let head;
    try {
      await connection.git(repository, ['fetch', '--no-prune', '--no-prune-tags', '--refmap=',
        '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance',
        connection.target.remote, 'refs/heads/' + branch + ':' + temporary]);
      head = await git(repository, ['rev-parse', '--verify', temporary + '^{commit}']);
      return await action(head);
    } finally {
      // Fetch can write the ref before a later hook/transport failure. Inspect
      // only our unique ref, then use its exact value when removing it.
      if (!head) {
        const result = await invoke(bindings.git.path, ['-C', repository, 'rev-parse', '--verify', temporary],
          { env, signal, timeoutMs: 60000 });
        if (result.ok && oid(result.text)) head = result.text;
      }
      if (head) await git(repository, ['update-ref', '-d', temporary, head]);
    }
  }
  async function cleanTarget(row) {
    plainPath(row.path);
    if (row.bare || row.locked || row.prunable || !same(await git(row.path, ['rev-parse', '--show-toplevel']), row.path) ||
        !same(await git(row.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']), common)) fail('workflow_target_unavailable');
    const directory = await git(row.path, ['rev-parse', '--absolute-git-dir']);
    plainPath(directory);
    if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START', 'index.lock', 'HEAD.lock']
      .some(name => existsSync(join(directory, name)))) fail('workflow_target_busy');
    if ((await git(row.path, ['ls-files', '-v', '-z'])).split('\0').some(line => /^[a-zS] /.test(line))) fail('workflow_target_index_flags');
    if (await git(row.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])) fail('workflow_target_dirty');
  }
    const starting = options.action === 'workspace' && !options.resume;
    const current = starting ? null : await context();
    if (current) matchRemote(current);
    if (starting) {
      if (readRecords(registryLocation(storage), storage.path).some(record => record.issue === options.issue)) fail('workflow_issue_registered');
      if (existsSync(contextPath) && readJson(contextPath).issue === options.issue) fail('workflow_issue_registered');
      // Resolve the plan once. Issue prose never controls local delivery settings.
      const selector = readConfiguration(repository).spec.current;
      if (!selector) fail('spec_current_missing');
      const mode = readSpec(selector).mode.split('.').at(-1);
      const workflow = snapshot(mode);
      const entry = (await rows()).find(row => same(row.path, repository));
      const base = entry?.branch, branch = mode === 'direct-commit' ? null : `codex/issue-${options.issue}`;
      if (!base) fail('workflow_target_branch_required');
      if (!validWorkflowContext(workflow)) fail('invalid_arguments');
      await refHead(base);
      const issueConnection = await repositoryConnection(repository, { execute, signal, github: true });
      const issue = await readWorkflowIssue(issueConnection, options.issue);
      if (issue.state !== 'open') fail('workflow_issue_closed');
      if (workflow.mode === 'direct-commit') {
        if (!same(await git(cwd, ['rev-parse', '--show-toplevel']), repository)) fail('workflow_entry_required');
        // The entry checkout and target branch persist across tasks. Only the
        // prior workflow record blocks preparation; its validity is not implied.
        if (existsSync(contextPath)) fail('workflow_context_exists');
        const row = (await rows()).find(row => same(row.path, repository));
        if (row?.branch !== base) fail('workflow_target_branch_mismatch');
        const start = await refHead(row.branch);
        const record = { schema: 'gidd.workflow.context/v1', issue: options.issue, workflow, target_branch: row.branch, start_commit: start };
        initializeStorage(storage);
        mkdirSync(join(storage.state, 'workflows'), { recursive: true });
        saveContext(contextPath, record);
        return report({ ...record, schema, path: repository, branch: null });
      }
      await git(repository, ['check-ref-format', 'refs/heads/' + branch]);
      const branches = (await git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).split('\n');
      if (branches.some(ref => ref.toLowerCase() === ('refs/heads/' + branch).toLowerCase())) fail('worktree_branch_exists');
      if (workflow.mode === 'pr-merge') {
        if (!await remoteHead(issueConnection, base)) fail('workflow_remote_target_missing');
        if (await remoteHead(issueConnection, branch)) fail('workflow_remote_branch_exists');
      }
      const created = await worktree({ action: 'acquire', issue: options.issue, branch, base, workflow });
      return { ...created, ...report({ workflow }) };
    }
    const summary = { issue: current.issue, path: current.path, branch: current.branch, target_branch: current.target_branch,
      start_commit: current.start_commit, workflow: current.workflow };
    // Resume reads the original context; it never claims an agent session.
    // The short invocation lock is unrelated to workspace availability.
    if (options.action === 'workspace') return report({ ...summary, state: current.state, git: current.git,
      ...(current.reason ? { reason: current.reason } : {}) });
    if (options.action === 'merge') {
      if (current.workflow.mode === 'direct-commit') fail('workflow_not_applicable');
      if (current.reason) fail(current.reason);
      const source = await refHead(current.branch);
      if (!await ancestor(current.start_commit, source)) fail('workflow_history_changed');
      if (current.workflow.mode === 'pr-merge') {
        const connection = await prConnection(repository, execute, signal);
        const result = await connection.merge(current, source, options);
        return report({ ...summary, merged: true, pr: result.number, merge_commit: result.merge, already_merged: result.already_merged });
      }
      if (options.method && options.method !== 'merge') fail('workflow_not_applicable');
      const previous = await refHead(current.target_branch);
      if (!await ancestor(current.start_commit, previous)) fail('workflow_history_changed');
      if (await ancestor(source, previous)) return report({ ...summary, merged: true, target_head: previous, already_merged: true });
      const checkouts = (await rows()).filter(row => row.branch === current.target_branch);
      if (checkouts.length > 1) fail('workflow_target_ambiguous');
      if (!checkouts.length) {
        if (!await ancestor(previous, source)) fail('workflow_target_checkout_required');
        if ((await rows()).some(row => row.branch === current.target_branch)) fail('workflow_target_changed');
        await git(repository, ['update-ref', 'refs/heads/' + current.target_branch, source, previous]);
      } else {
        const checkout = checkouts[0];
        const connection = await repositoryConnection(repository, { execute, signal });
        await cleanTarget(checkout);
        const before = (await rows()).find(row => same(row.path, checkout.path));
        if (before?.branch !== current.target_branch || before.head !== previous || await refHead(current.branch) !== source)
          fail('workflow_target_changed');
        try {
          await connection.git(checkout.path, ['-c', 'submodule.recurse=false', 'merge', '--ff', '--no-squash',
            '--no-edit', '--no-autostash', '--no-overwrite-ignore', '-m', options.message ?? `chore: merge issue #${current.issue}`, source]);
        } catch (error) {
          // Preserve conflicts for the direct_merge_error stage; do not abort,
          // reset, stash or continue a merge automatically.
          if (error.message === 'workflow_remote_failed') fail('workflow_merge_failed');
          throw error;
        }
      }
      const merged = await refHead(current.target_branch);
      if (!await ancestor(source, merged)) fail('workflow_merge_unconfirmed');
      return report({ ...summary, merged: true, target_head: merged, already_merged: false });
    }
    if (options.action === 'push') {
      const branch = current.workflow.mode === 'pr-merge' ? current.branch : current.target_branch;
      const head = await refHead(branch);
      if (!await ancestor(current.start_commit, head)) fail('workflow_history_changed');
      if (current.workflow.mode === 'direct-merge' && !await ancestor(await refHead(current.branch), head)) fail('worktree_not_delivered');
      const connection = await repositoryConnection(repository, { execute, signal });
      await connection.verifyRemote();
      await connection.git(repository, ['-c', `remote.${connection.target.remote}.mirror=false`, 'push',
        '--no-follow-tags', '--no-force', '--recurse-submodules=no', connection.target.remote, head + ':refs/heads/' + branch]);
      return report({ ...summary, pushed_branch: branch, pushed_commit: head });
    }
    if (options.action === 'target-sync') {
      if (current.workflow.mode !== 'pr-merge') fail('workflow_not_applicable');
      const source = await refHead(current.branch);
      if (!await ancestor(current.start_commit, source)) fail('workflow_history_changed');
      const connection = await prConnection(repository, execute, signal);
      const proof = await connection.proof(current, source);
      return await withRemoteTarget(connection, current.target_branch, async incoming => {
        if (!await ancestor(proof.merge, incoming)) fail('workflow_remote_not_delivered');
        const previous = await refHead(current.target_branch);
        if (await ancestor(incoming, previous)) return report({ ...summary, target_head: previous, updated: false, pr: proof.number });
        if (!await ancestor(previous, incoming)) fail('workflow_target_not_fast_forward');
        const checkouts = (await rows()).filter(row => row.branch === current.target_branch);
        if (checkouts.length > 1) fail('workflow_target_ambiguous');
        if (checkouts.length) {
          const checkout = checkouts[0];
          await cleanTarget(checkout);
          const before = (await rows()).find(row => same(row.path, checkout.path));
          if (before?.branch !== current.target_branch || before.head !== previous) fail('workflow_target_changed');
          await connection.git(checkout.path, ['-c', 'submodule.recurse=false', 'merge', '--ff-only', '--no-squash', '--no-edit',
            '--no-autostash', '--no-overwrite-ignore', incoming]);
          const after = (await rows()).find(row => same(row.path, checkout.path));
          if (after?.branch !== current.target_branch || after.head !== incoming) fail('workflow_target_changed');
        } else {
          if ((await rows()).some(row => row.branch === current.target_branch)) fail('workflow_target_changed');
          await git(repository, ['update-ref', 'refs/heads/' + current.target_branch, incoming, previous]);
        }
        return report({ ...summary, target_head: incoming, updated: true, pr: proof.number });
      });
    }
    if (options.action === 'cleanup') {
      if (current.workflow.mode !== 'pr-merge') {
        const connection = await repositoryConnection(repository, { execute, signal });
        await withRemoteTarget(connection, current.target_branch, async incoming => {
          const delivered = await refHead(current.target_branch);
          if (!await ancestor(delivered, incoming)) fail('workflow_target_not_pushed');
        });
      }
      if (current.workflow.mode === 'direct-commit') {
        unlinkSync(contextPath);
        return report({ ...summary, context_removed: true });
      }
      const result = await worktree({ action: 'cleanup', path: current.path });
      return { ...summary, ...result, schema };
    }
    fail('invalid_arguments');
  } finally { lease?.release(); }
}

export const runWorkflow = (repository, options) => withSignals(signal => workflowCommand(repository, options, { signal }));
