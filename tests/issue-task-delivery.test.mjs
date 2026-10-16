import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { realpathSync, unlinkSync } from 'node:fs';
import { worktreeCommand } from '../.agents/skills/gidd/scripts.js/commands/worktree/index.mjs';
import { workspaceReport } from '../.agents/skills/gidd/scripts.js/shared/workspace-report.mjs';
import { readPolicy } from '../.agents/skills/gidd/scripts.js/shared/policies.mjs';
import { policySnapshot } from '../.agents/skills/gidd/scripts.js/shared/policy-definition.mjs';
import { recordPolicyUse, policyStorage } from '../.agents/skills/gidd/scripts.js/shared/policy-history.mjs';
import { assert, existsSync, join, readFileSync, write } from './support/helpers.mjs';
import { installation } from './support/issue-task.mjs';

test('separate fetch and delivery repositories stay distinct through PR merge, sync, Issue closure and cleanup', async (t) => {
  const s = installation(t);
  try {
    const source = join(s.root, 'source.git');
    s.native(['init', '--bare', source]); s.native(['push', source, 'main']);
    s.control.fetchBare = source;
    s.native(['remote', 'add', 'for.swaw.gidd', 'https://github.com/upstream/repo.git']);
    s.native(['config', 'remote.for.swaw.gidd.pushurl', 'https://github.com/test/repo.git']);
    const prepared = await s.command('workspace', ['7']);
    assert.equal(prepared.target.remote.fetch.repository, 'https://github.com/upstream/repo');
    assert.equal(prepared.target.remote.push.repository, 'https://github.com/test/repo');
    assert.equal(prepared.issue.url, 'https://github.com/test/repo/issues/7');
    const head = s.change(prepared.workspace.path);
    await s.command('push', ['7']);
    assert.equal(s.native(['rev-parse', 'gidd-issue-7'], s.bare), head);
    assert.equal(s.native(['branch', '--list', 'gidd-issue-7'], source), '');
    s.control.pr = { number: 42, node_id: 'PR_42', state: 'open', draft: false,
      head: { ref: 'gidd-issue-7', sha: head, repo: { full_name: 'test/repo' } },
      base: { ref: 'main', repo: { full_name: 'test/repo' } } };
    await s.command('merge', ['7']);
    s.control.calls.length = 0;
    await s.command('target-sync', ['7']);
    await s.command('close-issue', ['7']);
    await s.command('cleanup', ['7']);
    assert.equal(s.native(['rev-parse', 'main']), head);
    assert.equal(s.native(['rev-parse', 'main'], source), s.initial);
    assert.equal(s.native(['branch', '--list', 'gidd-issue-7'], s.bare), '');
    assert.ok(s.control.calls.filter(args => args.includes('fetch')).every(args => args.includes('https://github.com/test/repo.git')));
    assert.ok(s.control.calls.filter(args => args[0] === 'api').every(args => !args.at(-1).includes('repos/upstream/')));
  } finally { await s.dispose(); }
});

test('task delivery follows the target branch after alias and transport changes and ignores working defaults', async (t) => {
  const s = installation(t);
  try {
    const prepared = await s.command('workspace', ['2']);
    s.native(['remote', 'rename', 'origin', 'renamed']);
    s.native(['config', 'branch.main.remote', 'renamed']);
    s.native(['remote', 'add', 'other', 'https://github.com/test/other.git']);
    s.native(['config', 'branch.gidd-issue-2.remote', 'other']);
    s.native(['config', 'branch.gidd-issue-2.pushRemote', 'other']);
    s.native(['config', 'remote.renamed.pushurl', 'git@github.com:test/repo.git']);
    const head = s.change(prepared.workspace.path);
    await s.command('merge', ['2']);
    await s.command('push', ['2']);
    assert.equal(s.native(['rev-parse', 'main'], s.bare), head);
    const push = s.control.calls.findLast(args => args.includes('push'));
    assert.ok(push.includes('git@github.com:test/repo.git'));
    assert.ok(!push.includes('renamed') && !push.includes('other'));
    s.native(['config', '--add', 'remote.renamed.pushurl', 'https://github.com/test/repo.git']);
    await assert.rejects(s.command('push', ['2']), /remote_multiple_push_urls/);
  } finally { await s.dispose(); }
});

test('current workspace retains its starting point, pushes only the target and cleans only its context', async (t) => {
  const s = installation(t);
  try {
    const prepared = await s.command('workspace', ['1']);
    assert.equal(prepared.status, 'success');
    assert.equal(prepared.workspace.state, 'assigned');
    assert.equal(prepared.target.remote.push.name, undefined);
    assert.equal(prepared.target.remote.push.repository, 'https://github.com/test/repo');
    assert.equal(Object.hasOwn(prepared, 'delivery'), false);
    assert.equal(prepared.workspace.delivery_mode, 'direct-commit');
    assert.equal(prepared.target.path, s.target);
    assert.equal(Object.hasOwn(prepared.target, 'repository'), false);
    assert.equal(Object.hasOwn(prepared, 'worktree'), false);
    assert.equal(prepared.workspace.path, s.target);
    for (const field of ['workspace_path', 'workspace_state', 'worktree_path', 'worktree_state', 'target_repository', 'target_branch', 'delivery_mode', 'start_commit', 'development_branch']) assert.equal(Object.hasOwn(prepared, field), false);
    assert.equal(prepared.workspace.branch, 'main');
    for (const field of ['development_branch', 'checked_out_branch']) assert.equal(Object.hasOwn(prepared.workspace, field), false);
    assert.equal(prepared.target.branch, 'main'); assert.equal(prepared.workspace.start_commit, s.initial);
    const resumed = await s.command('status', ['1']);
    assert.equal(resumed.workspace.path, s.target);
    assert.equal(resumed.workspace.delivery_mode, 'direct-commit');
    assert.equal(Object.hasOwn(resumed, 'delivery_mode'), false);
    assert.equal(resumed.workspace.state, 'assigned');
    assert.equal(resumed.workspace.head, s.initial);
    assert.equal(resumed.workspace.branch, 'main');
    assert.equal(Object.hasOwn(resumed, 'state'), false);
    await assert.rejects(s.command('target-sync', ['1']), /delivery_not_applicable/);
    const recordPath = join(s.target + '.gidd', '1/state.json');
    const originalRecord = readFileSync(recordPath, 'utf8');
    assert.equal((await s.command('workspace', ['1'])).issue.number, 1);
    assert.equal(readFileSync(recordPath, 'utf8'), originalRecord);
    const head = s.change(s.target);
    s.native(['branch', 'other']); s.native(['tag', '-a', 'do-not-push', '-m', 'tag']);
    s.native(['config', 'push.followTags', 'true']); s.native(['config', 'remote.origin.mirror', 'true']);
    recordPolicyUse(policyStorage(s.target), policySnapshot(readPolicy('02/00')));
    const continued = await s.command('status', ['1']);
    assert.equal(continued.workspace.start_commit, s.initial);
    assert.equal(continued.workspace.head, head);
    assert.equal(continued.workspace.branch, 'main');
    await assert.rejects(s.command('cleanup', ['1']), /delivery_target_not_pushed/);
    const pushed = await s.command('push', ['1']);
    assert.equal(pushed.workspace.state, 'assigned');
    assert.equal(pushed.workspace.path, prepared.workspace.path);
    assert.equal(pushed.workspace.branch, 'main');
    assert.equal(pushed.pushed_branch, 'main'); assert.equal(pushed.pushed_commit, head);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)'], s.bare), 'refs/heads/main');
    write(join(s.target, 'keep.tmp'), 'user file');
    const cleaned = await s.command('cleanup', ['1']);
    assert.equal(cleaned.context_removed, true); assert.equal(cleaned.status, 'success');
    assert.equal(cleaned.workspace.state, 'needs_check'); assert.deepEqual(cleaned.workspace.details, { code: 'worktree_dirty' });
    assert.equal(Object.hasOwn(cleaned, 'reason'), false); assert.equal(cleaned.details, undefined);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
    assert.equal(s.native(['branch', '--show-current']), 'main');
    assert.equal(existsSync(join(s.target + '.gidd', '1/state.json')), false);
    await assert.rejects(s.command('push', ['999']), /task_required/);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    const next = await s.command('workspace', ['10']);
    assert.equal(next.workspace.state, 'assigned'); assert.equal(next.workspace.details, undefined);
    assert.equal(Object.hasOwn(next, 'reason'), false);
    assert.equal(next.workspace.start_commit, head);
    assert.equal(next.target.branch, 'main');
    assert.equal(next.workspace.path, prepared.workspace.path);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
    unlinkSync(join(s.target, 'keep.tmp'));
    const ready = await s.command('cleanup', ['10']);
    assert.equal(ready.workspace.state, 'available'); assert.equal(ready.workspace.details, undefined);
  } finally { await s.dispose(); }
});

test('dedicated direct delivery requires merge, selects the target and releases the recorded workspace', async (t) => {
  const s = installation(t);
  try {
    const a = await s.command('workspace', ['2']);
    assert.equal(a.workspace.state, 'assigned');
    assert.equal(a.schema, 'gidd.task-command/v1'); assert.equal(a.workspace.delivery_mode, 'direct-merge');
    assert.equal(realpathSync.native(a.workspace.path), a.workspace.path);
    const head = s.change(a.workspace.path);
    const continued = await s.command('status', ['2']);
    assert.equal(continued.workspace.head, head);
    assert.equal(continued.workspace.start_commit, s.initial);
    assert.equal(continued.workspace.branch, 'gidd-issue-2');
    await assert.rejects(s.command('push', ['999']), /task_required/);
    await assert.rejects(s.command('push', ['2'], a.workspace.path), /worktree_not_delivered/);
    assert.equal((await s.command('merge', ['2'])).target.head, head);
    await assert.rejects(s.command('cleanup', ['2']), /delivery_target_not_pushed/);
    const result = await s.command('push', ['2']);
    assert.equal(result.workspace.state, 'assigned');
    assert.equal(result.pushed_branch, 'main'); assert.equal(result.pushed_commit, head);
    assert.equal(s.native(['branch', '--list', 'gidd-issue-2'], s.bare), '');
    assert.equal((await s.command('cleanup', ['2'])).local_branch_deleted, true);
    assert.equal((await s.show(a.workspace.path)).worktree.state, 'available');
    await assert.rejects(s.command('status', ['2']), /task_required/);
    const b = await s.command('workspace', ['3']);
    assert.equal(b.workspace.path, a.workspace.path); assert.equal(b.workspace.delivery_mode, 'pr-merge');
    assert.equal((await s.show(b.workspace.path)).record.delivery.mode, 'pr-merge');
  } finally { await s.dispose(); }
});

test('PR target sync verifies squash delivery, fast-forwards the checked out target, then cleanup deletes working branch refs', async (t) => {
  const s = installation(t);
  try {
    const { workspace, merge } = await s.delivery();
    await assert.rejects(s.command('cleanup', ['7']), /worktree_not_delivered/);
    s.native(['config', 'remote.origin.prune', 'true']); s.native(['config', 'remote.origin.pruneTags', 'true']);
    s.native(['config', 'fetch.prune', 'true']); s.native(['config', 'fetch.pruneTags', 'true']);
    s.native(['config', 'branch.main.mergeOptions', '--squash --autostash --overwrite-ignore']);
    s.native(['tag', 'keep-tag', s.initial]); s.native(['tag', 'remote-tag', s.initial], s.bare);
    s.native(['update-ref', 'refs/remotes/origin/main', s.initial]);
    s.native(['update-ref', 'refs/remotes/origin/stale', s.initial]);
    const synced = await s.command('target-sync', ['7'], workspace.workspace.path);
    assert.equal(synced.workspace.state, 'assigned');
    assert.equal(synced.target.head, merge);
    assert.equal(Object.hasOwn(synced.workspace, 'head'), false);
    assert.equal(synced.updated, true); assert.equal(synced.pr, 42);
    assert.equal(s.native(['rev-parse', 'main']), merge);
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'feature\n');
    assert.equal(s.native(['tag', '--list']), 'keep-tag');
    assert.equal(s.native(['rev-parse', 'refs/remotes/origin/main']), s.initial);
    assert.equal(s.native(['rev-parse', 'refs/remotes/origin/stale']), s.initial);
    assert.equal(s.native(['status', '--porcelain']), '');
    assert.equal((await s.command('target-sync', ['7'])).updated, false);
    const cleaned = await s.command('cleanup', ['7']);
    assert.deepEqual(cleaned.target, workspace.target);
    assert.equal(cleaned.workspace.delivery_mode, workspace.workspace.delivery_mode);
    assert.equal(cleaned.local_branch_deleted, true); assert.equal(cleaned.remote_branch_deleted, true);
    assert.equal(s.native(['branch', '--list', 'gidd-issue-7']), '');
    assert.equal(s.native(['branch', '--list', 'gidd-issue-7'], s.bare), '');
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'available');
  } finally { await s.dispose(); }
});

test('sync preserves dirty, hidden and diverged target work instead of stashing or resetting it', async (t) => {
  const s = installation(t);
  try {
    await s.delivery();
    write(join(s.target, 'tracked.txt'), 'keep me\n');
    await assert.rejects(s.command('target-sync', ['7']), /delivery_target_dirty/);
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'keep me\n');
    s.native(['update-index', '--assume-unchanged', 'tracked.txt']);
    await assert.rejects(s.command('target-sync', ['7']), /delivery_target_index_flags/);
    s.native(['update-index', '--no-assume-unchanged', 'tracked.txt']);
    const diverged = s.change(s.target, 'diverged');
    await assert.rejects(s.command('target-sync', ['7']), /delivery_target_not_fast_forward/);
    assert.equal(s.native(['rev-parse', 'main']), diverged);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
  } finally { await s.dispose(); }
});

test('sync finds the target in another checkout and also supports an unoccupied target ref', async (t) => {
  const s = installation(t);
  try {
    const { merge } = await s.delivery();
    s.native(['checkout', '-b', 'parking']);
    const targetPath = join(s.root, 'target checkout');
    s.native(['worktree', 'add', targetPath, 'main']);
    await s.command('target-sync', ['7']);
    assert.equal(s.native(['rev-parse', 'HEAD'], targetPath), merge);
    assert.equal(s.native(['branch', '--show-current']), 'parking');
    s.native(['checkout', '--detach'], targetPath);
    s.native(['update-ref', 'refs/heads/main', s.initial, merge]);
    await s.command('target-sync', ['7']);
    assert.equal(s.native(['rev-parse', 'main']), merge);
    assert.equal(s.native(['rev-parse', 'HEAD']), s.initial);
  } finally { await s.dispose(); }
});

test('sync CAS rejects a concurrent update to an unoccupied target branch', async (t) => {
  const s = installation(t);
  try {
    const { merge } = await s.delivery();
    s.native(['checkout', '-b', 'parking']);
    const concurrent = s.change(s.target, 'concurrent');
    s.control.intercept = async (exe, args) => {
      if (args.includes('update-ref') && args.includes('refs/heads/main') && args.includes(merge)) {
        s.control.intercept = null;
        s.native(['update-ref', 'refs/heads/main', concurrent, s.initial]);
      }
    };
    await assert.rejects(s.command('target-sync', ['7']), /delivery_git_failed/);
    assert.equal(s.native(['rev-parse', 'main']), concurrent);
  } finally { await s.dispose(); }
});

for (const [mode, issue] of [['direct-commit', 1], ['direct-merge', 2], ['pr-merge', 3]]) {
  test(`${mode} rejects another branch or detached HEAD before delivery actions and preserves the recorded branch`, async (t) => {
    const s = installation(t);
    try {
      const prepared = await s.command('workspace', [String(issue)]), path = prepared.workspace.path;
      const expected = mode === 'direct-commit' ? 'main' : `gidd-issue-${issue}`;
      assert.equal(prepared.workspace.branch, expected);
      assert.equal(prepared.workspace.state, 'assigned');
      const tracked = join(path, 'tracked.txt'), original = readFileSync(tracked, 'utf8');
      write(tracked, 'normal task edit\n');
      let inspected = await s.command('status', [String(issue)]);
      assert.equal(inspected.workspace.state, 'assigned'); assert.equal(inspected.workspace.details, undefined);
      assert.equal(Object.hasOwn(inspected, 'reason'), false); assert.equal(inspected.details, undefined);
      s.native(['update-index', '--assume-unchanged', 'tracked.txt'], path);
      inspected = await s.command('status', [String(issue)]);
      assert.equal(inspected.workspace.state, 'needs_check'); assert.deepEqual(inspected.workspace.details, { code: 'worktree_index_flags' });
      s.native(['update-index', '--no-assume-unchanged', 'tracked.txt'], path);
      write(tracked, original);
      s.native(['checkout', '-b', 'manual-branch'], path);
      const record = readFileSync(mode === 'direct-commit'
        ? join(s.target + '.gidd', String(issue), 'state.json')
        : join(s.target + '.gidd', 'storage.json'), 'utf8');
      s.control.calls.length = 0;
      for (const action of ['workspace', 'push', 'merge', 'target-sync', 'close-issue', 'cleanup']) {
        const args = [String(issue)];
        await assert.rejects(s.command(action, args), error => {
          assert.equal(error.message, 'workspace_branch_changed');
          assert.deepEqual(error.details, { path, expected_branch: expected, actual_branch: 'manual-branch' });
          const report = workspaceReport({ schema: 'gidd.task-command/v1', status: 'error', reason: error.message,
            ...error.workspace, details: error.details });
          assert.equal(report.schema, 'gidd.task-command/v1');
          assert.equal(report.workspace.branch, expected);
          assert.equal(report.workspace.state, 'needs_check');
          assert.deepEqual(report.details, { code: 'workspace_branch_changed', ...error.details });
          assert.equal(Object.hasOwn(report, 'reason'), false); assert.equal(report.workspace.details, undefined);
          for (const field of ['id', 'record', 'git']) assert.equal(Object.hasOwn(report, field), false);
          return true;
        });
      }
      assert.ok(s.control.calls.every(args => !args.some(arg => ['api', 'auth', 'push', 'fetch', 'ls-remote'].includes(arg))));
      assert.equal(readFileSync(mode === 'direct-commit'
        ? join(s.target + '.gidd', String(issue), 'state.json')
        : join(s.target + '.gidd', 'storage.json'), 'utf8'), record);
      s.native(['checkout', '--detach', 'HEAD'], path);
      await assert.rejects(s.command('status', [String(issue)]), error => {
        assert.deepEqual(error.details, { path, expected_branch: expected, actual_branch: null });
        return true;
      });
      s.native(['switch', expected], path);
      const restored = await s.command('status', [String(issue)]);
      assert.equal(restored.workspace.branch, expected); assert.equal(restored.workspace.state, 'assigned');
    } finally { await s.dispose(); }
  });
}

test('changed configuration, mismatched URLs, branch changes and network failures retain resources', async (t) => {
  const s = installation(t);
  try {
    const a = await s.command('workspace', ['8']);
    s.native(['remote', 'add', 'other', 'https://github.com/test/other.git']);
    s.native(['config', 'branch.main.pushRemote', 'other']);
    await assert.rejects(s.command('push', ['8']), /delivery_remote_changed/);
    s.native(['config', '--unset', 'branch.main.pushRemote']);
    s.native(['config', 'remote.origin.pushurl', 'https://github.com/test/other.git']);
    await assert.rejects(s.command('push', ['8']), /delivery_remote_changed/);
    s.native(['config', '--unset', 'remote.origin.pushurl']);
    s.native(['checkout', '-b', 'renamed'], a.workspace.path);
    await assert.rejects(s.command('push', ['8']), /workspace_branch_changed/);
    s.native(['checkout', 'gidd-issue-8'], a.workspace.path);
    s.control.intercept = async (exe, args) => args.includes('push') ? { ok: false, reason: 'command_failed' } : undefined;
    await assert.rejects(s.command('push', ['8']), /delivery_remote_failed/);
    s.control.intercept = null; s.control.fetchFailure = true;
    await assert.rejects(s.command('cleanup', ['8']), /delivery_remote_failed/);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    assert.equal((await s.show(a.workspace.path)).worktree.state, 'assigned');
    assert.equal(existsSync(join(s.target + '.gidd', '.lock')), false);
  } finally { await s.dispose(); }
});

test('PR proof failures and partial cleanup remain inspectable and retry through delivery commands', async (t) => {
  const s = installation(t);
  try {
    const { workspace } = await s.delivery(), pr = s.control.pr;
    s.control.pr = null;
    await assert.rejects(s.command('target-sync', ['7']), /worktree_pr_not_found/);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    s.control.pr = pr;
    await s.command('target-sync', ['7']);
    s.control.intercept = async (exe, args) => args.includes('push') && args.some(arg => arg.startsWith(':refs/heads/'))
      ? { ok: false, reason: 'command_failed' } : undefined;
    const failed = await s.command('cleanup', ['7']);
    assert.equal(failed.status, 'error'); assert.equal(failed.retry, '7.cleanup');
    assert.deepEqual(failed.details, { code: 'worktree_remote_failed' });
    assert.equal(failed.workspace.details, undefined); assert.equal(Object.hasOwn(failed, 'reason'), false);
    assert.equal(failed.workspace.detached, true); assert.equal(failed.local_branch_deleted, false);
    assert.equal(failed.workspace.state, 'needs_check');
    const continued = await s.command('status', ['7']);
    assert.equal(continued.workspace.state, 'needs_check');
    assert.deepEqual(continued.workspace.details, { code: 'worktree_cleanup_pending' });
    assert.equal(continued.details, undefined); assert.equal(Object.hasOwn(continued, 'reason'), false);
    assert.equal(continued.workspace.head, pr.head.sha);
    assert.equal(Object.hasOwn(continued.workspace, 'checked_out_branch'), false);
    assert.equal(continued.workspace.branch, 'gidd-issue-7');
    assert.equal(continued.workspace.detached, true);
    s.native(['checkout', '--detach', s.initial], workspace.workspace.path);
    await assert.rejects(s.command('status', ['7']), error => {
      assert.equal(error.message, 'workspace_branch_changed');
      assert.deepEqual(error.details, { path: workspace.workspace.path, expected_branch: 'gidd-issue-7', actual_branch: null });
      return true;
    });
    s.native(['checkout', '--detach', pr.head.sha], workspace.workspace.path);
    await assert.rejects(s.command('push', ['7']), /task_cleanup_pending/);
    // Ref deletion can succeed before branch configuration cleanup fails.
    // The original name must still locate the persisted cleanup record.
    s.native(['config', 'branch.gidd-issue-7.description', 'cleanup fixture']);
    s.control.intercept = async (exe, args) => args.includes('--remove-section')
      ? { ok: false, reason: 'command_failed' } : undefined;
    const deleted = await s.command('cleanup', ['7']);
    assert.equal(deleted.status, 'error'); assert.equal(deleted.local_branch_deleted, true);
    assert.equal(deleted.retry, '7.cleanup');
    assert.equal(s.native(['branch', '--list', 'gidd-issue-7']), '');
    const detached = await s.command('status', ['7']);
    assert.equal(detached.workspace.branch, 'gidd-issue-7');
    assert.equal(Object.hasOwn(detached.workspace, 'checked_out_branch'), false);
    assert.equal(detached.workspace.head, pr.head.sha);
    assert.equal((await s.command('status', ['7'], workspace.workspace.path)).workspace.state, 'needs_check');
    s.control.intercept = null;
    const completed = await s.command('cleanup', ['7']);
    assert.equal(completed.status, 'success'); assert.equal(completed.workspace.state, 'available');
    assert.equal(completed.workspace.details, undefined); assert.equal(completed.details, undefined);
  } finally { await s.dispose(); }
});

test('PR merge requires a unique current head, confirms delivery and can be safely retried', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['7']);
    s.control.issues.delete(7);
    const head = s.change(workspace.workspace.path);
    await s.command('push', ['7']);
    const pr = { number: 42, state: 'open', draft: false, merged: false,
      head: { ref: 'gidd-issue-7', sha: head, repo: { full_name: 'test/repo' } },
      base: { ref: 'main', repo: { full_name: 'test/repo' } } };
    s.control.pr = { ...pr, base: { ...pr.base, ref: 'other-target' } };
    await assert.rejects(s.command('merge', ['7']), /worktree_pr_not_found/);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    s.control.pr = { ...pr, head: { ...pr.head, sha: s.initial } };
    await assert.rejects(s.command('merge', ['7']), /pr_head_changed/);
    s.control.pr = [pr, { ...pr, number: 43 }];
    await assert.rejects(s.command('merge', ['7']), /worktree_pr_ambiguous/);
    s.control.pr = { ...pr, draft: true };
    await assert.rejects(s.command('merge', ['7']), /pr_draft/);
    assert.equal(s.control.calls.some(args => args.includes('PUT')), false);
    s.control.pr = pr;
    s.control.mergeResponse = { merged: false };
    await assert.rejects(s.command('merge', ['7']), /pr_merge_pending/);
    delete s.control.mergeResponse;
    const merged = await s.command('merge', ['7', '--squash', '--message', 'feat: ship the Issue']);
    assert.equal(merged.merged, true); assert.equal(merged.pr, 42); assert.equal(merged.already_merged, false);
    const call = s.control.calls.findLast(args => args.includes('PUT'));
    assert.ok(call.includes('sha=' + head)); assert.ok(call.includes('merge_method=squash'));
    assert.ok(call.includes('commit_title=feat: ship the Issue'));
    // Merging alone leaves synchronization and cleanup to their own stages.
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'assigned');
    const mutations = s.control.calls.filter(args => args.includes('PUT')).length;
    assert.equal((await s.command('merge', ['7'])).already_merged, true);
    assert.equal(s.control.calls.filter(args => args.includes('PUT')).length, mutations);
    await s.command('target-sync', ['7']);
    assert.equal((await s.command('cleanup', ['7'])).local_branch_deleted, true);
  } finally { await s.dispose(); }
});

test('direct-commit closure requires published target commits and preserves the context and user files', async (t) => {
  const s = installation(t);
  try {
    await s.command('workspace', ['1']); s.change(s.target);
    write(join(s.target, 'keep.tmp'), 'user file');
    const recordPath = join(s.target + '.gidd', '1/state.json');
    const original = readFileSync(recordPath, 'utf8');
    await assert.rejects(s.command('close-issue', ['1']), error => {
      assert.equal(error.message, 'delivery_target_not_pushed');
      assert.equal(error.workspace.retry, '1.close-issue');
      const failed = workspaceReport({ schema: 'gidd.task-command/v1', status: 'error', reason: error.message, ...error.workspace });
      assert.deepEqual(failed.details, { code: 'delivery_target_not_pushed' });
      assert.equal(Object.hasOwn(failed, 'reason'), false); assert.equal(failed.workspace.details, undefined);
      assert.equal(failed.workspace.state, 'assigned');
      assert.equal(failed.workspace.delivery_mode, 'direct-commit');
      assert.equal(Object.hasOwn(failed, 'delivery_mode'), false);
      return true;
    });
    assert.equal(s.control.issues.get(1).state, 'open');
    await s.command('push', ['1']); write(join(s.target, 'keep.tmp'), 'user file');
    // Existing delivery settings remain authoritative after a policy change.
    s.select('pr-merge');
    const result = await s.command('close-issue', ['1']);
    assert.equal(result.status, 'success'); assert.equal(result.issue_closed, true);
    assert.equal(result.workspace.state, 'assigned');
    assert.equal(result.workspace.delivery_mode, 'direct-commit'); assert.equal(result.already_closed, false);
    assert.equal(result.pr, undefined);
    assert.equal((await s.command('close-issue', ['1'])).already_closed, true);
    assert.equal(s.control.calls.filter(args => args.includes('PATCH')).length, 1);
    assert.equal(s.control.calls.some(args => args.at(-1) === 'graphql'), false);
    assert.equal(readFileSync(recordPath, 'utf8'), original);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    assert.equal((await s.command('status', ['1'])).workspace.state, 'assigned');
  } finally { await s.dispose(); }
});

test('direct-merge closure requires the working branch tip to be merged and pushed, without releasing it', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']);
    const head = s.change(workspace.workspace.path);
    await assert.rejects(s.command('close-issue', ['2']), /worktree_not_delivered/);
    await s.command('merge', ['2']);
    await assert.rejects(s.command('close-issue', ['2']), /delivery_target_not_pushed/);
    assert.equal(s.control.calls.some(args => args.includes('PATCH')), false);
    await s.command('push', ['2']);
    assert.equal((await s.command('close-issue', ['2'], workspace.workspace.path)).issue_closed, true);
    assert.equal(s.native(['rev-parse', 'gidd-issue-2']), head);
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'assigned');
    assert.equal(s.control.issues.get(2).state, 'closed');
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
  } finally { await s.dispose(); }
});

test('PR closure verifies unique delivery and target synchronization before creating an association', async (t) => {
  const s = installation(t);
  try {
    const { workspace, merge } = await s.delivery();
    s.control.issues.set(7, { number: 7, node_id: 'I_7', state: 'open', html_url: 'https://github.com/test/repo/issues/7' });
    const pr = s.control.pr;
    s.control.pr = { ...pr, state: 'open', merged: false };
    await assert.rejects(s.command('close-issue', ['7']), /worktree_pr_not_found/);
    s.control.pr = { ...pr, head: { ...pr.head, sha: s.initial } };
    await assert.rejects(s.command('close-issue', ['7']), /worktree_pr_not_found/);
    s.control.pr = [pr, { ...pr, number: 43 }];
    await assert.rejects(s.command('close-issue', ['7']), /worktree_pr_ambiguous/);
    s.control.pr = pr;
    s.native(['update-ref', 'refs/heads/main', s.initial, merge], s.bare);
    await assert.rejects(s.command('close-issue', ['7']), /delivery_remote_not_delivered/);
    s.native(['update-ref', 'refs/heads/main', merge, s.initial], s.bare);
    await assert.rejects(s.command('close-issue', ['7']), /delivery_target_not_synced/);
    assert.equal(s.control.calls.some(args => args.at(-1) === 'graphql' || args.includes('PATCH')), false);
    await s.command('target-sync', ['7']);
    const result = await s.command('close-issue', ['7'], workspace.workspace.path);
    assert.equal(result.pr, 42); assert.equal(result.pr_linked, true); assert.equal(result.issue_closed, true);
    assert.equal(result.already_linked, false);
    const repeated = await s.command('close-issue', ['7']);
    assert.equal(repeated.already_linked, true); assert.equal(repeated.already_closed, true);
    assert.equal(s.control.calls.filter(args => args.some(arg => arg.includes('addCloseIssueReferences'))).length, 1);
    assert.equal(s.control.calls.filter(args => args.includes('PATCH')).length, 1);
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'assigned');
    assert.equal(s.native(['rev-parse', 'gidd-issue-7'], s.bare), pr.head.sha);
  } finally { await s.dispose(); }
});

test('PR closure retains confirmed association progress when closing fails, then retries safely', async (t) => {
  const s = installation(t);
  try {
    const { workspace } = await s.delivery();
    s.control.issues.set(7, { number: 7, node_id: 'I_7', state: 'open', html_url: 'https://github.com/test/repo/issues/7' });
    await s.command('target-sync', ['7']);
    s.control.intercept = async (exe, args) => args.includes('PATCH') ? { ok: false, reason: 'command_failed' } : undefined;
    await assert.rejects(s.command('close-issue', ['7']), error => {
      assert.equal(error.workspace.pr_linked, true); assert.equal(error.workspace.pr, 42);
      assert.equal(error.workspace.issue_closed, undefined);
      assert.equal(error.workspace.retry, '7.close-issue'); return true;
    });
    assert.equal(s.control.issues.get(7).state, 'open');
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'assigned');
    s.control.intercept = null;
    assert.equal((await s.command('close-issue', ['7'])).already_linked, true);
    assert.equal(s.control.calls.filter(args => args.some(arg => arg.includes('addCloseIssueReferences'))).length, 1);
    assert.equal(existsSync(join(s.target + '.gidd', '.lock')), false);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
  } finally { await s.dispose(); }
});

test('closure detects a concurrent development change before making GitHub mutations', async (t) => {
  const s = installation(t);
  try {
    const { workspace } = await s.delivery();
    s.control.issues.set(7, { number: 7, node_id: 'I_7', state: 'open', html_url: 'https://github.com/test/repo/issues/7' });
    await s.command('target-sync', ['7']);
    s.control.intercept = async (exe, args) => {
      if (args.at(-1)?.endsWith('/issues/7')) {
        s.control.intercept = null; s.change(workspace.workspace.path, 'concurrent development');
      }
    };
    await assert.rejects(s.command('close-issue', ['7']), /delivery_target_changed/);
    assert.equal(s.control.issues.get(7).state, 'open');
    assert.equal(s.control.calls.some(args => args.includes('PATCH') || args.some(arg => arg.includes('addCloseIssueReferences'))), false);
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'assigned');
  } finally { await s.dispose(); }
});

test('PR merge retains rebase and completes synchronization and cleanup', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['7']), source = s.change(workspace.workspace.path);
    await s.command('push', ['7']);
    s.control.pr = { number: 42, state: 'open', draft: false, merged: false,
      head: { ref: 'gidd-issue-7', sha: source, repo: { full_name: 'test/repo' } },
      base: { ref: 'main', repo: { full_name: 'test/repo' } } };
    const merged = await s.command('merge', ['7', '--rebase']);
    assert.equal(merged.merged, true); assert.equal(merged.pr, 42);
    const call = s.control.calls.findLast(args => args.includes('PUT'));
    assert.ok(call.includes('merge_method=rebase')); assert.ok(call.includes('sha=' + source));
    assert.equal(call.some(arg => arg.startsWith('commit_title=')), false);
    assert.equal(s.native(['rev-parse', 'gidd-issue-7']), source);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    assert.equal((await s.show(workspace.workspace.path)).record.local_merge, undefined);
    assert.equal((await s.command('merge', ['7', '--rebase'])).already_merged, true);
    await s.command('target-sync', ['7']);
    assert.equal(s.native(['rev-parse', 'main']), source);
    assert.equal((await s.command('cleanup', ['7'])).local_branch_deleted, true);
  } finally { await s.dispose(); }
});

test('a failed task removal keeps its released workspace reserved until cleanup can retry', {
  skip: process.versions.bun ? 'Bun does not update named fs exports for unlink fault injection' : false,
}, async (t) => {
  const s = installation(t), originalUnlink = fs.unlinkSync;
  try {
    const first = await s.command('workspace', ['2']), path = first.workspace.path;
    s.change(path); await s.command('merge', ['2']); await s.command('push', ['2']);
    const state = join(s.target + '.gidd', '2/state.json');
    fs.unlinkSync = file => {
      if (String(file) === state) throw new Error('fixture_task_remove_failed');
      return originalUnlink(file);
    };
    syncBuiltinESMExports();
    await assert.rejects(s.command('cleanup', ['2']), /fixture_task_remove_failed/);
    fs.unlinkSync = originalUnlink; syncBuiltinESMExports();
    assert.equal((await s.show(path)).worktree.state, 'available');
    await assert.rejects(s.track(worktreeCommand(s.target, { action: 'remove', path }, { execute: s.execute, signal: s.signal })), /task_cleanup_pending/);
    const second = await s.command('workspace', ['8']);
    assert.notEqual(second.id, first.id);
    assert.equal((await s.show(path)).record.issue, 2);
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).workspace, first.id);
    assert.equal((await s.command('cleanup', ['2'])).workspace.state, 'available');
    assert.equal(existsSync(state), false);
    assert.equal((await s.command('status', ['8'])).workspace.path, second.workspace.path);
  } finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); await s.dispose(); }
});
