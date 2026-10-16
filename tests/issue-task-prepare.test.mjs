import { test } from 'node:test';
import { unlinkSync } from 'node:fs';
import { readTasks } from '../.agents/skills/gidd/scripts.js/shared/task-records.mjs';
import { readPolicyHistory } from '../.agents/skills/gidd/scripts.js/shared/policy-history.mjs';
import { assert, existsSync, join, readFileSync, write } from './support/helpers.mjs';
import { installation, noPreparedResources } from './support/issue-task.mjs';

test('workspace registration retains its plan after preparation fails and repeats offline', async (t) => {
  const s = installation(t);
  try {
    s.control.fetchFailure = true;
    await assert.rejects(s.invoke('workspace', ['1', '--policy', '01/00']), /delivery_remote_failed/);
    const registered = await s.invoke('status', ['1']);
    assert.equal(registered.workspace.state, 'needs_check');
    assert.equal(registered.issue.number, 1);
    assert.equal(registered.workspace.delivery_mode, 'direct-merge');
    assert.equal(registered.next, '1 --policy 01.direct-merge/00.auto');
    await noPreparedResources(s, s.initial);
    s.control.fetchFailure = false;
    s.select('direct-commit');
    const prepared = await s.invoke('workspace', ['1']);
    assert.equal(prepared.workspace.branch, 'gidd-issue-1');
    const state = readFileSync(join(s.target + '.gidd', '1/state.json'), 'utf8');
    const history = readFileSync(join(s.target + '.gidd', 'policy-history.jsonl'), 'utf8');
    s.control.calls.length = 0;
    const repeated = await s.invoke('workspace', ['1']);
    assert.equal(repeated.workspace.path, prepared.workspace.path);
    assert.ok(s.control.calls.every(args => !args.some(arg => ['api', 'auth', 'push', 'fetch', 'ls-remote'].includes(arg))));
    assert.equal(readFileSync(join(s.target + '.gidd', '1/state.json'), 'utf8'), state);
    assert.equal(readFileSync(join(s.target + '.gidd', 'policy-history.jsonl'), 'utf8'), history);
  } finally { await s.dispose(); }
});

test('first registration failures retain the Issue policy in the retry context and release the lock', async (t) => {
  const s = installation(t);
  try {
    const data = s.target + '.gidd';
    unlinkSync(join(data, 'storage.json'));
    await assert.rejects(s.invoke('workspace', ['1', '--policy', '00/00']), error => {
      assert.equal(error.message, 'data_needs_attention');
      assert.equal(error.workspace.issue, 1);
      assert.equal(error.workspace.policy.selector, '00.direct-commit/00.auto');
      assert.equal(error.workspace.retry, '1 --policy 00.direct-commit/00.auto');
      return true;
    });
    assert.equal(existsSync(join(data, '.lock')), false);
    assert.equal(existsSync(join(data, '1/state.json')), false);
    assert.ok(s.control.calls.every(args => !args.some(arg => ['auth', 'api', 'fetch', 'push'].includes(arg))));
  } finally { await s.dispose(); }
});

test('target update interruption resumes its saved commit even after the remote advances again', async (t) => {
  const s = installation(t);
  try {
    const incoming = s.advanceRemote();
    s.control.intercept = (exe, args) => {
      if (!args.includes('--ff-only')) return;
      s.native(args.slice(args.indexOf('-C') + 2));
      return { ok: false, reason: 'command_failed' };
    };
    await assert.rejects(s.command('workspace', ['2']), /delivery_remote_failed/);
    const saved = JSON.parse(readFileSync(join(s.target + '.gidd', '2/state.json'), 'utf8'));
    assert.equal(saved.preparation.start_commit, incoming);
    assert.equal(s.native(['rev-parse', 'main']), incoming);
    s.control.intercept = null;
    s.advanceRemote();
    const resumed = await s.command('workspace', ['2']);
    assert.equal(resumed.workspace.start_commit, incoming);
    assert.equal(s.native(['rev-parse', 'main']), incoming);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    assert.equal(JSON.parse(readFileSync(join(s.target + '.gidd', '2/state.json'), 'utf8')).preparation, undefined);
  } finally { await s.dispose(); }
});

test('failed allocation cleanup retains the Issue plan and permits preparation again', async (t) => {
  const s = installation(t);
  try {
    s.control.intercept = (exe, args) => args.includes('worktree') && args.includes('add')
      ? { ok: false, reason: 'command_failed' } : undefined;
    await assert.rejects(s.command('workspace', ['2']), /worktree_git_failed/);
    const state = join(s.target + '.gidd', '2/state.json');
    const planned = JSON.parse(readFileSync(state, 'utf8'));
    assert.equal((await s.command('status', ['2'])).workspace.state, 'needs_check');
    const aborted = await s.command('cleanup', ['2']);
    assert.equal(aborted.preparation_aborted, true);
    assert.equal(aborted.registration_removed, false);
    assert.ok(existsSync(state));
    assert.equal(s.native(['branch', '--list', 'gidd-issue-2']), '');
    s.control.intercept = null;
    const resumed = await s.command('workspace', ['2']);
    assert.equal(resumed.workspace.state, 'assigned');
    assert.deepEqual(resumed.policy, planned.policy);
    assert.equal(readPolicyHistory({ path: s.target + '.gidd' }).length, 1);
  } finally { await s.dispose(); }
});

test('symbolic recovery refs cannot delete the target branch during cleanup', async (t) => {
  const s = installation(t);
  try {
    s.advanceRemote(); s.control.fetchFailure = true;
    await assert.rejects(s.command('workspace', ['2']), /delivery_remote_failed/);
    const state = join(s.target + '.gidd', '2/state.json'), saved = JSON.parse(readFileSync(state, 'utf8'));
    s.native(['update-ref', '-d', saved.preparation.reference]);
    s.native(['symbolic-ref', saved.preparation.reference, 'refs/heads/main']);
    await assert.rejects(s.command('cleanup', ['2']), /delivery_target_changed/);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), saved);
  } finally { await s.dispose(); }
});

test('cleanup resolves Task housekeeping after allocation was committed', async (t) => {
  const s = installation(t);
  try {
    let checks = 0;
    s.control.intercept = (exe, args) => {
      if (args.includes('symbolic-ref') && args.at(-1).startsWith('refs/gidd/delivery/') && ++checks === 2)
        return { ok: false, reason: 'process_timeout' };
    };
    await assert.rejects(s.command('workspace', ['2']), /process_timeout/);
    const state = join(s.target + '.gidd', '2/state.json'), task = JSON.parse(readFileSync(state, 'utf8'));
    assert.ok(task.workspace && task.preparation);
    const registry = JSON.parse(readFileSync(join(s.target + '.gidd', 'storage.json'), 'utf8'));
    assert.equal(registry.worktrees[task.workspace].preparation, undefined);
    s.control.intercept = null;
    const cleared = await s.command('cleanup', ['2']);
    assert.equal(cleared.workspace.state, 'available');
    assert.equal(existsSync(state), false);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
  } finally { await s.dispose(); }
});

test('PR preparation checks remote branches; parallel workspaces never share a guessed current task', async (t) => {
  const s = installation(t);
  try {
    s.native(['branch', 'absent']);
    s.native(['checkout', 'absent']);
    await assert.rejects(s.command('workspace', ['4']), /delivery_remote_target_missing/);
    s.native(['checkout', 'main']);
    // Preparation failure retains the plan; changing checkout cannot retarget it.
    const pending = readTasks({ path: s.target + '.gidd' }).find(task => task.issue === 4);
    assert.equal(pending.target_branch, 'absent');
    await s.invoke('cleanup', ['4']);
    s.native(['push', s.bare, 'main:refs/heads/gidd-issue-6']);
    await assert.rejects(s.command('workspace', ['6']), /delivery_remote_branch_exists/);
    const a = await s.command('workspace', ['4']);
    const b = await s.command('workspace', ['5']);
    assert.notEqual(a.workspace.path, b.workspace.path);
    s.change(a.workspace.path, 'one'); s.change(b.workspace.path, 'two');
    assert.equal((await s.command('push', ['4'], a.workspace.path)).pushed_branch, 'gidd-issue-4');
    assert.equal(s.native(['branch', '--list', 'gidd-issue-5'], s.bare), '');
    assert.equal((await s.command('push', ['5'])).pushed_branch, 'gidd-issue-5');
    assert.equal(s.native(['rev-parse', 'main'], s.bare), s.initial);
    await assert.rejects(s.command('push', ['999']), /task_required/);
  } finally { await s.dispose(); }
});

for (const [issue, mode] of [[1, 'direct-commit'], [2, 'direct-merge'], [7, 'pr-merge']]) {
  test(`${mode} preparation fast-forwards only the target and records its updated starting point`, async (t) => {
    const s = installation(t);
    try {
      const incoming = s.advanceRemote();
      s.native(['branch', 'keep-branch']); s.native(['tag', 'keep-tag']);
      s.native(['tag', 'remote-tag', incoming], s.bare);
      s.native(['update-ref', 'refs/remotes/origin/main', s.initial]);
      s.native(['update-ref', 'refs/remotes/origin/stale', s.initial]);
      s.native(['config', 'fetch.prune', 'true']); s.native(['config', 'fetch.pruneTags', 'true']);
      s.native(['config', 'branch.main.mergeOptions', '--squash --autostash --overwrite-ignore']);
      s.control.calls.length = 0;
      const prepared = await s.command('workspace', [String(issue)]);
      assert.equal(prepared.workspace.delivery_mode, mode);
      assert.equal(prepared.workspace.start_commit, incoming);
      assert.equal(s.native(['rev-parse', 'HEAD'], prepared.workspace.path), incoming);
      assert.equal(s.native(['rev-parse', 'main']), incoming);
      assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'remote update\n');
      assert.equal(s.native(['rev-parse', 'keep-branch']), s.initial);
      assert.equal(s.native(['tag', '--list']), 'keep-tag');
      assert.equal(s.native(['rev-parse', 'refs/remotes/origin/main']), s.initial);
      assert.equal(s.native(['rev-parse', 'refs/remotes/origin/stale']), s.initial);
      assert.equal(s.native(['rev-parse', 'main'], s.bare), incoming);
      assert.equal(s.control.calls.some(args => args.includes('push')), false);
      assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    } finally { await s.dispose(); }
  });

  for (const state of ['ahead', 'diverged']) test(`${mode} preparation stops when the local target is ${state}`, async (t) => {
    const s = installation(t);
    try {
      const incoming = state === 'diverged' ? s.advanceRemote() : s.initial;
      const local = s.change(s.target, 'unpublished work');
      await assert.rejects(s.command('workspace', [String(issue)]), new RegExp('delivery_target_' + state));
      await noPreparedResources(s, local);
      assert.equal(s.native(['rev-parse', 'main'], s.bare), incoming);
      assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'unpublished work\n');
      assert.equal(s.control.calls.some(args => args.includes('push')), false);
    } finally { await s.dispose(); }
  });

  test(`${mode} preparation handles an absent remote target without publishing it`, async (t) => {
    const s = installation(t);
    try {
      s.native(['update-ref', '-d', 'refs/heads/main'], s.bare);
      if (mode === 'pr-merge') {
        await assert.rejects(s.command('workspace', [String(issue)]), /delivery_remote_target_missing/);
        await noPreparedResources(s, s.initial);
      } else {
        const prepared = await s.command('workspace', [String(issue)]);
        assert.equal(prepared.workspace.start_commit, s.initial);
      }
      assert.equal(s.native(['for-each-ref', '--format=%(refname)'], s.bare), '');
      assert.equal(s.control.calls.some(args => args.includes('fetch') || args.includes('push')), false);
    } finally { await s.dispose(); }
  });

  test(`${mode} resume leaves an outdated target and the original starting point unchanged offline`, async (t) => {
    const s = installation(t);
    try {
      const prepared = await s.command('workspace', [String(issue)]);
      s.advanceRemote();
      const recordPath = mode === 'direct-commit'
        ? join(s.target + '.gidd', String(issue), 'state.json')
        : join(s.target + '.gidd', 'storage.json');
      const record = readFileSync(recordPath, 'utf8');
      s.control.intercept = (exe, args) => {
        assert.notEqual(exe, process.execPath);
        assert.ok(!args.some(arg => ['ls-remote', 'fetch', 'push'].includes(arg)));
      };
      const resumed = await s.command('status', [String(issue)]);
      assert.equal(resumed.workspace.start_commit, s.initial);
      assert.equal(resumed.workspace.head, s.initial);
      assert.equal(s.native(['rev-parse', 'main']), s.initial);
      assert.equal(readFileSync(recordPath, 'utf8'), record);
    } finally { await s.dispose(); }
  });
}

test('preparation preserves target edits, hidden index changes and unfinished Git operations', async (t) => {
  const s = installation(t);
  try {
    s.advanceRemote();
    write(join(s.target, 'tracked.txt'), 'keep me\n');
    await assert.rejects(s.command('workspace', ['2']), /delivery_target_dirty/);
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'keep me\n');
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      s.native(['update-index', '--' + flag, 'tracked.txt']);
      await assert.rejects(s.command('workspace', ['2']), /delivery_target_index_flags/);
      s.native(['update-index', '--no-' + flag, 'tracked.txt']);
    }
    s.native(['restore', 'tracked.txt']);
    write(join(s.target, 'keep.tmp'), 'user file');
    await assert.rejects(s.command('workspace', ['2']), /delivery_target_dirty/);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
    unlinkSync(join(s.target, 'keep.tmp'));
    for (const marker of ['MERGE_HEAD', 'index.lock']) {
      write(join(s.target, '.git', marker), s.initial + '\n');
      await assert.rejects(s.command('workspace', ['2']), /delivery_target_busy/);
      assert.equal(readFileSync(join(s.target, '.git', marker), 'utf8'), s.initial + '\n');
      unlinkSync(join(s.target, '.git', marker));
    }
    await noPreparedResources(s, s.initial);
    assert.equal(s.native(['stash', 'list']), '');
    // No checkout update is needed when tips match, so existing edits survive.
    await s.command('cleanup', ['2']);
    s.native(['update-ref', 'refs/heads/main', s.initial], s.bare);
    write(join(s.target, 'tracked.txt'), 'keep me\n');
    await s.command('workspace', ['2']);
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'keep me\n');
  } finally { await s.dispose(); }
});

test('preparation rejects fetch failures and concurrent target changes before allocating resources', async (t) => {
  for (const state of ['fetch-failure', 'branch-switch', 'allocation-race']) {
    const s = installation(t);
    try {
      const incoming = s.advanceRemote();
      let retained = s.initial;
      if (state === 'fetch-failure') s.control.fetchFailure = true;
      else s.control.intercept = (exe, args) => {
        if (state === 'branch-switch' && args.includes('fetch')) {
          s.control.intercept = null; s.native(['checkout', '-b', 'changed']);
        } else if (state === 'allocation-race' && args.includes('core.hooksPath=NUL') &&
            args.includes('rev-parse') && args.at(-1) === 'refs/heads/main^{commit}') {
          s.control.intercept = null; retained = s.change(s.target, 'concurrent update');
        }
      };
      await assert.rejects(s.command('workspace', ['2']), new RegExp(state === 'fetch-failure'
        ? 'delivery_remote_failed' : state === 'branch-switch' ? 'delivery_target_branch_mismatch' : 'delivery_target_changed'));
      await noPreparedResources(s, retained);
      assert.equal(s.native(['rev-parse', 'main'], s.bare), incoming);
    } finally { await s.dispose(); }
  }
});

test('preparation rejects occupied resources and closed Issues before advancing the target', async (t) => {
  const s = installation(t);
  try {
    s.advanceRemote();
    s.native(['branch', 'gidd-issue-2']);
    await assert.rejects(s.command('workspace', ['2']), /worktree_branch_exists/);
    s.native(['push', s.bare, 'main:refs/heads/gidd-issue-7']);
    await assert.rejects(s.command('workspace', ['7']), /delivery_remote_branch_exists/);
    s.control.issues.get(1).state = 'closed';
    await assert.rejects(s.command('workspace', ['1']), /issue_closed/);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    s.control.issues.get(1).state = 'open';
    await s.command('workspace', ['1']);
    const target = s.native(['rev-parse', 'main']);
    s.advanceRemote(); s.control.calls.length = 0;
    assert.equal((await s.command('workspace', ['1'])).issue.number, 1);
    await assert.rejects(s.command('workspace', ['10']), /delivery_context_exists/);
    assert.equal(s.native(['rev-parse', 'main']), target);
    assert.equal(s.control.calls.some(args => args.includes('fetch') || args.includes('ls-remote')), false);
  } finally { await s.dispose(); }
});
