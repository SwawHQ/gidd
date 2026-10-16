import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { repositoryConnection } from './repository-remote.mjs';
import { plainPath } from './storage.mjs';
import { parseList, worktreeCommand, readRecords } from '../commands/worktree/index.mjs';
import { prConnection } from './pull-requests.mjs';
import { closeIssue, readIssue } from './issues.mjs';
import { readPolicy } from './policies.mjs';
import { policySnapshot, samePolicySnapshot } from './policy-definition.mjs';
import { readPolicyHistory, recordPolicyUse } from './policy-history.mjs';
import { requireWorkingBranch } from './workspace-branch.mjs';
import { inspectWorkspace, workspaceState } from './workspace-state.mjs';
import { registryLocation, updateRegistry } from './managed-storage.mjs';
import { localDeliveryCommit, localMergeCommit } from './local-delivery.mjs';
import { verifyRemoteBinding, sameRemoteBinding } from './remote-binding.mjs';
import { readTask, readTasks, saveTask, removeTask, taskPath, prepareTaskStorage, saveIssue, issuePath } from './task-records.mjs';
import { repositoryCommandContext, sameRepositoryPath as same } from './repository-command.mjs';
import { prepareTaskRegistration, completeTaskRegistration } from './task-registration.mjs';
import { readCreatePending, saveCreatePending } from './create-pending.mjs';
import { worktreePaths } from './git-worktrees.mjs';

const schema = 'gidd.task-command/v1';
const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const branchName = value => typeof value === 'string' && !!value && !/^[-/.]|[\x00-\x20\x7f\\:]/.test(value) && !value.startsWith('refs/');
const fail = reason => { throw new Error(reason); };

export async function executeTaskOperation(repository, options, { execute, signal, cwd = process.cwd(), context: suppliedContext } = {}) {
  let lease, task;
  try {
  const commandContext = suppliedContext ?? await repositoryCommandContext(repository, { execute, signal, cwd, required: options.action !== 'workspace' });
  const { bindings, invoke, env, git, storage, ensureData } = commandContext;
  lease = commandContext.lease;
  const rows = async () => parseList(await git(repository, ['worktree', 'list', '--porcelain', '-z']));
  // Supplied contexts can span GitHub requests; refresh their repository path.
  const common = suppliedContext ? await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']) : storage.common;
  const report = fields => ({ schema, status: 'ready', target_repository: repository, issue: options.issue, ...fields });
  const worktree = action => worktreeCommand(repository, action, { execute, signal, storageLease: lease });
  const inspect = row => inspectWorkspace(row, { git, common, same });
  const checkReference = async reference => {
    const result = await invoke(bindings.git.path, ['-C', repository, 'symbolic-ref', '--quiet', reference], { env, signal });
    if (result.ok) fail('delivery_target_changed');
    if (result.reason !== 'command_failed') fail(result.reason);
  };
  const refHead = async branch => {
    if (!branchName(branch)) fail('delivery_context_invalid');
    await git(repository, ['check-ref-format', 'refs/heads/' + branch]);
    await checkReference('refs/heads/' + branch);
    return git(repository, ['rev-parse', '--verify', 'refs/heads/' + branch + '^{commit}']);
  };
  const ancestor = async (from, to) => (await invoke(bindings.git.path,
    ['-C', repository, 'merge-base', '--is-ancestor', from, to], { env, signal })).ok;
  const matchRemote = record => verifyRemoteBinding(git, repository, record);
  const taskReport = task => report({ issue: task.issue, target_branch: task.target_branch, delivery: task.delivery, policy: task.policy, github_account: task.github_account });
  if (options.action === 'workspace' && !existsSync(taskPath(storage, options.issue))) {
    const registration = await prepareTaskRegistration(repository, options, commandContext);
    task = registration.task;
    await matchRemote(task);
    await ensureData();
    prepareTaskStorage(storage);
    try {
      const connection = await repositoryConnection(repository, { execute, signal, github: true, record: task });
      task.github_account = connection.target.account;
      const missingCopy = !existsSync(issuePath(storage, task.issue));
      const issue = await readIssue(connection, task.issue, { document: missingCopy });
      if (issue.state !== 'open') fail('issue_closed');
      task = completeTaskRegistration(storage, task, '# ' + issue.title + '\n\n' + issue.body);
    } catch (error) {
      error.workspace = { issue: task.issue, target_repository: repository, target_branch: task.target_branch,
        delivery: task.delivery, policy: task.policy, github_account: task.github_account };
      throw error;
    }
  }
  await ensureData();
  task = readTask(storage, options.issue);
  if (options.action === 'workspace' && task.registration?.complete === false) {
    let text;
    if (!existsSync(issuePath(storage, task.issue))) {
      const connection = await repositoryConnection(repository, { execute, signal, github: true, record: task });
      const issue = await readIssue(connection, task.issue, { document: true });
      if (issue.state !== 'open') fail('issue_closed');
      text = '# ' + issue.title + '\n\n' + issue.body;
    }
    task = completeTaskRegistration(storage, task, text);
  }
  const dedicatedTasks = () => readRecords(registryLocation(storage), storage.path).filter(record =>
    record.issue === task.issue && (!record.ready_head || record.id === task.workspace));
  if (options.action === 'policy.set') {
    if (task.registration?.complete === false) fail('task_registration_pending');
    const policy = policySnapshot(readPolicy(options.policy));
    const dedicated = dedicatedTasks();
    if ((task.workspace || task.preparation || dedicated.length) && policy.mode !== task.delivery.mode) fail('task_policy_mode_locked');
    if (task.preparation || dedicated.some(record => record.preparation)) fail('worktree_preparation_pending');
    if (dedicated.some(record => record.cleanup)) fail('task_cleanup_pending');
    await matchRemote(task);
    if (task.workspace || dedicated.length) await context();
    if (samePolicySnapshot(policy, task.policy)) return taskReport(task);
    readPolicyHistory(storage);
    const previous = { ...task, delivery: { ...task.delivery } };
    task = { ...task, policy, delivery: { ...task.delivery, mode: policy.mode } };
    saveTask(storage, task);
    try { recordPolicyUse(storage, policy); }
    catch (error) { saveTask(storage, previous); throw error; }
    return taskReport(task);
  }
  if (options.action === 'workspace' && options.policy && options.policy !== task.policy.selector &&
      readPolicy(options.policy).selector !== task.policy.selector) fail('task_policy_changed');
  const pending = dedicatedTasks().filter(record => record.preparation);
  if (pending.length > 1) fail('issue_ambiguous');
  if (pending.length && (pending[0].target_branch !== task.target_branch || pending[0].delivery.mode !== task.delivery.mode ||
      !sameRemoteBinding(pending[0].delivery.remote, task.delivery.remote) || task.workspace && task.workspace !== pending[0].id))
    fail('task_workspace_changed');
  const completeCreation = (retiring = false) => {
    const pending = readCreatePending(storage);
    if (pending?.phase !== 'created' || pending.task.issue !== task.issue) return;
    const planned = pending.task;
    if ((retiring || task.workspace && task.registration?.complete) && !task.preparation &&
        task.target_branch === planned.target_branch && task.github_account === planned.github_account &&
        sameRemoteBinding(task.delivery.remote, planned.delivery.remote)) {
      pending.phase = 'ready'; saveCreatePending(storage, pending);
    }
  };
  const finishPreparation = async () => {
    const preparation = task.preparation;
    if (preparation?.reference) {
      await checkReference(preparation.reference);
      const result = await invoke(bindings.git.path, ['-C', repository, 'rev-parse', '--verify', preparation.reference], { env, signal });
      if (result.ok) {
        if (result.text !== preparation.start_commit) fail('delivery_target_changed');
        await git(repository, ['update-ref', '--no-deref', '-d', preparation.reference, preparation.start_commit]);
      } else if (result.reason !== 'command_failed') fail(result.reason);
    }
    delete task.preparation;
    saveTask(storage, task);
    if (options.action === 'workspace') completeCreation();
  };
  if (options.action === 'cleanup' && (pending.length || task.preparation && !task.workspace)) {
    if (pending.length && task.workspace) {
      if (task.workspace !== pending[0].id) fail('task_workspace_changed');
      delete task.workspace;
      saveTask(storage, task);
    }
    const aborted = pending.length ? await worktree({ action: 'abort', path: pending[0].path }) : {};
    await finishPreparation();
    return { ...taskReport(task), ...aborted, preparation_aborted: true, registration_removed: false,
      next: task.issue + ' --policy ' + task.policy.selector };
  }
  if (pending.length && options.action === 'workspace') {
    await matchRemote(task);
    const record = pending[0];
    if (await refHead(task.target_branch) !== record.start_commit) fail('delivery_target_changed');
    const created = await worktree({ action: 'acquire', issue: task.issue, branch: record.branch,
      base: record.target_branch, delivery: task.delivery, expected_start: record.start_commit, defer_commit: true });
    task.workspace = created.id;
    saveTask(storage, task);
    const committed = await worktree({ action: 'commit', path: created.path, issue: task.issue });
    await finishPreparation();
    return { ...committed, ...report({ delivery: task.delivery, policy: task.policy, github_account: task.github_account }) };
  }
  if (options.action === 'cleanup' && task.preparation && task.workspace && !pending.length) await finishPreparation();
  if (pending.length || task.preparation && options.action !== 'workspace') {
    if (options.action !== 'status') fail('worktree_preparation_pending');
    await matchRemote(task);
    return { ...taskReport(task), state: 'needs_check', reason: 'worktree_preparation_pending',
      next: task.issue + ' --policy ' + task.policy.selector };
  }
  // An Issue can be registered without ever allocating a workspace. Retire
  // that local plan even when the caller changed the remote in the meantime.
  if (options.action === 'cleanup' && !task.workspace && !dedicatedTasks().length) {
    completeCreation(true);
    removeTask(storage, task.issue);
    return { ...taskReport(task), registration_removed: true };
  }
  async function context() {
    const dedicated = dedicatedTasks();
    const direct = task.workspace === 'target' ? task : null;
    if (dedicated.length + (direct ? 1 : 0) > 1) fail('issue_ambiguous');
    const recorded = direct ?? dedicated[0];
    if (recorded && (recorded.issue !== task.issue || recorded.target_branch !== task.target_branch ||
        recorded.delivery.mode !== task.delivery.mode || !sameRemoteBinding(recorded.delivery.remote, task.delivery.remote) ||
        task.workspace && task.workspace !== (direct ? 'target' : recorded.id)))
      fail('task_workspace_changed');
    if (direct) {
      const row = (await rows()).find(row => same(row.path, repository));
      const record = { ...direct, path: repository, branch: null };
      requireWorkingBranch(record, row);
      const reason = await inspect(row);
      return { ...record, state: workspaceState({ reason }), git: row, ...(reason ? { reason } : {}) };
    }
    if (!dedicated.length) fail('delivery_context_required');
    const result = await worktree({ action: 'show', path: dedicated[0].path });
    if (!result.record.delivery || result.record.delivery.mode === 'direct-commit') fail('delivery_context_required');
    const record = result.record;
    if (!record.branch || !record.target_branch || !oid(record.start_commit)) fail('delivery_context_invalid');
    if (options.action !== 'cleanup' && record.ready_head) fail('workspace_released');
    if (record.cleanup && !['cleanup', 'workspace', 'status'].includes(options.action)) fail('task_cleanup_pending');
    // Cleanup may have detached HEAD and removed the working branch before an
    // interruption. Only the persisted cleanup commit permits that checkout.
    if (!record.ready_head && !(record.cleanup && result.git?.detached && result.git.head === record.cleanup.head))
      requireWorkingBranch(record, result.git);
    return { ...record, policy: task.policy, github_account: task.github_account,
      state: result.worktree.state, git: result.git, reason: result.worktree.reason, details: result.worktree.details };
  }
  const remoteHead = async (connection, branch, direction = 'push') => {
    await connection.verifyRemote();
    const ref = 'refs/heads/' + branch;
    const text = await connection.git(repository, ['ls-remote', '--refs', connection.remote[direction].url, ref]);
    if (!text) return null;
    const lines = text.split('\n'), fields = lines[0].split('\t');
    if (lines.length !== 1 || fields[1] !== ref || !oid(fields[0])) fail('delivery_remote_response_invalid');
    return fields[0];
  };
  // Fetch a single branch into a private temporary ref, never rewrite a local
  // branch or rely on FETCH_HEAD. Delete only the ref value we actually fetched.
  async function withRemoteTarget(connection, branch, action, direction = 'push') {
    await connection.verifyRemote();
    const temporary = 'refs/gidd/delivery/' + randomUUID();
    let head;
    try {
      await connection.git(repository, ['fetch', '--no-prune', '--no-prune-tags', '--refmap=',
        '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance',
        connection.remote[direction].url, 'refs/heads/' + branch + ':' + temporary]);
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
      if (head) {
        await checkReference(temporary);
        await git(repository, ['update-ref', '--no-deref', '-d', temporary, head]);
      }
    }
  }
  async function fetchPreparation(connection, planned) {
    if (!planned.reference) return;
    await checkReference(planned.reference);
    const existing = await invoke(bindings.git.path, ['-C', repository, 'rev-parse', '--verify', planned.reference], { env, signal });
    if (existing.ok) {
      if (existing.text !== planned.start_commit) fail('delivery_target_changed');
      return;
    }
    if (existing.reason !== 'command_failed') fail(existing.reason);
    await connection.verifyRemote();
    await connection.git(repository, ['fetch', '--no-prune', '--no-prune-tags', '--refmap=',
      '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance',
      connection.remote.fetch.url, planned.start_commit + ':' + planned.reference]);
    if (await git(repository, ['rev-parse', '--verify', planned.reference]) !== planned.start_commit) fail('delivery_target_changed');
  }
  async function cleanTarget(row, stagedTree) {
    plainPath(row.path);
    if (row.bare || row.locked || row.prunable) fail('delivery_target_unavailable');
    const paths = await worktreePaths(git, row.path);
    if (!paths || !same(paths.root, row.path) || !same(paths.common, common)) fail('delivery_target_unavailable');
    const directory = paths.gitDir;
    plainPath(directory);
    if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START', 'index.lock', 'HEAD.lock']
      .some(name => existsSync(join(directory, name)))) fail('delivery_target_busy');
    if ((await git(row.path, ['ls-files', '-v', '-z'])).split('\0').some(line => /^[a-zS] /.test(line))) fail('delivery_target_index_flags');
    if (await git(row.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])) {
      if (!stagedTree || await git(row.path, ['ls-files', '--unmerged', '-z']) ||
          await git(row.path, ['diff', '--name-only', '-z', '--ignore-submodules=none']) ||
          await git(row.path, ['ls-files', '--others', '--exclude-standard', '-z']) ||
          await git(row.path, ['write-tree']) !== stagedTree) fail('delivery_target_dirty');
    }
  }
  async function fastForwardTarget(connection, branch, previous, incoming) {
    if (await refHead(branch) !== previous) fail('delivery_target_changed');
    const checkouts = (await rows()).filter(row => row.branch === branch);
    if (checkouts.length > 1) fail('delivery_target_ambiguous');
    if (checkouts.length) {
      const checkout = checkouts[0];
      await cleanTarget(checkout);
      const before = (await rows()).find(row => same(row.path, checkout.path));
      if (before?.branch !== branch || before.head !== previous) fail('delivery_target_changed');
      await connection.git(checkout.path, ['-c', 'submodule.recurse=false', 'merge', '--ff-only', '--no-squash', '--no-edit',
        '--no-autostash', '--no-overwrite-ignore', incoming]);
      const after = (await rows()).find(row => same(row.path, checkout.path));
      if (after?.branch !== branch || after.head !== incoming) fail('delivery_target_changed');
    } else {
      if ((await rows()).some(row => row.branch === branch)) fail('delivery_target_changed');
      await git(repository, ['update-ref', '--no-deref', 'refs/heads/' + branch, incoming, previous]);
    }
    if (await refHead(branch) !== incoming) fail('delivery_target_changed');
  }
    const starting = options.action === 'workspace' && !task.workspace && !dedicatedTasks().length;
    await matchRemote(task);
    if (options.action === 'status' && !task.workspace && !dedicatedTasks().length)
      return { ...taskReport(task), state: 'not_prepared', next: task.issue + ' --policy ' + task.policy.selector };
    const current = starting ? null : await context();
    if (options.action === 'workspace' && !starting && !task.workspace) {
      task.workspace = current.id;
      await finishPreparation();
    }
    if (options.action === 'workspace' && task.workspace && task.preparation) await finishPreparation();
    if (starting) {
      if (task.workspace || dedicatedTasks().length) fail('issue_registered');
      // Task registration owns the plan. Preparation only adds resources.
      const { delivery, target_branch: base } = task, mode = delivery.mode;
      const branch = mode === 'direct-commit' ? null : `gidd-issue-${options.issue}`;
      await refHead(base);
      // Reject occupied resources before any preparation-time target update.
      if (delivery.mode === 'direct-commit') {
        if (!same(await git(cwd, ['rev-parse', '--show-toplevel']), repository)) fail('task_entry_required');
        if (readTasks(storage).some(item => item.workspace === 'target')) fail('delivery_context_exists');
      } else {
        await git(repository, ['check-ref-format', 'refs/heads/' + branch]);
        const branches = (await git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).split('\n');
        if (branches.some(ref => ref.toLowerCase() === ('refs/heads/' + branch).toLowerCase())) fail('worktree_branch_exists');
      }
      const issueConnection = await repositoryConnection(repository, { execute, signal, github: true,
        record: task });
      const missingCopy = !existsSync(issuePath(storage, task.issue));
      const issue = await readIssue(issueConnection, options.issue, { document: missingCopy });
      if (issue.state !== 'open') fail('issue_closed');
      if (missingCopy) saveIssue(storage, task.issue, '# ' + issue.title + '\n\n' + issue.body);
      if (delivery.mode === 'pr-merge' && await remoteHead(issueConnection, branch)) fail('delivery_remote_branch_exists');
      const entryHead = async () => {
        const row = (await rows()).find(row => same(row.path, repository));
        if (row?.branch !== base) fail('delivery_target_branch_mismatch');
        return refHead(base);
      };
      let start;
      if (!task.preparation) {
        const incoming = await remoteHead(issueConnection, delivery.remote.fetch.branch, 'fetch');
        if (mode === 'pr-merge' && !await remoteHead(issueConnection, base)) fail('delivery_remote_target_missing');
        if (!incoming && mode === 'pr-merge') fail('delivery_remote_target_missing');
        const previous = await entryHead();
        task.preparation = { start_commit: incoming ?? previous, previous_commit: previous,
          ...(incoming ? { reference: 'refs/gidd/delivery/' + randomUUID() } : {}) };
        saveTask(storage, task);
      }
      const planned = task.preparation;
      start = planned.start_commit;
      await fetchPreparation(issueConnection, planned);
      const actual = await entryHead();
      if (actual !== start) {
        if (actual !== planned.previous_commit) fail('delivery_target_changed');
        // Reject a rewind or divergence before any target mutation.
        if (await ancestor(start, actual)) { await finishPreparation(); fail('delivery_target_ahead'); }
        if (!await ancestor(actual, start)) { await finishPreparation(); fail('delivery_target_diverged'); }
        await fastForwardTarget(issueConnection, base, actual, start);
      }
      if (await entryHead() !== start) fail('delivery_target_changed');
      if (delivery.mode === 'direct-commit') {
        // The entry checkout and target branch persist across tasks. Only the
        // prior delivery record blocks preparation; its validity is not implied.
        task.workspace = 'target';
        task.start_commit = start;
        await finishPreparation();
        const record = { issue: task.issue, delivery, target_branch: base, start_commit: start };
        const reason = await inspect((await rows()).find(row => same(row.path, repository)));
        return report({ ...record, schema, policy: task.policy, github_account: task.github_account, path: repository, branch: null, state: workspaceState({ reason }),
          ...(reason ? { reason } : {}) });
      }
      const created = await worktree({ action: 'acquire', issue: options.issue, branch, base, delivery, expected_start: start, defer_commit: true });
      task.workspace = created.id;
      saveTask(storage, task);
      const committed = await worktree({ action: 'commit', path: created.path, issue: task.issue });
      await finishPreparation();
      return { ...committed, ...report({ delivery, policy: task.policy, github_account: task.github_account }) };
    }
    const summary = { issue: current.issue, path: current.path, branch: current.branch, target_branch: current.target_branch,
      start_commit: current.start_commit, delivery: current.delivery, state: current.state,
      ...(current.reason ? { reason: current.reason, details: current.details } : {}) };
    // Resume reads the original context; it never claims an agent session.
    // The short invocation lock is unrelated to workspace availability.
    if (['workspace', 'status'].includes(options.action)) {
      if (options.action === 'workspace') completeCreation();
      return report({ ...summary, policy: task.policy, github_account: task.github_account, state: current.state, git: current.git,
        ...(current.reason ? { reason: current.reason } : {}) });
    }
    const saveMerge = merge => {
      const record = dedicatedTasks().find(record => record.id === current.id);
      record.local_merge = merge;
      updateRegistry(registryLocation(storage), record.id, record);
      current.local_merge = merge;
    };
    if (options.action === 'merge') {
      if (current.delivery.mode === 'direct-commit' || current.delivery.mode === 'direct-merge' && options.method === 'rebase') fail('delivery_not_applicable');
      if (current.reason) fail(current.reason);
      const source = await refHead(current.branch);
      if (!await ancestor(current.start_commit, source)) fail('delivery_history_changed');
      const mergedReport = fields => report({ ...summary, state: 'assigned', ...fields });
      if (current.delivery.mode === 'pr-merge') {
        const connection = await prConnection(repository, execute, signal, { ...current, github_account: task.github_account });
        const result = await connection.merge(current, source, options);
        return mergedReport({ merged: true, pr: result.number, merge_commit: result.merge, already_merged: result.already_merged });
      }
      const previous = await refHead(current.target_branch);
      if (!await ancestor(current.start_commit, previous)) fail('delivery_history_changed');
      let planned = current.local_merge;
      const { method, message } = options;
      const checkouts = (await rows()).filter(row => row.branch === current.target_branch);
      if (checkouts.length > 1) fail('delivery_target_ambiguous');
      if (await ancestor(source, previous) && (!planned || planned.commit)) {
        saveMerge({ head: source, commit: previous });
        return mergedReport({ merged: true, target_head: previous, already_merged: true });
      }
      if (planned && !planned.commit && (planned.head !== source ||
          method && method !== 'squash' || message !== undefined && message !== planned.message))
        fail('delivery_merge_changed');
      if (planned?.head === source) {
        const commit = await localMergeCommit(planned, previous, args => git(repository, args));
        if (commit && await ancestor(commit, previous)) {
          saveMerge({ head: source, commit });
          return mergedReport({ merged: true, target_head: previous, merge_commit: commit, already_merged: true });
        }
      }
      if (method === 'squash' || planned && !planned.commit) {
        if (!checkouts.length) fail('delivery_target_checkout_required');
        const checkout = checkouts[0];
        const connection = await repositoryConnection(repository, { execute, signal, record: current });
        await cleanTarget(checkout, planned && !planned.commit ? planned.tree : undefined);
        if (checkout.head !== previous || await refHead(current.branch) !== source) fail('delivery_target_changed');
        try {
          if (!planned || planned.commit) {
            const tree = await connection.git(checkout.path, ['merge-tree', '--write-tree', '--no-messages', previous, source]);
            if (!oid(tree)) fail('delivery_merge_unconfirmed');
            planned = { head: source, before: previous, tree, message: message ?? 'chore: merge issue #' + current.issue };
            saveMerge(planned);
          }
          const before = (await rows()).find(row => same(row.path, checkout.path));
          if (before?.branch !== current.target_branch || before.head !== previous || previous !== planned.before ||
              await refHead(current.target_branch) !== previous || await refHead(current.branch) !== source) fail('delivery_target_changed');
          if (await git(checkout.path, ['write-tree']) !== planned.tree) {
            await cleanTarget(checkout);
            // Use the same ort plan as merge-tree, independent of branch merge options.
            await connection.git(checkout.path, ['-c', 'submodule.recurse=false',
              '-c', 'branch.' + current.target_branch + '.mergeOptions=', 'merge', '--squash', '--ff', '-s', 'ort',
              '--no-edit', '--no-autostash', '--no-overwrite-ignore', source]);
          }
          await cleanTarget(checkout, planned.tree);
          const staged = (await rows()).find(row => same(row.path, checkout.path));
          if (staged?.branch !== current.target_branch || staged.head !== previous ||
              await git(checkout.path, ['write-tree']) !== planned.tree || await refHead(current.target_branch) !== previous ||
              await refHead(current.branch) !== source) fail('delivery_target_changed');
          await connection.git(checkout.path, ['-c', 'submodule.recurse=false', 'commit', '--allow-empty', '-m', planned.message]);
        } catch (error) {
          if (error.message === 'delivery_remote_failed') fail('delivery_merge_failed');
          throw error;
        }
        const merged = await refHead(current.target_branch);
        const commit = await localMergeCommit(planned, merged, args => git(repository, args));
        if (!commit || commit !== merged || await refHead(current.branch) !== source) fail('delivery_merge_unconfirmed');
        saveMerge({ head: source, commit });
        return mergedReport({ merged: true, target_head: merged, merge_commit: commit, already_merged: false });
      }
      if (!checkouts.length) {
        if (!await ancestor(previous, source)) fail('delivery_target_checkout_required');
        if ((await rows()).some(row => row.branch === current.target_branch)) fail('delivery_target_changed');
        await git(repository, ['update-ref', '--no-deref', 'refs/heads/' + current.target_branch, source, previous]);
      } else {
        const checkout = checkouts[0];
        const connection = await repositoryConnection(repository, { execute, signal, record: current });
        await cleanTarget(checkout);
        const before = (await rows()).find(row => same(row.path, checkout.path));
        if (before?.branch !== current.target_branch || before.head !== previous || await refHead(current.branch) !== source)
          fail('delivery_target_changed');
        try {
          await connection.git(checkout.path, ['-c', 'submodule.recurse=false', 'merge', '--ff', '--no-squash',
            '--no-edit', '--no-autostash', '--no-overwrite-ignore', '-m', message ?? 'chore: merge issue #' + current.issue, source]);
        } catch (error) {
          // Preserve conflicts for the direct_merge_error stage; never abort or reset them automatically.
          if (error.message === 'delivery_remote_failed') fail('delivery_merge_failed');
          throw error;
        }
      }
      const merged = await refHead(current.target_branch);
      if (!await ancestor(source, merged)) fail('delivery_merge_unconfirmed');
      saveMerge({ head: source, commit: merged });
      return mergedReport({ merged: true, target_head: merged, already_merged: false });
    }
    if (options.action === 'push') {
      const branch = current.delivery.mode === 'pr-merge' ? current.branch : current.target_branch;
      const head = await refHead(branch);
      if (!await ancestor(current.start_commit, head)) fail('delivery_history_changed');
      if (current.delivery.mode === 'direct-merge') {
        const source = await refHead(current.branch);
        const commit = await localDeliveryCommit(current, source, head, args => git(repository, args));
        if (current.local_merge && !current.local_merge.commit) saveMerge({ head: source, commit });
      }
      const connection = await repositoryConnection(repository, { execute, signal, record: current });
      await connection.verifyRemote();
      await connection.git(repository, ['push', '--no-mirror',
        '--no-follow-tags', '--no-force', '--recurse-submodules=no', connection.remote.push.url, head + ':refs/heads/' + branch]);
      return report({ ...summary, pushed_branch: branch, pushed_commit: head });
    }
    if (options.action === 'target-sync') {
      if (current.delivery.mode !== 'pr-merge') fail('delivery_not_applicable');
      const source = await refHead(current.branch);
      if (!await ancestor(current.start_commit, source)) fail('delivery_history_changed');
      const connection = await prConnection(repository, execute, signal, { ...current, github_account: task.github_account });
      const proof = await connection.proof(current, source);
      return await withRemoteTarget(connection, current.target_branch, async incoming => {
        if (!await ancestor(proof.merge, incoming)) fail('delivery_remote_not_delivered');
        const previous = await refHead(current.target_branch);
        if (await ancestor(incoming, previous)) return report({ ...summary, target_head: previous, updated: false, pr: proof.number });
        if (!await ancestor(previous, incoming)) fail('delivery_target_not_fast_forward');
        await fastForwardTarget(connection, current.target_branch, previous, incoming);
        return report({ ...summary, target_head: incoming, updated: true, pr: proof.number });
      });
    }
    if (options.action === 'close-issue') {
      try {
        // Direct commit keeps the caller's files; normal edits do not block
        // verification and closure of already published commits.
        if (current.reason && !(current.delivery.mode === 'direct-commit' && current.reason === 'worktree_dirty')) fail(current.reason);
        const target = await refHead(current.target_branch);
        const source = current.branch ? await refHead(current.branch) : null;
        if (!await ancestor(current.start_commit, source ?? target) || !await ancestor(current.start_commit, target))
          fail('delivery_history_changed');
        const connection = current.delivery.mode === 'pr-merge'
          ? await prConnection(repository, execute, signal, { ...current, github_account: task.github_account })
          : await repositoryConnection(repository, { execute, signal, github: true, record: current });
        const proof = current.delivery.mode === 'pr-merge' ? await connection.proof(current, source) : null;
        if (source && !proof) {
          const commit = await localDeliveryCommit(current, source, target, args => git(repository, args));
          if (current.local_merge && !current.local_merge.commit) saveMerge({ head: source, commit });
        }
        await withRemoteTarget(connection, current.target_branch, async incoming => {
          if (!proof) {
            if (!await ancestor(target, incoming)) fail('delivery_target_not_pushed');
          } else {
            if (!await ancestor(proof.merge, incoming)) fail('delivery_remote_not_delivered');
            if (!await ancestor(proof.merge, target) || !await ancestor(incoming, target)) fail('delivery_target_not_synced');
          }
        });
        const beforeWrite = async () => {
          await matchRemote(current);
          await context();
          if (await refHead(current.target_branch) !== target || (source && await refHead(current.branch) !== source))
            fail('delivery_target_changed');
        };
        const result = await closeIssue(connection, current.issue, { pr: proof, beforeWrite });
        return report({ ...summary, ...result });
      } catch (error) {
        const { reason: diagnosticReason, ...retryContext } = summary;
        error.workspace = { ...retryContext, ...error.workspace, ...error.issueClosure,
          retry: current.issue + '.close-issue' };
        throw error;
      }
    }
    if (options.action === 'cleanup') {
      if (current.delivery.mode !== 'pr-merge') {
        const connection = await repositoryConnection(repository, { execute, signal, record: current });
        await withRemoteTarget(connection, current.target_branch, async incoming => {
          const delivered = await refHead(current.target_branch);
          if (!await ancestor(delivered, incoming)) fail('delivery_target_not_pushed');
        });
      }
      if (current.delivery.mode === 'direct-commit') {
        const checkout = (await rows()).find(row => same(row.path, repository));
        requireWorkingBranch(current, checkout);
        const reason = await inspect(checkout);
        completeCreation(true);
        removeTask(storage, task.issue);
        const { reason: previousReason, ...released } = summary;
        return report({ ...released, context_removed: true, state: workspaceState({ released: true, reason }),
          ...(reason ? { reason } : {}) });
      }
      const result = await worktree({ action: 'cleanup', path: current.path, github_account: task.github_account });
      if (result.status === 'ready') { completeCreation(true); removeTask(storage, task.issue); }
      const { reason: previousReason, ...released } = summary;
      return { ...released, ...result, schema };
    }
    fail('invalid_arguments');
  } catch (error) {
    if (options.action === 'workspace' && task?.issue) error.workspace = {
      issue: task.issue, target_repository: repository, target_branch: task.target_branch,
      delivery: task.delivery, policy: task.policy, github_account: task.github_account,
      retry: task.issue + ' --policy ' + task.policy.selector, ...error.workspace,
    };
    throw error;
  } finally { if (!suppliedContext) lease?.release(); }
}
