import { test } from 'node:test';
import { realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { relative } from 'node:path';
import { parseWorktreeArguments, worktreeCommand, readRecords } from '../.agents/skills/gidd/scripts.js/commands/worktree/index.mjs';
import { runCommand } from '../.agents/skills/gidd/scripts.js/shared/process.mjs';
import { workspaceReport } from '../.agents/skills/gidd/scripts.js/shared/workspace-report.mjs';
import { acquireStorageLock } from '../.agents/skills/gidd/scripts.js/shared/managed-storage.mjs';
import { saveTask } from '../.agents/skills/gidd/scripts.js/shared/task-records.mjs';
import { flowSnapshot } from '../.agents/skills/gidd/scripts.js/shared/flow-definition.mjs';
import { readFlow } from '../.agents/skills/gidd/scripts.js/shared/flows.mjs';
import { adapter, assert, bindFixture, compile, copySkill, dirname, existsSync, findGit, fixture, initializeDataFixture, join, json, mkdirSync, ok, readFileSync, run, snapshot, write, resourceText, writeResource } from './support/helpers.mjs';
import { runRepositoryCommand } from './support/repository.mjs';

const acquireOptions = (branch, base = 'main', issue = 1, mode = 'direct-merge') => ({ action: 'acquire', branch, base, issue,
  delivery: { mode, remote: { fetch: { repository: 'https://github.com/test/repo', branch: 'main' }, push: { repository: 'https://github.com/test/repo' } } } });

function installation(mode = 'direct-merge') {
  const f = fixture(), git = findGit();
  let target = join(f.root, '仓库 & spaces');
  mkdirSync(target);
  target = realpathSync.native(target);
  const native = (args, path = target) => ok(run(git, ['-C', path, ...args])).stdout.trim();
  native(['init', '-b', 'main']);
  native(['config', 'user.name', 'Test']);
  native(['config', 'user.email', 'test@example.test']);
  native(['config', 'core.autocrlf', 'false']);
  write(join(target, 'tracked.txt'), 'original\n');
  write(join(target, '.gitignore'), 'cache.bin\n');
  native(['add', '.']); native(['commit', '-m', 'initial']);
  bindFixture(f.root, { git });
  initializeDataFixture(target);
  const state = target + '.gidd';
  const readRecord = id => resourceText(state, id);
  const writeRecord = (id, text) => writeResource(state, id, text);
  const hasRecord = id => readRecord(id) !== undefined;
  let issue = 0;
  const command = async (action, args = [], dependencies) => {
    if (action === 'acquire') return worktreeCommand(target, acquireOptions(args[0], args[2] ?? 'main', ++issue, mode), dependencies);
    if (action === 'cleanup') {
      const selected = readRecords(join(state, 'storage.json'), target + '.gidd').find(record => record.branch === args[0]);
      if (!selected) throw new Error('worktree_unknown_selector');
      return worktreeCommand(target, { action, path: selected.path }, dependencies);
    }
    return worktreeCommand(target, parseWorktreeArguments('worktree.' + action, args), dependencies);
  };
  return { ...f, target, git, native, command, state, readRecord, writeRecord, hasRecord };
}

// Real local and bare repositories exercise ref deletion/leases; only GitHub
// responses and the HTTPS transport are simulated. No live credentials/network.
async function prInstallation() {
  const s = installation('pr-merge');
  try {
    const a = await s.command('acquire', ['codex/pr']);
    write(join(a.path, 'tracked.txt'), 'feature\n');
    s.native(['commit', '-am', 'feat: change'], a.path);
    const head = s.native(['rev-parse', 'HEAD'], a.path);
    // Ensure a distinct squash commit, even with identical trees/timestamps.
    s.native(['merge', '--squash', 'codex/pr']);
    s.native(['commit', '-m', 'feat: squash result']);
    const merge = s.native(['rev-parse', 'main']);
    assert.notEqual(head, merge);
    const bare = join(s.root, 'remote.git');
    s.native(['init', '--bare', bare]);
    s.native(['push', bare, 'main', 'codex/pr']);
    s.native(['remote', 'add', 'origin', 'https://github.com/test/repo.git']);
    write(join(s.target, '.agents/skills/gidd/config.toml'), 'schema_version = 1\n');
    initializeDataFixture(s.target);
    const bindingPath = join(s.root, '.agents/skills.tools/gidd/tool-bindings.json');
    const bindings = JSON.parse(readFileSync(bindingPath, 'utf8'));
    bindings.tools.gh = { path: process.execPath, source: 'path', version: '99.0.0' };
    write(bindingPath, JSON.stringify(bindings));
    const pr = { number: 42, state: 'closed', merged: true, merged_at: '2026-09-30T00:00:00Z', merge_commit_sha: merge,
      head: { ref: 'codex/pr', sha: head, repo: { full_name: 'test/repo' } }, base: { ref: 'main', repo: { full_name: 'test/repo' } } };
    const control = { list: [pr], pr, calls: [], intercept: null };
    const execute = async (exe, args, options) => {
      control.calls.push(args);
      const intercepted = await control.intercept?.(exe, args, options);
      if (intercepted) return intercepted;
      if (exe === process.execPath) {
        assert.equal(options.env.GH_HOST, 'github.com');
        if (args[0] === 'config') return { ok: true, text: 'tester' };
        if (args[0] === 'auth') return { ok: true, text: 'fixture-token' };
        assert.equal(options.env.GH_TOKEN, 'fixture-token');
        if (args.includes('user')) return { ok: true, text: 'tester' };
        const endpoint = args.at(-1);
        if (endpoint.includes('/pulls?')) return { ok: true, text: JSON.stringify(control.list) };
        if (endpoint.endsWith('/pulls/42')) return { ok: true, text: JSON.stringify(control.pr) };
        throw new Error('unexpected fixture API request');
      }
      const redirected = args.includes('ls-remote') || args.includes('push') ? args.map(arg => ['origin','https://github.com/test/repo.git'].includes(arg) ? bare : arg) : args;
      return runCommand(exe, redirected, options);
    };
    return { ...s, a, head, merge, bare, control, execute,
      cleanup: () => worktreeCommand(s.target, { action: 'cleanup', path: a.path }, { execute }) };
  } catch (error) { s.dispose(); throw error; }
}

test('direct cleanup requires delivery to the recorded target and uses recorded branches and directory inspection', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/local']);
    write(join(a.path, 'tracked.txt'), 'new work\n');
    s.native(['commit', '-am', 'feat: local work'], a.path);
    const head = s.native(['rev-parse', 'HEAD'], a.path);
    await assert.rejects(s.command('show', ['codex/local']), /worktree_unknown_selector/);
    assert.equal((await s.command('show', [a.path])).record.branch, 'codex/local');
    // An upstream containing the source tip is not proof of target delivery.
    s.native(['branch', 'unrelated', head]);
    s.native(['branch', '--set-upstream-to=unrelated', 'codex/local']);
    await assert.rejects(s.command('cleanup', ['codex/local']), /worktree_not_delivered/);
    assert.equal(s.native(['branch', '--show-current'], a.path), 'codex/local');
    s.native(['merge', '--ff-only', 'codex/local']);
    const result = await s.command('cleanup', ['codex/local']);
    assert.equal(result.local_branch_deleted, true);
    assert.equal(s.native(['branch', '--list', 'codex/local']), '');
    assert.ok(!s.native(['config', '--local', '--list']).includes('branch.codex/local.'));
    assert.equal((await s.command('cleanup', ['codex/local'])).state, 'available');
    assert.equal((await s.command('remove', [a.path])).removed, true);
  } finally { s.dispose(); }
});

test('local cleanup accepts recorded squash delivery and rejects incomplete or changed evidence', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/squash']);
    write(join(a.path, 'tracked.txt'), 'squashed work\n');
    s.native(['commit', '-am', 'source work'], a.path);
    const head = s.native(['rev-parse', 'HEAD'], a.path);
    s.native(['merge', '--squash', 'codex/squash']); s.native(['commit', '-m', 'squash result']);
    const commit = s.native(['rev-parse', 'main']);
    const record = JSON.parse(s.readRecord(a.id));
    await assert.rejects(s.command('cleanup', ['codex/squash']), /worktree_not_delivered/);
    for (const local_merge of [{ head, commit: true }, { head, before: a.start_commit }, { head, commit, unexpected: true }]) {
      s.writeRecord(a.id, JSON.stringify({ ...record, local_merge }));
      await assert.rejects(s.command('show', [a.path]), /worktree_record_invalid/);
    }
    s.writeRecord(a.id, JSON.stringify({ ...record, local_merge: { head: a.start_commit, commit } }));
    await assert.rejects(s.command('cleanup', ['codex/squash']), /worktree_not_delivered/);
    s.writeRecord(a.id, JSON.stringify({ ...record, local_merge: { head, commit: head } }));
    await assert.rejects(s.command('cleanup', ['codex/squash']), /worktree_not_delivered/);
    s.writeRecord(a.id, JSON.stringify({ ...record, local_merge: { head, commit } }));
    assert.equal((await s.command('cleanup', ['codex/squash'])).state, 'available');
  } finally { s.dispose(); }
});

test('local ref deletion compares the verified commit and never erases a concurrent update', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/race']);
    s.native(['commit', '--allow-empty', '-m', 'advance main']);
    const newer = s.native(['rev-parse', 'main']);
    const result = await s.command('cleanup', ['codex/race'], { execute: async (exe, args, options) => {
      if (args.includes('update-ref') && args.includes('-d')) {
        s.native(['update-ref', 'refs/heads/codex/race', newer]);
        assert.equal(args.at(-1), a.start_commit);
      }
      return runCommand(exe, args, options);
    } });
    assert.equal(result.status, 'error');
    assert.equal(result.local_branch_deleted, false);
    assert.equal(s.native(['rev-parse', 'codex/race']), newer);
    assert.equal((await s.command('show', [a.path])).worktree.reason, 'worktree_cleanup_pending');
  } finally { s.dispose(); }
});

test('PR cleanup discovers a unique squash delivery and removes only the matching working branch refs', async () => {
  const s = await prInstallation();
  try {
    const result = await s.cleanup();
    assert.equal(result.pr, 42);
    assert.equal(result.state, 'available');
    assert.equal(result.local_branch_deleted, true);
    assert.equal(result.remote_branch_deleted, true);
    assert.equal(s.native(['branch', '--list', 'codex/pr']), '');
    assert.equal(s.native(['ls-remote', '--refs', s.bare, 'refs/heads/codex/pr']), '');
    assert.ok(s.native(['ls-remote', '--refs', s.bare, 'refs/heads/main']).startsWith(s.merge));
    assert.equal((await s.command('show', [s.a.path])).worktree.state, 'available');
    assert.equal((await s.cleanup()).state, 'available');
    const reused = await s.command('acquire', ['codex/next']);
    assert.equal(reused.path, s.a.path);
    assert.equal((await s.command('show', [reused.path])).record.cleanup, undefined);
  } finally { s.dispose(); }
});

test('PR discovery retains resources when absent or ambiguous and always verifies the selected delivery', async () => {
  const s = await prInstallation();
  try {
    const original = structuredClone(s.control.pr);
    const before = snapshot(s.root);
    for (const [list, reason] of [[[], /worktree_pr_not_found/], [[original, { ...original, number: 43 }], /worktree_pr_ambiguous/]]) {
      s.control.list = list;
      await assert.rejects(s.cleanup(), reason);
      assert.deepEqual(snapshot(s.root), before);
    }
    s.control.list = [original];
    for (const changes of [{ merged: false }, { head: { ...original.head, sha: s.a.start_commit } },
      { head: { ...original.head, repo: { full_name: 'someone/fork' } } }, { base: { ...original.base, ref: 'other' } }]) {
      s.control.pr = { ...original, ...changes };
      await assert.rejects(s.cleanup(), /worktree_pr_not_delivered/);
    }
    assert.equal(s.native(['branch', '--show-current'], s.a.path), 'codex/pr');
    s.control.pr = original;
    assert.equal((await s.cleanup()).state, 'available');
  } finally { s.dispose(); }
});

test('PR cleanup preserves additional local work, unsynchronized targets and changed remote tips', async () => {
  const s = await prInstallation();
  try {
    s.native(['commit', '--allow-empty', '-m', 'additional work'], s.a.path);
    await assert.rejects(s.cleanup(), /worktree_pr_not_found/);
    s.native(['reset', '--hard', s.head], s.a.path); // fixture-only rollback
    s.native(['reset', '--hard', s.a.start_commit]);
    await assert.rejects(s.cleanup(), /worktree_(not_delivered|git_failed)/);
    s.native(['reset', '--hard', s.merge]);
    s.native(['update-ref', 'refs/heads/codex/pr', s.merge], s.bare);
    await assert.rejects(s.cleanup(), /worktree_remote_branch_changed/);
    assert.equal(s.native(['branch', '--show-current'], s.a.path), 'codex/pr');
    assert.equal(s.native(['rev-parse', 'codex/pr']), s.head);
  } finally { s.dispose(); }
});

test('an exact remote lease rejects a concurrent push and leaves cleanup retryable', async () => {
  const s = await prInstallation();
  try {
    let raced = false;
    s.control.intercept = async (exe, args) => {
      if (exe === s.git && args.includes('push') && !raced) {
        raced = true;
        assert.ok(args.includes('--force-with-lease=refs/heads/codex/pr:' + s.head));
        s.native(['update-ref', 'refs/heads/codex/pr', s.merge], s.bare);
      }
    };
    const failed = await s.cleanup();
    assert.equal(failed.status, 'error');
    assert.equal(failed.local_branch_deleted, false);
    assert.equal(failed.reason, 'worktree_remote_failed');
    assert.equal((await s.command('show', [s.a.path])).worktree.reason, 'worktree_cleanup_pending');
    assert.equal(s.native(['rev-parse', 'codex/pr']), s.head);
    assert.equal(s.native(['rev-parse', 'codex/pr'], s.bare), s.merge);
    const pending = JSON.parse(s.readRecord(s.a.id));
    s.writeRecord(s.a.id, JSON.stringify({ ...pending, delivery: { ...pending.delivery, mode: 'direct-merge' } }));
    await assert.rejects(s.command('cleanup', ['codex/pr']), /worktree_cleanup_mode_mismatch/);
    s.writeRecord(s.a.id, JSON.stringify(pending));
    s.native(['update-ref', 'refs/heads/codex/pr', s.head], s.bare);
    assert.equal((await s.cleanup()).state, 'available');
  } finally { s.dispose(); }
});

test('cleanup retries after remote and local ref deletion without guessing a new PR', async () => {
  const s = await prInstallation();
  try {
    let interrupted = false;
    s.control.intercept = async (exe, args) => {
      if (exe === s.git && args.includes('config') && args.includes('--name-only') && !interrupted) {
        interrupted = true;
        return { ok: false, reason: 'command_failed', text: '' };
      }
    };
    const failed = await s.cleanup();
    assert.equal(failed.status, 'error');
    assert.equal(failed.remote_branch_deleted, true);
    assert.equal(failed.local_branch_deleted, true);
    assert.equal(failed.retry, '1.cleanup');
    assert.equal(s.native(['branch', '--list', 'codex/pr']), '');
    const pending = workspaceReport(await s.command('show', [s.a.path]));
    assert.equal(pending.workspace.state, 'needs_check');
    assert.deepEqual(pending.workspace.details, { code: 'worktree_cleanup_pending' });
    assert.deepEqual(pending.cleanup, { head: s.head, pr: 42, mode: 'pr-merge', repository: 'https://github.com/test/repo' });
    assert.deepEqual(pending.workspace, { path: s.a.path, state: 'needs_check', delivery_mode: 'pr-merge', branch: 'codex/pr', start_commit: s.a.start_commit, head: s.head, detached: true, details: { code: 'worktree_cleanup_pending' } });
    assert.equal(Object.hasOwn(pending.workspace, 'release_commit'), false);
    await assert.rejects(s.command('acquire', ['codex/pr']), /worktree_cleanup_pending/);
    s.control.calls.length = 0;
    s.control.list = []; // retry must use the already selected PR
    assert.equal((await s.cleanup()).state, 'available');
    const released = workspaceReport(await s.command('show', [s.a.path]));
    assert.equal(released.workspace.state, 'available');
    assert.equal(released.workspace.release_commit, s.head);
    assert.deepEqual(released.cleanup, pending.cleanup);
    assert.ok(!s.control.calls.some(args => args.at(-1)?.includes('/pulls?')));
  } finally { s.dispose(); }
});

test('PR cleanup rejects mismatched or multiple push destinations before changing resources', async () => {
  const s = await prInstallation();
  try {
    s.native(['remote', 'set-url', '--push', 'origin', 'https://github.com/other/repo.git']);
    await assert.rejects(s.cleanup(), /delivery_remote_changed/);
    s.native(['remote', 'set-url', '--push', 'origin', 'https://github.com/test/repo.git']);
    s.native(['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/test/repo.git']);
    await assert.rejects(s.cleanup(), /remote_multiple_push_urls/);
    assert.equal(s.native(['branch', '--show-current'], s.a.path), 'codex/pr');
  } finally { s.dispose(); }
});

test('worktree arguments expose only list and directory-based show/remove', () => {
  assert.deepEqual(parseWorktreeArguments('worktree.list', []), { action: 'list' });
  const id = 'gidd-wt-00000000-0000-0000-0000-000000000000';
  assert.deepEqual(parseWorktreeArguments('worktree.show', [id]), { action: 'show', path: id });
  assert.deepEqual(parseWorktreeArguments('worktree.remove', ['D:/repo.gidd/work tree']), { action: 'remove', path: 'D:/repo.gidd/work tree' });
  for (const route of ['acquire', 'cleanup', 'release'])
    for (const args of [[], ['codex/fix'], ['codex/fix', '--base', 'main'], ['codex/fix', '--pr'], ['codex/fix', '--direct-merge']])
      assert.throws(() => parseWorktreeArguments('worktree.' + route, args), /invalid_arguments/);
  for (const [route, args] of [['list', ['extra']], ['acquire', []], ['acquire', ['branch', '--base']], ['acquire', ['branch', '--base', '-bad']],
    ['acquire', ['branch', '--base', 'main', '--force']], ['cleanup', []], ['show', []], ['show', [id, 'extra']], ['resume', ['task']]])
    assert.throws(() => parseWorktreeArguments('worktree.' + route, args), /invalid_arguments/);
});

test('explicit targets determine the starting point across reuse and linked-worktree callers', async () => {
  const s = installation();
  try {
    const first = await s.command('acquire', ['codex/one']);
    assert.equal(first.target_branch, 'main');
    assert.equal(first.start_commit, s.native(['rev-parse', 'main']));
    write(join(first.path, 'tracked.txt'), 'old development\n');
    s.native(['commit', '-am', 'old development'], first.path);
    s.native(['merge', '--ff-only', 'codex/one']);
    await s.command('cleanup', ['codex/one']);
    s.native(['checkout', '-b', 'release/1.x']);
    write(join(s.target, 'tracked.txt'), 'release version\n');
    s.native(['commit', '-am', 'release version']);
    const releaseStart = s.native(['rev-parse', 'HEAD']);
    const reused = await s.command('acquire', ['codex/two', '--base', 'release/1.x']);
    assert.equal(reused.path, first.path);
    assert.equal(reused.target_branch, 'release/1.x');
    assert.equal(reused.start_commit, releaseStart);
    assert.equal(readFileSync(join(reused.path, 'tracked.txt'), 'utf8'), 'release version\n');
    const record = (await s.command('show', [reused.path])).record;
    assert.equal(record.branch, 'codex/two');
    assert.equal(record.target_branch, 'release/1.x');
    assert.equal(record.start_commit, releaseStart);
    write(join(reused.path, 'tracked.txt'), 'linked development\n');
    s.native(['commit', '-am', 'linked development'], reused.path);
    const linkedStart = s.native(['rev-parse', 'HEAD'], reused.path);
    const linked = await worktreeCommand(reused.path, acquireOptions('codex/three', 'codex/two', 3));
    assert.equal(linked.target_branch, 'codex/two');
    assert.equal(linked.start_commit, linkedStart);
    assert.notEqual(linked.path, reused.path);
    assert.equal(s.native(['branch', '--show-current']), 'release/1.x');
    assert.equal(s.native(['branch', '--show-current'], reused.path), 'codex/two');
  } finally { s.dispose(); }
});

test('reuse retains a released workspace while a task still references it', async () => {
  const s = installation();
  try {
    const first = await s.command('acquire', ['codex/first']);
    const storage = { path: s.state, initialized: true };
    const task = { schema: 'gidd.task/v1', issue: 1, target_branch: 'main',
      delivery: acquireOptions('codex/first').delivery, flow: flowSnapshot(readFlow('01/00')),
      github_account: 'fixture', workspace: first.id };
    saveTask(storage, task);
    await s.command('cleanup', ['codex/first']);
    const released = s.readRecord(first.id);
    assert.equal((await s.command('show', [first.path])).worktree.state, 'available');
    await assert.rejects(s.command('remove', [first.path]), /task_cleanup_pending/);
    const next = await s.command('acquire', ['codex/next']);
    assert.notEqual(next.id, first.id); assert.notEqual(next.path, first.path);
    assert.equal(s.readRecord(first.id), released);
    assert.equal(JSON.parse(readFileSync(join(s.state, '1/state.json'), 'utf8')).workspace, first.id);
    delete task.workspace; saveTask(storage, task);
    const reused = await s.command('acquire', ['codex/reused']);
    assert.equal(reused.id, first.id); assert.equal(reused.path, first.path);
  } finally { s.dispose(); }
});

test('allocation requires explicit Issue context and a local target even with detached or unborn callers', async () => {
  const s = installation();
  try {
    s.native(['checkout', '--detach', 'main']);
    const missingBase = acquireOptions('codex/detached'); delete missingBase.base;
    await assert.rejects(worktreeCommand(s.target, missingBase), /worktree_base_required/);
    await assert.rejects(worktreeCommand(s.target, { action: 'acquire', branch: 'codex/detached', base: 'main' }), /invalid_arguments/);
    const missingContext = acquireOptions('codex/detached'); delete missingContext.delivery;
    await assert.rejects(worktreeCommand(s.target, missingContext), /delivery_context_invalid/);
    assert.deepEqual(JSON.parse(readFileSync(join(s.state, 'storage.json'), 'utf8')).worktrees, {});
    assert.equal(s.native(['branch', '--list', 'codex/detached']), '');
    const explicit = await s.command('acquire', ['codex/explicit', '--base', 'main']);
    assert.equal(explicit.target_branch, 'main');
    await s.command('cleanup', ['codex/explicit']);
    await assert.rejects(worktreeCommand(explicit.path, missingBase), /worktree_base_required/);
    assert.equal((await s.command('show', [explicit.path])).worktree.state, 'available');
    const empty = join(s.root, 'empty');
    mkdirSync(empty);
    s.native(['init', '-b', 'main'], empty);
    initializeDataFixture(empty);
    await assert.rejects(worktreeCommand(empty, acquireOptions('codex/unborn')), /worktree_base_missing/);
    assert.deepEqual(JSON.parse(readFileSync(join(empty + '.gidd', 'storage.json'), 'utf8')).worktrees, {});
    assert.equal(s.native(['branch', '--list', 'codex/unborn'], empty), '');
    assert.equal(existsSync(join(empty + '.gidd', '.lock')), false);
  } finally { s.dispose(); }
});

test('list is read-only; cleanup deletes delivered branches and reuse preserves caches across worktree callers', async () => {
  const s = installation();
  try {
    const before = snapshot(s.root);
    assert.deepEqual((await s.command('list')).worktrees, []);
    assert.deepEqual(snapshot(s.root), before);
    const first = await s.command('acquire', ['codex/one', '--base', 'main']);
    assert.equal(first.target_branch, 'main');
    assert.equal(first.start_commit, s.native(['rev-parse', 'main']));
    const recordedFirst = (await s.command('show', [first.path])).record;
    assert.equal(recordedFirst.branch, 'codex/one');
    assert.equal(recordedFirst.target_branch, 'main');
    assert.equal(recordedFirst.start_commit, first.start_commit);
    assert.equal(first.path, join(s.target + '.gidd', first.id));
    const noticePath = join(s.target + '.gidd', 'README.md');
    const notice = readFileSync(noticePath, 'utf8');
    assert.equal(notice, readFileSync(new URL('../.agents/skills/gidd/references/worktree-directory.md', import.meta.url), 'utf8'));
    const amendedNotice = notice + '\nLocal notes to preserve.\n';
    write(noticePath, amendedNotice);
    write(join(first.path, 'tracked.txt'), 'delivered\n');
    s.native(['commit', '-am', 'change'], first.path);
    const delivered = s.native(['rev-parse', 'HEAD'], first.path);
    s.native(['merge', '--ff-only', 'codex/one']);
    write(join(first.path, 'cache.bin'), 'keep cache');
    const released = await s.command('cleanup', ['codex/one']);
    assert.equal(released.local_branch_deleted, true);
    assert.equal(s.native(['branch', '--list', 'codex/one']), '');
    assert.equal(s.native(['rev-parse', 'HEAD'], first.path), delivered);
    assert.equal((await s.command('list')).worktrees.find(row => row.id === first.id).state, 'available');
    s.native(['checkout', '-b', 'next-target', 'main']);
    s.native(['commit', '--allow-empty', '-m', 'advance target']);
    s.native(['checkout', 'main']);
    const nextStart = s.native(['rev-parse', 'next-target']);
    const reused = await worktreeCommand(first.path, acquireOptions('codex/two', 'next-target', 2));
    assert.equal(reused.path, first.path);
    assert.equal(readFileSync(noticePath, 'utf8'), amendedNotice);
    assert.equal(readFileSync(join(reused.path, 'tracked.txt'), 'utf8'), 'delivered\n');
    assert.equal(readFileSync(join(reused.path, 'cache.bin'), 'utf8'), 'keep cache');
    const shown = await s.command('show', [first.path]);
    assert.equal(shown.record.branch, 'codex/two');
    assert.equal(shown.record.target_branch, 'next-target');
    assert.equal(shown.record.start_commit, nextStart);
    assert.equal(shown.git.branch, 'codex/two');
    assert.equal(shown.git.head, nextStart);
    const listed = (await s.command('list')).worktrees.find(row => row.id === first.id);
    assert.equal(listed.recorded_branch, 'codex/two');
    assert.equal(listed.target_branch, 'next-target');
    assert.equal(listed.start_commit, nextStart);
    assert.equal((await s.command('list')).worktrees.find(row => row.id === first.id).state, 'assigned');
    await assert.rejects(s.command('cleanup', ['codex/one']), /worktree_unknown_selector/);
    unlinkSync(join(reused.path, 'cache.bin'));
    await s.command('cleanup', ['codex/two']);
    assert.equal((await s.command('remove', [first.path])).removed, true);
    assert.equal(existsSync(first.path), false);
    assert.equal(s.hasRecord(first.id), false);
    assert.equal(readFileSync(noticePath, 'utf8'), amendedNotice);
    assert.equal(s.native(['branch', '--list', 'codex/one']), '');
    assert.equal(s.native(['branch', '--show-current']), 'main');
  } finally { s.dispose(); }
});

test('missing allocation metadata is rejected without guessing or changing the checkout', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/interrupted', '--base', 'main']);
    const pending = JSON.parse(s.readRecord(a.id));
    delete pending.branch; delete pending.target_branch; delete pending.start_commit;
    s.writeRecord(a.id, JSON.stringify(pending));
    const before = snapshot(s.root);
    await assert.rejects(s.command('show', [a.path]), /worktree_record_invalid/);
    await assert.rejects(s.command('list'), /worktree_record_invalid/);
    await assert.rejects(s.command('cleanup', ['codex/interrupted']), /worktree_record_invalid/);
    assert.equal(s.native(['branch', '--show-current'], a.path), 'codex/interrupted');
    assert.equal(readFileSync(join(a.path, 'tracked.txt'), 'utf8'), 'original\n');
    assert.deepEqual(snapshot(s.root), before);
  } finally { s.dispose(); }
});

test('saved allocation intent resumes the same UUID before and after Git creates the checkout', async () => {
  for (const afterGit of [false, true]) {
    const s = installation();
    try {
      const options = acquireOptions('codex/recovery');
      let saved;
      await assert.rejects(worktreeCommand(s.target, options, { execute: async (exe, args, execution) => {
        if (args.includes('add') && args.includes('worktree')) {
          saved = readRecords(join(s.state, 'storage.json'), s.state)[0];
          assert.equal(saved.issue, 1); assert.equal(saved.branch, options.branch);
          assert.equal(saved.start_commit, s.native(['rev-parse', 'main']));
          assert.deepEqual(saved.preparation, { branch: options.branch, target_branch: 'main', start_commit: saved.start_commit });
          if (afterGit) assert.equal((await runCommand(exe, args, execution)).ok, true);
          throw new Error('interrupted');
        }
        return runCommand(exe, args, execution);
      } }), /interrupted/);
      const shown = await s.command('show', [saved.path]);
      assert.equal(shown.worktree.reason, 'worktree_preparation_pending');
      assert.equal(workspaceReport(shown).preparation.start_commit, saved.start_commit);
      s.native(['commit', '--allow-empty', '-m', 'advance target during interruption']);
      const recovered = await worktreeCommand(s.target, options);
      assert.equal(recovered.id, saved.id); assert.equal(recovered.path, saved.path);
      assert.equal(recovered.start_commit, saved.start_commit);
      assert.equal(readRecords(join(s.state, 'storage.json'), s.state).length, 1);
      assert.equal((await s.command('show', [saved.path])).record.preparation, undefined);
      assert.deepEqual(await worktreeCommand(s.target, options), recovered);
    } finally { s.dispose(); }
  }
});

test('allocation recovers a created branch before checkout and refuses changed saved plans or user edits', async () => {
  const s = installation();
  try {
    const options = acquireOptions('codex/branch-only');
    await assert.rejects(worktreeCommand(s.target, options, { execute: async (exe, args, execution) => {
      if (args.includes('worktree') && args.includes('add')) {
        s.native(['branch', options.branch, args.at(-1)]);
        throw new Error('interrupted');
      }
      return runCommand(exe, args, execution);
    } }), /interrupted/);
    const before = snapshot(s.root);
    await assert.rejects(worktreeCommand(s.target, { ...options, branch: 'codex/different' }), /worktree_preparation_mismatch/);
    assert.deepEqual(snapshot(s.root), before);
    const recovered = await worktreeCommand(s.target, options);
    assert.equal(s.native(['branch', '--show-current'], recovered.path), options.branch);
    const completed = JSON.parse(s.readRecord(recovered.id));
    completed.preparation = { branch: completed.branch, target_branch: completed.target_branch, start_commit: completed.start_commit };
    s.writeRecord(recovered.id, JSON.stringify(completed));
    write(join(recovered.path, 'tracked.txt'), 'user edit\n');
    const edited = snapshot(s.root);
    await assert.rejects(worktreeCommand(s.target, options), /worktree_dirty/);
    await assert.rejects(worktreeCommand(s.target, { action: 'abort', path: recovered.path }), /worktree_dirty/);
    assert.deepEqual(snapshot(s.root), edited);
    write(join(recovered.path, 'tracked.txt'), 'original\n');
    write(join(recovered.path, 'cache.bin'), 'new ignored user data');
    await assert.rejects(worktreeCommand(s.target, { action: 'abort', path: recovered.path }), /worktree_ignored_files/);
    assert.equal(readFileSync(join(recovered.path, 'cache.bin'), 'utf8'), 'new ignored user data');
    unlinkSync(join(recovered.path, 'cache.bin'));
    assert.equal((await worktreeCommand(s.target, { action: 'abort', path: recovered.path })).aborted, true);
    assert.equal(existsSync(recovered.path), false); assert.equal(s.hasRecord(recovered.id), false);
    assert.equal(s.native(['branch', '--list', options.branch]), '');
  } finally { s.dispose(); }
});

test('aborting reused allocation restores release evidence and preserves ignored caches, including interrupted cleanup', async () => {
  for (const afterGit of [false, true]) {
    const s = installation();
    try {
      const released = await s.command('acquire', ['codex/released']);
      await s.command('cleanup', ['codex/released']);
      const previous = s.readRecord(released.id);
      write(join(released.path, 'cache.bin'), 'previous cache');
      s.native(['commit', '--allow-empty', '-m', 'new target']);
      const options = acquireOptions('codex/reused', 'main', 2);
      await assert.rejects(worktreeCommand(s.target, options, { execute: async (exe, args, execution) => {
        if (args.includes('checkout') && args.includes('-b')) {
          const saved = JSON.parse(s.readRecord(released.id));
          assert.deepEqual(saved.preparation.previous, JSON.parse(previous));
          if (afterGit) assert.equal((await runCommand(exe, args, execution)).ok, true);
          throw new Error('interrupted');
        }
        return runCommand(exe, args, execution);
      } }), /interrupted/);
      if (afterGit) {
        await assert.rejects(worktreeCommand(s.target, { action: 'abort', path: released.path }, { execute: async (exe, args, execution) => {
          if (args.includes('checkout') && args.includes('--detach')) {
            assert.equal((await runCommand(exe, args, execution)).ok, true);
            throw new Error('interrupted abort');
          }
          return runCommand(exe, args, execution);
        } }), /interrupted abort/);
      }
      const aborted = await worktreeCommand(s.target, { action: 'abort', path: released.path });
      assert.equal(aborted.state, 'available'); assert.equal(aborted.aborted, true);
      assert.equal(s.readRecord(released.id), previous);
      assert.equal(s.native(['rev-parse', 'HEAD'], released.path), released.start_commit);
      assert.equal(s.native(['branch', '--show-current'], released.path), '');
      assert.equal(s.native(['branch', '--list', options.branch]), '');
      assert.equal(readFileSync(join(released.path, 'cache.bin'), 'utf8'), 'previous cache');
      assert.equal((await s.command('show', [released.path])).worktree.state, 'available');
    } finally { s.dispose(); }
  }
});

test('reused allocation resumes branch creation and completed checkout while retaining its caches', async () => {
  for (const afterGit of [false, true]) {
    const s = installation();
    try {
      const previous = await s.command('acquire', ['codex/previous']);
      await s.command('cleanup', ['codex/previous']);
      write(join(previous.path, 'cache.bin'), 'keep this cache');
      s.native(['commit', '--allow-empty', '-m', 'new target']);
      const start = s.native(['rev-parse', 'main']), options = acquireOptions('codex/resumed', 'main', 2);
      await assert.rejects(worktreeCommand(s.target, options, { execute: async (exe, args, execution) => {
        if (args.includes('checkout') && args.includes('-b')) {
          if (afterGit) assert.equal((await runCommand(exe, args, execution)).ok, true);
          else s.native(['branch', options.branch, start]);
          throw new Error('interrupted');
        }
        return runCommand(exe, args, execution);
      } }), /interrupted/);
      const recovered = await worktreeCommand(s.target, options);
      assert.equal(recovered.id, previous.id); assert.equal(recovered.path, previous.path);
      assert.equal(recovered.start_commit, start);
      assert.equal((await s.command('show', [previous.path])).record.preparation, undefined);
      assert.equal(readFileSync(join(previous.path, 'cache.bin'), 'utf8'), 'keep this cache');
    } finally { s.dispose(); }
  }
});

test('allocation retains recovery evidence until explicit commit and commit retries after verification interruption', async () => {
  const s = installation();
  try {
    const previous = await s.command('acquire', ['codex/released']);
    await s.command('cleanup', ['codex/released']);
    const releasedRecord = JSON.parse(s.readRecord(previous.id));
    const options = { ...acquireOptions('codex/deferred', 'main', 2), defer_commit: true };
    const created = await worktreeCommand(s.target, options);
    assert.equal(created.id, previous.id);
    assert.deepEqual(JSON.parse(s.readRecord(created.id)).preparation.previous, releasedRecord);
    assert.deepEqual(await worktreeCommand(s.target, options), created);
    const commit = { action: 'commit', issue: 2, path: created.path };
    await assert.rejects(worktreeCommand(s.target, commit, { execute: async (exe, args, execution) => {
      if (args.includes('for-each-ref') && args.includes('--format=%(refname) %(objectname) %(symref)')) throw new Error('interrupted commit');
      return runCommand(exe, args, execution);
    } }), /interrupted commit/);
    assert.ok(JSON.parse(s.readRecord(created.id)).preparation);
    await assert.rejects(worktreeCommand(s.target, { ...commit, issue: 3 }), /worktree_preparation_mismatch/);
    const committed = await worktreeCommand(s.target, commit);
    assert.deepEqual(committed, created);
    assert.equal(JSON.parse(s.readRecord(created.id)).preparation, undefined);
    assert.deepEqual(await worktreeCommand(s.target, commit), committed);
    await assert.rejects(worktreeCommand(s.target, { action: 'abort', path: created.path }), /worktree_preparation_missing/);
  } finally { s.dispose(); }
});

test('aborting a new allocation continues after checkout removal without deleting a changed ref', async () => {
  const s = installation();
  try {
    const options = acquireOptions('codex/abort');
    await assert.rejects(worktreeCommand(s.target, options, { execute: async (exe, args, execution) => {
      if (args.includes('worktree') && args.includes('add')) {
        assert.equal((await runCommand(exe, args, execution)).ok, true);
        throw new Error('interrupted');
      }
      return runCommand(exe, args, execution);
    } }), /interrupted/);
    const saved = readRecords(join(s.state, 'storage.json'), s.state)[0];
    await assert.rejects(worktreeCommand(s.target, { action: 'abort', path: saved.path }, { execute: async (exe, args, execution) => {
      if (args.includes('worktree') && args.includes('remove')) {
        assert.equal((await runCommand(exe, args, execution)).ok, true);
        throw new Error('interrupted abort');
      }
      return runCommand(exe, args, execution);
    } }), /interrupted abort/);
    assert.equal(existsSync(saved.path), false); assert.ok(s.hasRecord(saved.id));
    s.native(['commit', '--allow-empty', '-m', 'new commit']);
    const newer = s.native(['rev-parse', 'main']);
    s.native(['update-ref', 'refs/heads/' + options.branch, newer]);
    const before = snapshot(s.root);
    await assert.rejects(worktreeCommand(s.target, { action: 'abort', path: saved.path }), /worktree_branch_changed/);
    assert.deepEqual(snapshot(s.root), before);
    s.native(['update-ref', 'refs/heads/' + options.branch, saved.start_commit, newer]);
    assert.equal((await worktreeCommand(s.target, { action: 'abort', path: saved.path })).aborted, true);
    assert.equal(s.hasRecord(saved.id), false); assert.equal(s.native(['branch', '--list', options.branch]), '');
  } finally { s.dispose(); }
});

test('symbolic working refs cannot redirect preparation abort or delivered cleanup into the target branch', async () => {
  const s = installation();
  try {
    const options = acquireOptions('codex/symbolic');
    await assert.rejects(worktreeCommand(s.target, options, { execute: async (exe, args, execution) => {
      if (args.includes('worktree') && args.includes('add')) throw new Error('interrupted');
      return runCommand(exe, args, execution);
    } }), /interrupted/);
    const saved = readRecords(join(s.state, 'storage.json'), s.state)[0], start = s.native(['rev-parse', 'main']);
    s.native(['symbolic-ref', 'refs/heads/' + options.branch, 'refs/heads/main']);
    const before = snapshot(s.root);
    await assert.rejects(worktreeCommand(s.target, { action: 'abort', path: saved.path }), /worktree_branch_changed/);
    await assert.rejects(worktreeCommand(s.target, options), /worktree_branch_changed/);
    assert.equal(s.native(['rev-parse', 'main']), start); assert.deepEqual(snapshot(s.root), before);
    s.native(['symbolic-ref', '--delete', 'refs/heads/' + options.branch]);
    const created = await worktreeCommand(s.target, options);
    s.native(['symbolic-ref', 'refs/heads/' + options.branch, 'refs/heads/main']);
    const assigned = snapshot(s.root);
    await assert.rejects(worktreeCommand(s.target, { action: 'cleanup', path: created.path }), /worktree_branch_mismatch/);
    assert.equal(s.native(['rev-parse', 'main']), start); assert.deepEqual(snapshot(s.root), assigned);
    s.native(['symbolic-ref', '--delete', 'refs/heads/' + options.branch]);
    s.native(['update-ref', 'refs/heads/' + options.branch, start]);
    await worktreeCommand(s.target, { action: 'cleanup', path: created.path }, { execute: async (exe, args, execution) => {
      if (args.includes('update-ref') && args.includes('-d'))
        s.native(['symbolic-ref', 'refs/heads/' + options.branch, 'refs/heads/main']);
      return runCommand(exe, args, execution);
    } });
    assert.equal(s.native(['rev-parse', 'main']), start);
  } finally { s.dispose(); }
});

test('recorded working branch metadata stays distinct from a manually switched branch and missing worktree', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/recorded', '--base', 'main']);
    s.native(['checkout', '-b', 'codex/manual'], a.path);
    const shown = await s.command('show', [a.path]);
    assert.equal(shown.record.branch, 'codex/recorded');
    assert.equal(shown.git.branch, 'codex/manual');
    assert.equal(shown.worktree.recorded_branch, 'codex/recorded');
    assert.equal(shown.worktree.target_branch, 'main');
    assert.equal(shown.worktree.reason, 'worktree_branch_mismatch');
    assert.equal(shown.worktree.state, 'needs_check');
    const publicShown = workspaceReport(shown);
    assert.equal(publicShown.workspace.branch, 'codex/recorded');
    assert.equal(Object.hasOwn(publicShown.workspace, 'checked_out_branch'), false);
    assert.deepEqual(publicShown.workspace.details, { code: 'worktree_branch_mismatch', expected_branch: 'codex/recorded', actual_branch: 'codex/manual' });
    assert.equal(publicShown.workspace.state, 'needs_check');
    assert.equal(publicShown.details, undefined); assert.equal(Object.hasOwn(publicShown, 'reason'), false);
    const listed = (await s.command('list')).worktrees.find(row => row.id === a.id);
    assert.equal(listed.reason, 'worktree_branch_mismatch');
    assert.deepEqual(workspaceReport(await s.command('list')).worktrees[0].workspace.details,
      { code: 'worktree_branch_mismatch', expected_branch: 'codex/recorded', actual_branch: 'codex/manual' });
    await assert.rejects(s.command('cleanup', ['codex/recorded']), /worktree_branch_mismatch/);
    assert.equal(s.native(['branch', '--show-current'], a.path), 'codex/manual');
    s.native(['worktree', 'remove', '--', a.path]);
    const missing = await s.command('show', [a.path]);
    assert.equal(missing.git, null);
    assert.equal(missing.worktree.reason, 'worktree_missing');
    assert.equal(missing.record.target_branch, 'main');
    assert.equal(missing.record.start_commit, a.start_commit);
    const publicMissing = workspaceReport(missing);
    assert.equal(Object.hasOwn(publicMissing.workspace, 'head'), false);
    assert.equal(Object.hasOwn(publicMissing.workspace, 'checked_out_branch'), false);
    assert.equal(publicMissing.workspace.state, 'needs_check');
    assert.deepEqual(publicMissing.workspace.details, { code: 'worktree_missing' });
    assert.equal(publicMissing.target.branch, 'main');
    assert.equal(publicMissing.workspace.start_commit, a.start_commit);
    assert.equal(publicMissing.workspace.delivery_mode, 'direct-merge');
    assert.equal(Object.hasOwn(publicMissing, 'delivery_mode'), false);
    const summary = workspaceReport(await s.command('list')).worktrees[0];
    assert.equal(summary.workspace.state, 'needs_check');
    assert.deepEqual(summary.workspace.details, { code: 'worktree_missing' });
    assert.equal(summary.workspace.branch, 'codex/recorded');
    assert.equal(Object.hasOwn(summary.workspace, 'checked_out_branch'), false);
    assert.equal(summary.workspace.delivery_mode, 'direct-merge');
    assert.equal(Object.hasOwn(summary, 'delivery_mode'), false);
  } finally { s.dispose(); }
});

test('invalid working branch metadata is rejected without rewriting the record', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/work', '--base', 'main']);
    const record = JSON.parse(s.readRecord(a.id));
    for (const fields of [{ branch: '--option' }, { target_branch: null }, { start_commit: 'not-a-commit' },
      { issue: undefined }, { delivery: undefined }, { delivery: undefined, workflow: record.delivery },
      { workflow: record.delivery }, { ready_head: a.start_commit }, { branch: undefined },
      { cleanup: { head: a.start_commit, mode: 'pr', pr: 42, remote: { fetch: { repository: 'https://github.com/test/repo', branch: 'main' }, push: { repository: 'https://github.com/test/repo' } } } }]) {
      const text = JSON.stringify({ ...record, ...fields });
      s.writeRecord(a.id, text);
      await assert.rejects(s.command('show', [a.path]), /worktree_record_invalid/);
      assert.equal(s.readRecord(a.id), text);
    }
  } finally { s.dispose(); }
});

test('a missing notice is restored on reuse and an occupied notice path is never overwritten', async () => {
  const s = installation();
  try {
    const pool = s.target + '.gidd', noticePath = join(pool, 'README.md');
    unlinkSync(noticePath);
    mkdirSync(noticePath, { recursive: true });
    write(join(noticePath, 'keep.txt'), 'user content');
    await assert.rejects(s.command('acquire', ['codex/one', '--base', 'main']), /worktree_readme_invalid/);
    assert.equal(readFileSync(join(noticePath, 'keep.txt'), 'utf8'), 'user content');
    assert.equal(s.native(['branch', '--list', 'codex/one']), '');
    assert.equal((await s.command('list')).worktrees.length, 0);
    // Move the fixture's occupied path aside without deleting its contents.
    const { renameSync } = await import('node:fs');
    renameSync(noticePath, join(s.root, 'saved-notes'));
    const first = await s.command('acquire', ['codex/one', '--base', 'main']);
    const notice = readFileSync(noticePath, 'utf8');
    await s.command('cleanup', ['codex/one']);
    unlinkSync(noticePath);
    const reused = await s.command('acquire', ['codex/two', '--base', 'main']);
    assert.equal(reused.path, first.path);
    assert.equal(readFileSync(noticePath, 'utf8'), notice);
    assert.equal(readFileSync(join(s.root, 'saved-notes/keep.txt'), 'utf8'), 'user content');
  } finally { s.dispose(); }
});

test('allocation rejects existing branches, revision expressions and missing local bases', async () => {
  const s = installation();
  try {
    await assert.rejects(s.command('acquire', ['main', '--base', 'main']), /worktree_branch_exists/);
    await assert.rejects(s.command('acquire', ['MAIN', '--base', 'main']), /worktree_branch_exists/);
    await assert.rejects(s.command('acquire', ['codex/new', '--base', 'absent']), /worktree_base_missing/);
    for (const branch of ['bad..name', '@{-1}', 'refs/heads/main'])
      await assert.rejects(s.command('acquire', [branch, '--base', 'main']), /worktree_(git_failed|branch_invalid)/);
    assert.equal((await s.command('list')).worktrees.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(s.state, 'storage.json'), 'utf8')).worktrees, {});
  } finally { s.dispose(); }
});

test('cleanup blocks dirty, staged, untracked and interrupted Git states without touching files', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/work', '--base', 'main']);
    write(join(a.path, 'tracked.txt'), 'keep edit');
    await assert.rejects(s.command('cleanup', ['codex/work']), /worktree_dirty/);
    assert.equal((await s.command('list')).worktrees.find(row => row.id === a.id).state, 'assigned');
    s.native(['add', 'tracked.txt'], a.path);
    await assert.rejects(s.command('cleanup', ['codex/work']), /worktree_dirty/);
    assert.equal(readFileSync(join(a.path, 'tracked.txt'), 'utf8'), 'keep edit');
    s.native(['commit', '-m', 'save edit'], a.path);
    write(join(a.path, 'untracked.txt'), 'keep untracked');
    await assert.rejects(s.command('cleanup', ['codex/work']), /worktree_dirty/);
    unlinkSync(join(a.path, 'untracked.txt'));
    const gitDir = s.native(['rev-parse', '--absolute-git-dir'], a.path);
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'BISECT_START', 'index.lock']) {
      write(join(gitDir, marker), a.start_commit);
      await assert.rejects(s.command('cleanup', ['codex/work']), /worktree_operation_in_progress/);
      unlinkSync(join(gitDir, marker));
    }
    s.native(['worktree', 'lock', a.path]);
    await assert.rejects(s.command('cleanup', ['codex/work']), /worktree_unavailable/);
    const locked = workspaceReport(await s.command('show', [a.path]));
    assert.equal(locked.workspace.locked, true);
    assert.deepEqual(locked.workspace.details, { code: 'worktree_unavailable' });
    for (const field of ['detached', 'bare', 'prunable']) assert.equal(Object.hasOwn(locked.workspace, field), false);
    s.native(['worktree', 'unlock', a.path]);
    assert.equal(s.native(['branch', '--show-current'], a.path), 'codex/work');
    assert.equal(JSON.parse(s.readRecord(a.id)).ready_head, undefined);
    const retained = await s.command('show', [a.path]);
    assert.equal(retained.worktree.recorded_branch, 'codex/work');
    assert.equal(retained.worktree.target_branch, 'main');
    assert.equal(retained.worktree.start_commit, a.start_commit);
  } finally { s.dispose(); }
});

test('hidden tracked edits cannot be released or erased based on a clean Git status', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/hidden', '--base', 'main']);
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      s.native(['update-index', '--' + flag, 'tracked.txt'], a.path);
      write(join(a.path, 'tracked.txt'), 'hidden edit');
      await assert.rejects(s.command('cleanup', ['codex/hidden']), /worktree_index_flags/);
      assert.equal(readFileSync(join(a.path, 'tracked.txt'), 'utf8'), 'hidden edit');
      s.native(['update-index', '--no-' + flag, 'tracked.txt'], a.path);
      write(join(a.path, 'tracked.txt'), 'original\n');
    }
    await s.command('cleanup', ['codex/hidden']);
    s.native(['update-index', '--assume-unchanged', 'tracked.txt'], a.path);
    write(join(a.path, 'tracked.txt'), 'hidden after release');
    await assert.rejects(s.command('remove', [a.path]), /worktree_index_flags/);
    const b = await s.command('acquire', ['codex/next', '--base', 'main']);
    assert.notEqual(b.path, a.path);
    assert.equal(readFileSync(join(a.path, 'tracked.txt'), 'utf8'), 'hidden after release');
  } finally { s.dispose(); }
});

test('unmanaged detached worktrees and changed release markers are never acquired or removed', async () => {
  const s = installation();
  try {
    const other = join(s.root, 'external');
    s.native(['worktree', 'add', '--detach', other, 'main']);
    const a = await s.command('acquire', ['codex/one', '--base', 'main']);
    assert.notEqual(a.path, other);
    await s.command('cleanup', ['codex/one']);
    write(join(s.target, 'tracked.txt'), 'new main\n');
    s.native(['commit', '-am', 'advance main']);
    s.native(['checkout', '--detach', 'main'], a.path);
    const list = (await s.command('list')).worktrees;
    assert.equal(list.find(row => realpathSync.native(row.path) === realpathSync.native(other)).state, 'unmanaged');
    assert.equal(list.find(row => row.id === a.id).state, 'needs_check');
    await assert.rejects(s.command('remove', [a.path]), /worktree_state_changed/);
    const b = await s.command('acquire', ['codex/two', '--base', 'main']);
    assert.notEqual(b.path, a.path);
    await assert.rejects(s.command('cleanup', ['main']), /worktree_unknown_selector/);
  } finally { s.dispose(); }
});

test('removal requires an unchanged release and preserves ignored or untracked files', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/work', '--base', 'main']);
    await assert.rejects(s.command('remove', [a.path]), /worktree_not_released/);
    await s.command('cleanup', ['codex/work']);
    write(join(a.path, 'cache.bin'), 'valuable ignored file');
    assert.equal(workspaceReport(await s.command('show', [a.path])).workspace.state, 'available');
    await assert.rejects(s.command('remove', [a.path]), /worktree_ignored_files/);
    assert.equal(readFileSync(join(a.path, 'cache.bin'), 'utf8'), 'valuable ignored file');
    unlinkSync(join(a.path, 'cache.bin'));
    write(join(a.path, 'untracked.txt'), 'keep');
    const changed = workspaceReport(await s.command('show', [a.path]));
    assert.equal(changed.workspace.state, 'needs_check'); assert.deepEqual(changed.workspace.details, { code: 'worktree_dirty' });
    await assert.rejects(s.command('remove', [a.path]), /worktree_dirty/);
    assert.equal(existsSync(a.path), true);
  } finally { s.dispose(); }
});

test('failed removal preserves the release and can be retried', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/retry']);
    await s.command('cleanup', ['codex/retry']);
    const before = s.readRecord(a.id);
    await assert.rejects(s.command('remove', [a.path], { execute: (exe, args, options) =>
      args.includes('worktree') && args.includes('remove') ? { ok: false, reason: 'command_failed', text: '' } : runCommand(exe, args, options) }), /worktree_git_failed/);
    assert.equal(s.readRecord(a.id), before);
    assert.equal(workspaceReport(await s.command('show', [a.path])).workspace.state, 'available');
    assert.equal((await s.command('remove', [a.path])).removed, true);
    assert.equal(s.hasRecord(a.id), false); assert.equal(existsSync(a.path), false);
  } finally { s.dispose(); }
});

test('reuse never overwrites an ignored cache that becomes tracked on the new base', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/one', '--base', 'main']);
    write(join(a.path, 'cache.bin'), 'local cache');
    await s.command('cleanup', ['codex/one']);
    write(join(s.target, 'cache.bin'), 'tracked content');
    s.native(['add', '-f', 'cache.bin']); s.native(['commit', '-m', 'track cache']);
    await assert.rejects(s.command('acquire', ['codex/two', '--base', 'main']), /worktree_git_failed/);
    assert.equal(readFileSync(join(a.path, 'cache.bin'), 'utf8'), 'local cache');
    assert.equal(JSON.parse(s.readRecord(a.id)).ready_head, undefined);
  } finally { s.dispose(); }
});

test('a short lock serializes independent allocators and is never reclaimed on timeout', async () => {
  const s = installation();
  try {
    let enter, resume;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const pending = s.command('acquire', ['codex/one', '--base', 'main'], { execute: async (exe, args, options) => {
      if (args.includes('add') && args.includes('worktree')) { enter(); await gate; }
      return runCommand(exe, args, options);
    } });
    await entered;
    try { await assert.rejects(s.command('acquire', ['codex/two', '--base', 'main']), /data_locked/); }
    finally { resume(); }
    const first = await pending;
    const second = await s.command('acquire', ['codex/two', '--base', 'main']);
    assert.notEqual(first.path, second.path);
    const lock = join(s.state, '.lock'), lease = acquireStorageLock({ lock });
    try {
      await assert.rejects(s.command('cleanup', ['codex/one']), /data_locked/);
      assert.equal(existsSync(lock), true);
    } finally { lease.release(); }
  } finally { s.dispose(); }
});

test('failed checkout leaves a recoverable worktree unavailable, without rollback or branch deletion', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/one', '--base', 'main']);
    await s.command('cleanup', ['codex/one']);
    await assert.rejects(s.command('acquire', ['codex/two', '--base', 'main'], { execute: async (exe, args, options) =>
      args.includes('checkout') ? { ok: false, reason: 'command_failed', text: '' } : runCommand(exe, args, options) }), /worktree_git_failed/);
    assert.equal((await s.command('list')).worktrees.find(row => row.id === a.id).state, 'needs_check');
    const failed = await s.command('show', [a.path]);
    assert.equal(failed.worktree.recorded_branch, 'codex/two');
    assert.equal(failed.worktree.target_branch, 'main');
    assert.equal(failed.worktree.start_commit, a.start_commit);
    assert.equal(failed.record.preparation.previous.ready_head, a.start_commit);
    assert.equal(s.native(['branch', '--list', 'codex/one']), '');
    assert.equal(existsSync(join(s.target + '.gidd', '.lock')), false);
    const b = await s.command('acquire', ['codex/three', '--base', 'main']);
    assert.notEqual(b.path, a.path);
  } finally { s.dispose(); }
});

test('remove protects the target checkout even when it is a released managed worktree', async () => {
  const s = installation();
  try {
    await assert.rejects(s.command('remove', [s.target]), /worktree_target_repository_protected/);
    const a = await s.command('acquire', ['codex/entry']);
    await s.command('cleanup', ['codex/entry']);
    const record = s.readRecord(a.id);
    await assert.rejects(worktreeCommand(a.path, { action: 'remove', path: a.path }), /worktree_target_repository_protected/);
    assert.equal(s.readRecord(a.id), record);
    assert.equal(readFileSync(join(a.path, 'tracked.txt'), 'utf8'), 'original\n');
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'original\n');
    // The original entry can still remove its released dedicated directory.
    assert.equal((await s.command('remove', [a.path])).removed, true);
  } finally { s.dispose(); }
});

test('tampered records and pool junctions cannot redirect mutations outside managed paths', async () => {
  const s = installation();
  try {
    const a = await s.command('acquire', ['codex/one', '--base', 'main']);
    await s.command('cleanup', ['codex/one']);
    const original = s.readRecord(a.id);
    const record = JSON.parse(original); record.path = s.target;
    s.writeRecord(a.id, JSON.stringify(record));
    await assert.rejects(s.command('remove', [a.path]), /worktree_record_invalid/);
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'original\n');
    s.writeRecord(a.id, original);
    await s.command('remove', [a.path]);
    const outside = join(s.root, 'outside'); mkdirSync(outside);
    // Use a new repository name whose expected pool is a junction.
    const other = join(s.root, 'other'); mkdirSync(other);
    s.native(['init', '-b', 'main'], other);
    symlinkSync(outside, other + '.gidd', 'junction');
    s.native(['fetch', s.target, 'main'], other);
    s.native(['checkout', '-B', 'main', 'FETCH_HEAD'], other);
    await assert.rejects(worktreeCommand(other, acquireOptions('codex/new')), /reparse_path/);
    assert.equal(existsSync(join(outside, 'tracked.txt')), false);
  } finally { s.dispose(); }
});

test('repository entry selects tasks by Issue and inspects worktrees by directory', async () => {
  const s = installation();
  try {
    ok(adapter(s.root, { action: 'bootstrap', repositoryRoot: s.target, responses: {}, downloads: {}, yes: true }, { env: { PATH: dirname(process.execPath) } }));
    const skill = join(s.root, 'installed skill'); copySkill(skill);
    bindFixture(s.root, { git: compile(s.root, 'transport-git.cs'), gh: compile(s.root, 'wrapper-gh.cs') });
    const bare = join(s.root, 'remote.git');
    s.native(['init', '--bare', bare]); s.native(['push', bare, 'main']);
    s.native(['remote', 'add', 'origin', 'https://github.com/test/repo']);
    write(join(s.target, '.agents/skills/gidd/config.toml'), 'schema_version = 1\n');
    const issueFile = join(s.root, 'issue.json');
    const define = (number, mode) => {
      write(issueFile, JSON.stringify({ number, title: '[gidd] Test', state: 'open',
        html_url: 'https://github.com/test/repo/issues/' + number, body: 'Requirements and acceptance' }));
    };
    define(7, 'direct-merge');
    const inputFile = join(s.root, 'issue-input.json');
    const env = { PATH: '', GIDD_ISSUE_FIXTURE: issueFile, GIDD_ISSUE_INPUT: inputFile, GIDD_TEST_GIT: s.git, GIDD_TEST_REMOTE: bare };
    const cli = (args, cwd = s.target) => {
      const result = runRepositoryCommand(s.target, args, { cwd, env, entry: join(skill, 'gidd.cmd') });
      if (/^(?:worktree\.|[0-9]+(?:\.|$)|issue$|gh\.auth$)/.test(args[0]) && !args[0].endsWith('.flow')) {
        const report = json(result);
        assert.equal(Object.hasOwn(report, 'reason'), false);
        if (report.status === 'error') {
          assert.equal(typeof report.details?.code, 'string'); assert.equal(report.workspace?.details, undefined);
        } else assert.equal(report.details, undefined);
        for (const item of [report, ...(report.worktrees ?? [])]) {
          assert.equal(Object.hasOwn(item, 'reason'), false);
          if (item.workspace?.details) {
            assert.equal(item.workspace.state, 'needs_check'); assert.equal(typeof item.workspace.details.code, 'string');
          }
        }
      }
      return result;
    };
    assert.equal(json(cli(['doctor', '--unexpected'])).details.code, 'invalid_arguments');
    assert.equal(json(cli(['lang.set'])).details.code, 'invalid_arguments');
    assert.deepEqual(json(ok(cli(['worktree.list']))).worktrees, []);
    assert.equal(json(cli(['worktree.remove', s.target])).details.code, 'worktree_target_repository_protected');
    const caller = join(s.root, 'caller'); s.native(['worktree', 'add', '-b', 'caller', caller, 'main']);
    assert.equal(json(cli(['7', '--flow', '01/00'], caller)).details.code, 'execution_worktree_unregistered');
    const bodyFile = join(s.root, 'issue draft.md'), body = '需求与验收\r\n"quoted" $literal `code`\n';
    write(bodyFile, '# [gidd] 创建测试\n\n' + body);
    assert.equal(json(cli(['issue'])).details.code, 'invalid_arguments');
    const created = json(ok(cli(['issue', '--file', bodyFile, '--flow', '01/00'])));
    assert.deepEqual(created.issue, { number: 7, url: 'https://github.com/test/repo/issues/7' });
    assert.equal(created.task, undefined); assert.equal(created.workspace.state, 'assigned');
    assert.deepEqual(JSON.parse(readFileSync(inputFile, 'utf8')), { title: '[gidd] 创建测试', body });
    assert.equal(readFileSync(bodyFile, 'utf8'), '# [gidd] 创建测试\n\n' + body);
    const acquired = json(ok(cli(['7', '--flow', '01/00'])));
    const acquiredId = readRecords(join(s.state, 'storage.json'), s.state).find(record => record.path === acquired.workspace.path).id;
    assert.equal(acquired.target.path, s.target);
    assert.equal(Object.hasOwn(acquired.target, 'repository'), false);
    assert.equal(Object.hasOwn(acquired, 'worktree'), false);
    assert.deepEqual(acquired.issue, { number: 7, url: 'https://github.com/test/repo/issues/7' });
    assert.equal(acquired.workspace.branch, 'gidd-issue-7');
    assert.equal(acquired.workspace.start_commit, s.native(['rev-parse', 'main']));
    const beforeResume = s.readRecord(acquiredId);
    mkdirSync(join(s.target, '7'));
    const resumed = json(ok(cli(['7'])));
    assert.equal(resumed.workspace.path, acquired.workspace.path);
    assert.equal(resumed.workspace.branch, 'gidd-issue-7');
    for (const field of ['development_branch', 'checked_out_branch']) assert.equal(Object.hasOwn(resumed.workspace, field), false);
    assert.equal(resumed.workspace.head, acquired.workspace.start_commit);
    assert.equal(json(ok(cli(['7'], acquired.workspace.path))).workspace.path, acquired.workspace.path);
    assert.equal(s.readRecord(acquiredId), beforeResume);
    const duplicate = json(cli(['7', '--flow', '01/00']));
    assert.equal(duplicate.status, 'success'); assert.equal(duplicate.workspace.path, acquired.workspace.path);
    const shown = json(ok(cli(['worktree.show', acquired.workspace.path])));
    assert.deepEqual(shown.workspace, resumed.workspace); assert.deepEqual(shown.issue, acquired.issue);
    assert.deepEqual(shown.target, acquired.target);
    for (const field of ['record', 'id', 'git', 'delivery', 'worktree', 'workspace_path', 'worktree_path']) assert.equal(Object.hasOwn(shown, field), false);
    assert.equal(json(ok(cli(['worktree.show', relative(s.target, acquired.workspace.path)]))).workspace.path, acquired.workspace.path);
    assert.equal(json(ok(cli(['worktree.show', '.'], acquired.workspace.path))).workspace.path, acquired.workspace.path);
    for (const value of ['gidd-issue-7', acquiredId, 'main', '7'])
      for (const command of ['worktree.show', 'worktree.remove']) assert.equal(json(cli([command, value])).details.code, 'worktree_unknown_selector');
    for (const command of ['7', '7.push', '7.merge', '7.target-sync', '7.close-issue', '7.cleanup'])
      for (const value of ['gidd-issue-7', acquired.workspace.path]) assert.equal(json(cli([command, value])).details.code, 'invalid_arguments');
    const listing = json(ok(cli(['worktree.list'])));
    assert.equal(listing.worktrees.length, 2);
    const listed = listing.worktrees.find(row => row.issue?.number === 7);
    assert.equal(Object.hasOwn(listed, 'worktree'), false);
    assert.equal(listed.workspace.state, 'assigned'); assert.equal(listed.workspace.branch, 'gidd-issue-7');
    assert.equal(listing.worktrees.find(row => row.workspace.state === 'unmanaged').issue, undefined);
    s.native(['checkout', '-b', 'codex/changed'], acquired.workspace.path);
    const changed = json(ok(cli(['worktree.show', acquired.workspace.path])));
    assert.equal(changed.workspace.state, 'needs_check'); assert.equal(changed.workspace.branch, 'gidd-issue-7');
    assert.deepEqual(changed.workspace.details, { code: 'worktree_branch_mismatch', expected_branch: 'gidd-issue-7', actual_branch: 'codex/changed' });
    const branchError = json(cli(['7']));
    assert.equal(branchError.details.code, 'workspace_branch_changed');
    assert.equal(branchError.workspace.branch, 'gidd-issue-7');
    assert.deepEqual(branchError.details, { code: 'workspace_branch_changed', path: acquired.workspace.path, expected_branch: 'gidd-issue-7', actual_branch: 'codex/changed' });
    s.native(['switch', 'gidd-issue-7'], acquired.workspace.path);
    assert.equal(json(cli(['worktree.remove', acquired.workspace.path])).details.code, 'worktree_not_released');
    assert.equal((await s.command('cleanup', ['gidd-issue-7'], {
      execute: (exe, args, options) => runCommand(s.git, args, options),
    })).local_branch_deleted, true);
    const released = json(ok(cli(['worktree.show', acquired.workspace.path])));
    assert.equal(released.workspace.state, 'available'); assert.equal(released.workspace.release_commit, acquired.workspace.start_commit);
    assert.equal(json(cli(['7'])).details.code, 'workspace_released');
    assert.equal(json(cli(['worktree.remove', relative(s.target, acquired.workspace.path)])).details.code, 'task_cleanup_pending');
    ok(cli(['7.cleanup']));
    assert.equal(json(ok(cli(['worktree.remove', relative(s.target, acquired.workspace.path)]))).removed, true);
    define(8, 'direct-commit');
    ok(cli(['8', '--flow', '00/00']));
    const contextPath = join(s.state, '8/state.json'), beforeDuplicate = readFileSync(contextPath, 'utf8');
    assert.equal(json(ok(cli(['8', '--flow', '00/00']))).workspace.path, s.target);
    ok(cli(['8.flow.set', '00/04']));
    assert.match(ok(cli(['8.flow', '--lang', 'zh'])).stdout, /\| commit \| ask \|/);
    assert.equal(json(cli(['8.flow.set', '01/00'])).details.code, 'task_flow_mode_locked');
    assert.equal(JSON.parse(readFileSync(contextPath, 'utf8')).github_account, JSON.parse(beforeDuplicate).github_account);
    assert.equal(json(cli(['7.workspace'])).details.code, 'invalid_arguments');
    for (const route of ['workflow.gh.auth', 'workflow.issue', 'workflow.workspace', 'workflow.push', 'workflow.merge', 'workflow.target-sync', 'workflow.close-issue', 'workflow.cleanup'])
      assert.equal(json(cli([route])).details.code, 'unknown_command');
    for (const route of ['worktree.acquire', 'worktree.cleanup']) assert.equal(json(cli([route])).details.code, 'invalid_arguments');
  } finally { s.dispose(); }
});
