import { test } from 'node:test';
import { runCommand } from '../.agents/skills/gidd/scripts.js/shared/process.mjs';
import { validLocalMerge } from '../.agents/skills/gidd/scripts.js/shared/local-delivery.mjs';
import { assert, existsSync, join, readFileSync, write } from './support/helpers.mjs';
import { installation } from './support/issue-task.mjs';

test('local merge preserves dirty targets and conflicts, and uses the requested message for a merge commit', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']);
    const source = s.change(workspace.workspace.path);
    write(join(s.target, 'tracked.txt'), 'unsaved work\n');
    await assert.rejects(s.command('merge', ['2']), /delivery_target_dirty/);
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'unsaved work\n');
    write(join(s.target, 'tracked.txt'), 'base\n');
    write(join(s.target, 'target-only.txt'), 'target\n');
    s.native(['add', 'target-only.txt']); s.native(['commit', '-m', 'target work']);
    const previous = s.native(['rev-parse', 'HEAD']);
    const merged = await s.command('merge', ['2', '--message', 'feat: combine the verified changes']);
    assert.equal(merged.merged, true);
    assert.equal(s.native(['log', '-1', '--format=%s']), 'feat: combine the verified changes');
    assert.equal(s.native(['log', '-1', '--format=%P']), `${previous} ${source}`);
    assert.equal((await s.command('merge', ['2'])).already_merged, true);
    s.change(workspace.workspace.path, 'source conflict'); s.change(s.target, 'target conflict');
    await assert.rejects(s.command('merge', ['2']), /delivery_merge_failed/);
    assert.equal(existsSync(join(s.target, '.git/MERGE_HEAD')), true);
    assert.ok(s.native(['ls-files', '--unmerged']).includes('tracked.txt'));
    await assert.rejects(s.command('merge', ['2']), /delivery_target_busy/);
  } finally { await s.dispose(); }
});

test('local squash records the source and result, supports later target commits, and completes delivery', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']);
    s.change(workspace.workspace.path, 'first change');
    const source = s.change(workspace.workspace.path, 'final change');
    write(join(s.target, 'target-only.txt'), 'target work\n');
    s.native(['add', 'target-only.txt']); s.native(['commit', '-m', 'target work']);
    const previous = s.native(['rev-parse', 'HEAD']);
    const merged = await s.command('merge', ['2', '--squash', '--message', 'feat: deliver the task']);
    const commit = merged.merge_commit;
    assert.equal(s.native(['log', '-1', '--format=%P']), previous);
    assert.equal(s.native(['log', '-1', '--format=%s']), 'feat: deliver the task');
    assert.notEqual(commit, source);
    assert.deepEqual((await s.show(workspace.workspace.path)).record.local_merge, { head: source, commit });
    assert.equal((await s.command('merge', ['2', '--squash'])).already_merged, true);
    assert.equal((await s.command('merge', ['2'])).merge_commit, commit);
    write(join(s.target, 'later.txt'), 'later work\n');
    s.native(['add', 'later.txt']); s.native(['commit', '-m', 'later target work']);
    await s.command('push', ['2']);
    assert.equal(s.native(['rev-parse', 'main'], s.bare), s.native(['rev-parse', 'HEAD']));
    assert.equal((await s.command('close-issue', ['2'])).issue_closed, true);
    const cleaned = await s.command('cleanup', ['2']);
    assert.equal(cleaned.local_branch_deleted, true);
    const reused = await s.command('workspace', ['8']);
    assert.equal(reused.workspace.path, workspace.workspace.path);
    assert.equal((await s.show(reused.workspace.path)).record.local_merge, undefined);
  } finally { await s.dispose(); }
});

test('local merge records accept only completed hashes or a complete recovery plan', () => {
  const head = 'a'.repeat(40), commit = 'b'.repeat(40), before = 'c'.repeat(40), tree = 'd'.repeat(40);
  assert.equal(validLocalMerge({ head, commit }), true);
  assert.equal(validLocalMerge({ head, before, tree, message: 'title' }), true);
  for (const value of [true, {}, { head, commit: true }, { head, commit, before },
    { head, before, tree }, { head, before, tree, message: 'title\nbody' },
    { head, before, upstream: before, rebase: true }, { head, before, upstream: head, rebase: true, result: commit },
    { head, before, rebase: true }, { head, before, upstream: true, rebase: true },
    { head, before, rebase: false }, { head, before, upstream: before, rebase: true, result: true },
    { head, before, rebase: true, path: 'untrusted' }])
    assert.equal(validLocalMerge(value), false);
});

test('local squash preserves additional source work and refuses a reset target', async (t) => {
  for (const change of ['source', 'target']) {
    const s = installation(t);
    try {
      const workspace = await s.command('workspace', ['2']);
      const source = s.change(workspace.workspace.path);
      await s.command('merge', ['2', '--squash']);
      await s.command('push', ['2']);
      if (change === 'source') s.change(workspace.workspace.path, 'additional work');
      else s.native(['reset', '--hard', s.initial]);
      for (const action of ['push', 'close-issue', 'cleanup'])
        await assert.rejects(s.command(action, ['2']), /worktree_not_delivered/);
      assert.notEqual(s.native(['branch', '--list', 'gidd-issue-2']), '');
      assert.equal(s.control.issues.get(2).state, 'open');
      if (change === 'target') {
        assert.equal((await s.command('merge', ['2', '--squash'])).merged, true);
        assert.equal(s.native(['rev-parse', 'gidd-issue-2']), source);
      }
    } finally { await s.dispose(); }
  }
});

test('local squash resumes interruptions before staging, before commit, and after commit without duplication', async (t) => {
  for (const interruption of ['before-stage', 'before-commit', 'after-commit']) {
    const s = installation(t);
    try {
      const workspace = await s.command('workspace', ['2']);
      const source = s.change(workspace.workspace.path);
      let stopped = false;
      s.control.intercept = async (exe, args, options) => {
        const stage = args.includes('merge') && args.includes('--squash');
        const commit = args.includes('commit');
        if (stopped || !(interruption === 'before-stage' ? stage : commit)) return;
        stopped = true;
        if (interruption === 'after-commit') assert.equal((await runCommand(exe, args, options)).ok, true);
        return { ok: false, reason: 'command_failed' };
      };
      await assert.rejects(s.command('merge', ['2', '--squash', '--message', 'squash result']), /delivery_merge_failed/);
      assert.equal(stopped, true);
      const planned = (await s.show(workspace.workspace.path)).record.local_merge;
      assert.equal(planned.head, source); assert.equal(planned.commit, undefined);
      await assert.rejects(s.command('merge', ['2', '--squash', '--message', 'different title']), /delivery_merge_changed/);
      s.control.intercept = null;
      const recovered = await s.command('merge', ['2']);
      assert.equal(recovered.already_merged, interruption === 'after-commit');
      assert.equal(s.native(['rev-list', '--count', s.initial + '..main']), '1');
      assert.equal(s.native(['log', '-1', '--format=%s']), 'squash result');
      assert.deepEqual((await s.show(workspace.workspace.path)).record.local_merge,
        { head: source, commit: recovered.merge_commit });
      await s.command('push', ['2']);
      assert.equal((await s.command('cleanup', ['2'])).local_branch_deleted, true);
    } finally { await s.dispose(); }
  }
});

test('local squash does not commit additional staged or unstaged files during recovery', async (t) => {
  for (const staged of [false, true]) {
    const s = installation(t);
    try {
      const workspace = await s.command('workspace', ['2']); s.change(workspace.workspace.path);
      s.control.intercept = async (exe, args) => args.includes('commit') ? { ok: false, reason: 'command_failed' } : undefined;
      await assert.rejects(s.command('merge', ['2', '--squash']), /delivery_merge_failed/);
      s.control.intercept = null;
      write(join(s.target, 'unrelated.txt'), 'preserve this\n');
      if (staged) s.native(['add', 'unrelated.txt']);
      await assert.rejects(s.command('merge', ['2']), /delivery_target_dirty/);
      assert.equal(readFileSync(join(s.target, 'unrelated.txt'), 'utf8'), 'preserve this\n');
      assert.equal(s.native(['rev-parse', 'main']), s.initial);
      await assert.rejects(s.command('push', ['2']), /worktree_not_delivered/);
    } finally { await s.dispose(); }
  }
});

test('local squash recovers a completed commit before later target commits and can verify without replaying merge', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']); const source = s.change(workspace.workspace.path);
    s.control.intercept = async (exe, args, options) => {
      if (!args.includes('commit')) return;
      assert.equal((await runCommand(exe, args, options)).ok, true);
      return { ok: false, reason: 'command_failed' };
    };
    await assert.rejects(s.command('merge', ['2', '--squash']), /delivery_merge_failed/);
    const commit = s.native(['rev-parse', 'main']);
    s.control.intercept = null;
    write(join(s.target, 'later.txt'), 'later work\n');
    s.native(['add', 'later.txt']); s.native(['commit', '-m', 'later work']);
    await s.command('push', ['2']);
    assert.equal((await s.command('close-issue', ['2'])).issue_closed, true);
    const recovered = await s.command('merge', ['2']);
    assert.equal(recovered.already_merged, true); assert.equal(recovered.merge_commit, commit);
    assert.deepEqual((await s.show(workspace.workspace.path)).record.local_merge, { head: source, commit });
    assert.equal((await s.command('cleanup', ['2'])).local_branch_deleted, true);
  } finally { await s.dispose(); }
});

test('local squash recovery rejects a changed result tree and preserves the working branch', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']); const source = s.change(workspace.workspace.path);
    s.control.intercept = async (exe, args, options) => {
      if (!args.includes('commit')) return;
      write(join(s.target, 'unexpected.txt'), 'another process changed the index\n');
      s.native(['add', 'unexpected.txt']);
      assert.equal((await runCommand(exe, args, options)).ok, true);
      return { ok: false, reason: 'command_failed' };
    };
    await assert.rejects(s.command('merge', ['2', '--squash']), /delivery_merge_failed/);
    s.control.intercept = null;
    for (const action of ['merge', 'push', 'close-issue'])
      await assert.rejects(s.command(action, ['2']), /delivery_merge_changed/);
    s.native(['push', s.bare, 'main']);
    await assert.rejects(s.command('cleanup', ['2']), /delivery_merge_changed/);
    assert.equal(s.native(['rev-parse', 'gidd-issue-2']), source);
    assert.equal(s.control.issues.get(2).state, 'open');
  } finally { await s.dispose(); }
});

test('local squash detects conflicts before changing the target', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']); const source = s.change(workspace.workspace.path, 'source work');
    const target = s.change(s.target, 'target work');
    await assert.rejects(s.command('merge', ['2', '--squash']), /delivery_merge_failed/);
    assert.equal(s.native(['rev-parse', 'main']), target);
    assert.equal(s.native(['rev-parse', 'gidd-issue-2']), source);
    assert.equal(s.native(['status', '--porcelain']), '');
    assert.equal((await s.show(workspace.workspace.path)).record.local_merge, undefined);
    s.native(['checkout', '-b', 'parking']);
    await assert.rejects(s.command('merge', ['2', '--squash']), /delivery_target_checkout_required/);
  } finally { await s.dispose(); }
});

test('local squash refuses to commit if the target checkout switches branches after staging', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']); s.change(workspace.workspace.path);
    s.control.intercept = async (exe, args, options) => {
      if (!args.includes('merge') || !args.includes('--squash')) return;
      const result = await runCommand(exe, args, options);
      assert.equal(result.ok, true);
      s.native(['checkout', '-b', 'parking']);
      return result;
    };
    await assert.rejects(s.command('merge', ['2', '--squash']), /delivery_target_changed/);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    assert.equal(s.native(['rev-parse', 'parking']), s.initial);
    assert.notEqual(s.native(['diff', '--cached', '--name-only']), '');
  } finally { await s.dispose(); }
});

test('local squash records delivery when the combined change is empty', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']);
    s.native(['commit', '--allow-empty', '-m', 'empty source change'], workspace.workspace.path);
    const merged = await s.command('merge', ['2', '--squash']);
    assert.equal(s.native(['log', '-1', '--format=%P']), s.initial);
    assert.equal(s.native(['rev-parse', 'main^{tree}']), s.native(['rev-parse', s.initial + '^{tree}']));
    assert.equal((await s.command('merge', ['2'])).merge_commit, merged.merge_commit);
    await s.command('push', ['2']);
    assert.equal((await s.command('cleanup', ['2'])).local_branch_deleted, true);
  } finally { await s.dispose(); }
});

test('local merge updates an unoccupied target only by fast-forward and leaves the caller branch intact', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']);
    const source = s.change(workspace.workspace.path);
    s.native(['checkout', '-b', 'parking']);
    assert.equal((await s.command('merge', ['2'])).target.head, source);
    assert.equal(s.native(['branch', '--show-current']), 'parking');
    assert.equal(s.native(['rev-parse', 'HEAD']), s.initial);
    const diverged = s.change(s.target, 'parking work');
    s.native(['update-ref', 'refs/heads/main', diverged, source]);
    await assert.rejects(s.command('merge', ['2']), /delivery_target_checkout_required/);
    assert.equal(s.native(['rev-parse', 'main']), diverged);
  } finally { await s.dispose(); }
});

test('local squash preserves content added in source merge commits', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']), path = workspace.workspace.path;
    s.native(['checkout', '-b', 'topic'], path);
    write(join(path, 'topic.txt'), 'topic work\n');
    s.native(['add', 'topic.txt'], path); s.native(['commit', '-m', 'topic work'], path);
    s.native(['checkout', 'gidd-issue-2'], path); s.change(path, 'source work');
    s.native(['merge', '--no-ff', '--no-commit', 'topic'], path);
    write(join(path, 'merge-only.txt'), 'content added while merging\n');
    s.native(['add', 'merge-only.txt'], path); s.native(['commit', '-m', 'combine source work'], path);
    const source = s.native(['rev-parse', 'HEAD'], path);
    write(join(s.target, 'target-only.txt'), 'target work\n');
    s.native(['add', 'target-only.txt']); s.native(['commit', '-m', 'target work']);
    const before = s.native(['rev-parse', 'main']);
    assert.equal(s.native(['rev-parse', 'main']), before);
    assert.equal(s.native(['rev-parse', 'gidd-issue-2']), source);
    const merged = await s.command('merge', ['2', '--squash']);
    assert.equal(readFileSync(join(s.target, 'merge-only.txt'), 'utf8'), 'content added while merging\n');
    assert.equal(readFileSync(join(s.target, 'topic.txt'), 'utf8'), 'topic work\n');
    assert.deepEqual((await s.show(path)).record.local_merge, { head: source, commit: merged.merge_commit });
  } finally { await s.dispose(); }
});

test('local squash uses its planned tree despite user merge configuration', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']), path = workspace.workspace.path;
    s.change(path, 'first source change');
    const source = s.change(path, 'second source change');
    write(join(s.target, 'target-only.txt'), 'target work\n');
    s.native(['add', 'target-only.txt']); s.native(['commit', '-m', 'target work']);
    const before = s.native(['rev-parse', 'main']);
    const tree = s.native(['merge-tree', '--write-tree', '--no-messages', before, source]);
    const mergeOptions = '--no-ff -s ours --autostash --overwrite-ignore';
    s.native(['config', 'merge.ff', 'false']);
    s.native(['config', 'branch.main.mergeOptions', mergeOptions]);
    const merged = await s.command('merge', ['2', '--squash']);
    assert.equal(merged.merged, true);
    assert.equal(s.native(['rev-parse', 'main^{tree}']), tree);
    assert.equal(s.native(['rev-list', '--count', before + '..main']), '1');
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'second source change\n');
    assert.equal(readFileSync(join(s.target, 'target-only.txt'), 'utf8'), 'target work\n');
    assert.equal(s.native(['rev-parse', 'gidd-issue-2']), source);
    assert.deepEqual((await s.show(path)).record.local_merge, { head: source, commit: merged.merge_commit });
    assert.equal(s.native(['config', '--get', 'merge.ff']), 'false');
    assert.equal(s.native(['config', '--get', 'branch.main.mergeOptions']), mergeOptions);
    await s.command('push', ['2']); await s.command('cleanup', ['2']);
  } finally { await s.dispose(); }
});

test('local merge rejects rebase before changing branches or creating a replay checkout', async (t) => {
  const s = installation(t);
  try {
    const workspace = await s.command('workspace', ['2']), source = s.change(workspace.workspace.path);
    const target = s.native(['rev-parse', 'main']);
    const worktrees = s.native(['worktree', 'list', '--porcelain']);
    s.control.calls.length = 0;
    await assert.rejects(s.command('merge', ['2', '--rebase']), /delivery_not_applicable/);
    assert.equal(s.native(['rev-parse', 'main']), target);
    assert.equal(s.native(['rev-parse', 'gidd-issue-2']), source);
    assert.equal(s.native(['worktree', 'list', '--porcelain']), worktrees);
    assert.equal(s.control.calls.some(args => args.includes('rebase') || args.includes('merge') || args.includes('add')), false);
    assert.equal((await s.show(workspace.workspace.path)).record.local_merge, undefined);
    await s.command('merge', ['2']);
    await assert.rejects(s.command('merge', ['2', '--rebase']), /delivery_not_applicable/);
    assert.equal(s.native(['rev-parse', 'main']), source);
  } finally { await s.dispose(); }
});
