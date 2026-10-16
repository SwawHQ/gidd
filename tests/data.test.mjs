import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { initializeRepository } from '../.agents/skills/gidd/scripts.js/shared/repository-data.mjs';
import { inspectData } from '../.agents/skills/gidd/scripts.js/shared/data-inspection.mjs';
import { locateStorage } from '../.agents/skills/gidd/scripts.js/shared/managed-storage.mjs';
import { doctor } from '../.agents/skills/gidd/scripts.js/commands/doctor/index.mjs';
import { worktreeCommand } from '../.agents/skills/gidd/scripts.js/commands/worktree/index.mjs';
import { main } from '../.agents/skills/gidd/scripts.js/gidd.mjs';
import { parseConfiguration } from '../.agents/skills/gidd/scripts.js/shared/storage.mjs';
import { runCommand } from '../.agents/skills/gidd/scripts.js/shared/process.mjs';
import { newCreatePending, saveCreatePending, createPendingPath } from '../.agents/skills/gidd/scripts.js/shared/create-pending.mjs';
import { readDraft } from '../.agents/skills/gidd/scripts.js/shared/task-records.mjs';
import { readPolicy } from '../.agents/skills/gidd/scripts.js/shared/policies.mjs';
import { policySnapshot } from '../.agents/skills/gidd/scripts.js/shared/policy-definition.mjs';
import { assert, bindFixture, existsSync, findGit, fixture, join, mkdirSync, ok, readFileSync, run, snapshot, write, writeResource } from './support/helpers.mjs';

function installation() {
  const f = fixture(), git = findGit();
  const target = join(f.root, 'repo spaces'); mkdirSync(target);
  const native = (args, cwd = target) => ok(run(git, ['-C', cwd, ...args])).stdout.trim();
  native(['init', '-b', 'main']);
  native(['config', 'core.autocrlf', 'false']);
  native(['config', 'user.name', 'Fixture']); native(['config', 'user.email', 'fixture@example.test']);
  write(join(target, 'tracked.txt'), 'content\n'); native(['add', '.']); native(['commit', '-m', 'initial']);
  bindFixture(f.root, { git });
  const config = join(target, '.agents/skills/gidd/config.toml'), data = target + '.gidd';
  write(config, 'schema_version = 1\n');
  const check = async () => (await doctor(target, { offline: true, fixedRepository: true, lang: 'en' })).checks.find(item => item.id === 'folder.gidd');
  return { ...f, target, native, config, data, check,
    init: () => initializeRepository(target),
    acquire: (branch, dependencies) => worktreeCommand(target, { action: 'acquire', branch, base: 'main', issue: 1,
      delivery: { mode: 'direct-merge', remote: { fetch: { repository: 'https://github.com/test/repo', branch: 'main' }, push: { repository: 'https://github.com/test/repo' } } } }, dependencies),
    record: () => join(data, 'storage.json'), writeRecord: (id, text) => writeResource(data, id, text) };
}

const hasIssue = (report, reason, path) => report.details.issues.some(item => item.code === reason && (!path || item.path === path));

test('data inspection reads each worktree path once and rejects incomplete metadata', async () => {
  const s = installation();
  try {
    await s.init(); const workspace = await s.acquire('codex/paths');
    const native = async (path, args) => s.native(args, path);
    const storage = await locateStorage(s.target, native), calls = [];
    let incomplete = false;
    const git = async (path, args) => {
      calls.push({ path, args });
      return incomplete ? workspace.path : native(path, args);
    };
    const before = snapshot(s.root);
    assert.deepEqual((await inspectData(storage, git)).issues, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, workspace.path);
    incomplete = true;
    const report = await inspectData(storage, git);
    assert.ok(report.issues.some(item => item.code === 'worktree_repository_mismatch' && item.path === workspace.path));
    assert.deepEqual(snapshot(s.root), before);
  } finally { s.dispose(); }
});

test('doctor reports a durable allocation intent without treating its uncreated checkout as missing', async () => {
  const s = installation();
  try {
    await s.init();
    await assert.rejects(s.acquire('codex/pending', { execute: async (exe, args, options) => {
      if (args.includes('worktree') && args.includes('add')) throw new Error('interrupted');
      return runCommand(exe, args, options);
    } }), /interrupted/);
    const before = snapshot(s.root), report = await s.check();
    assert.ok(hasIssue(report, 'worktree_preparation_pending'));
    assert.equal(hasIssue(report, 'worktree_unregistered'), false);
    assert.equal(hasIssue(report, 'worktree_missing'), false);
    assert.deepEqual(snapshot(s.root), before);
    await s.acquire('codex/pending');
    assert.equal((await s.check()).status, 'ready');
  } finally { s.dispose(); }
});

test('doctor distinguishes pending Issue creation, uncertain remote outcome and malformed creation records', async () => {
  const s = installation();
  try {
    await s.init();
    const storage = { path: s.data }, source = join(s.root, 'draft.md'), policy = policySnapshot(readPolicy('00/00'));
    write(source, '# Create\nAcceptance');
    const pending = newCreatePending(source, readDraft(source).sha256, '00/00', {
      schema: 'gidd.task/v1', target_branch: 'main', policy, github_account: 'tester',
      delivery: { mode: policy.mode, remote: { fetch: { repository: 'https://github.com/test/repo', branch: 'main' },
        push: { repository: 'https://github.com/test/repo' } } },
    });
    for (const phase of ['planned', 'creating', 'created', 'ready']) {
      pending.phase = phase;
      if (['created', 'ready'].includes(phase)) pending.task.issue = 42;
      saveCreatePending(storage, pending);
      const before = snapshot(s.root), report = await s.check();
      if (phase === 'ready') assert.equal(report.status, 'ready');
      else assert.ok(hasIssue(report, phase === 'creating' ? 'issue_creation_unconfirmed' : 'issue_creation_pending', createPendingPath(storage)));
      assert.deepEqual(snapshot(s.root), before);
    }
    write(createPendingPath(storage), '{broken');
    assert.ok(hasIssue(await s.check(), 'issue_creation_record_invalid', createPendingPath(storage)));
  } finally { s.dispose(); }
});

test('doctor reports incomplete task registration and target preparation without changing saved evidence', async () => {
  const s = installation();
  try {
    await s.init();
    const policy = policySnapshot(readPolicy('00/00')), start = s.native(['rev-parse', 'main']), path = join(s.data, '42/state.json');
    const task = { schema: 'gidd.task/v1', issue: 42, target_branch: 'main', policy, github_account: 'tester',
      registration: { id: randomUUID(), complete: false }, preparation: { start_commit: start, previous_commit: start },
      delivery: { mode: policy.mode, remote: { fetch: { repository: 'https://github.com/test/repo', branch: 'main' },
        push: { repository: 'https://github.com/test/repo' } } },
    };
    write(path, JSON.stringify(task));
    const before = snapshot(s.root), report = await s.check();
    assert.ok(hasIssue(report, 'task_registration_pending', path));
    assert.ok(hasIssue(report, 'worktree_preparation_pending', path));
    assert.deepEqual(snapshot(s.root), before);
    task.registration.complete = true; delete task.preparation;
    write(path, JSON.stringify(task));
    assert.equal((await s.check()).status, 'ready');
  } finally { s.dispose(); }
});

test('internal initialization shares fixed data between linked entries and new worktrees use absolute GIDD paths', async () => {
  const s = installation();
  try {
    const before = snapshot(s.root);
    assert.equal((await s.check()).details.code, 'data_missing'); assert.deepEqual(snapshot(s.root), before);
    const config = readFileSync(s.config); await s.init(); assert.deepEqual(readFileSync(s.config), config);
    s.native(['config', 'worktree.useRelativePaths', 'true']);
    const a = await s.acquire('codex/one');
    assert.match(a.id, /^gidd-wt-/); assert.equal(a.path, join(s.data, a.id));
    assert.match(readFileSync(join(a.path, '.git'), 'utf8'), /^gitdir: [A-Za-z]:[\\/]/);
    const linked = await initializeRepository(a.path);
    assert.equal(linked.path, s.data); assert.equal(existsSync(a.path + '.gidd'), false);
    assert.equal((await s.check()).status, 'ready');
    const stable = snapshot(s.root); await s.init(); assert.deepEqual(snapshot(s.root), stable);
  } finally { s.dispose(); }
});

test('misplaced GIDD registrations block initialization before data creation; ordinary and old names are ignored', async () => {
  const s = installation();
  try {
    for (const name of ['manual-worktree', 'wt-' + randomUUID()])
      s.native(['worktree', 'add', '-b', name, join(s.root, name), 'main']);
    assert.equal((await s.check()).details.code, 'data_missing');
    const id = 'gidd-wt-' + randomUUID(), outside = join(s.root, id);
    s.native(['worktree', 'add', '-b', 'outside', outside, 'main']);
    const before = snapshot(s.root), result = await s.check();
    assert.equal(result.status, 'invalid');
    assert.equal(result.details.worktrees.length, 1);
    assert.ok(hasIssue(result, 'worktree_path_mismatch', outside));
    assert.equal(result.details.worktrees[0].expected_path, join(s.data, id));
    await assert.rejects(s.init(), error => error.message === 'data_needs_attention' && error.dataReport.worktrees.length === 1);
    assert.equal(existsSync(s.data), false); assert.deepEqual(snapshot(s.root), before);
  } finally { s.dispose(); }
});

test('doctor reports missing, unregistered and damaged records together even with invalid config', async () => {
  const s = installation();
  try {
    await s.init();
    const a = await s.acquire('codex/missing'), b = await s.acquire('codex/broken'), c = await s.acquire('codex/unregistered');
    renameSync(a.path, join(s.root, 'hidden-worktree'));
    s.writeRecord(b.id, '{broken');
    s.native(['worktree', 'remove', c.path]);
    write(s.config, 'invalid TOML');
    const before = snapshot(s.root), report = await s.check();
    assert.ok(hasIssue(report, 'worktree_record_invalid', s.record(b.id)));
    assert.ok(hasIssue(report, 'worktree_missing', a.path));
    assert.ok(hasIssue(report, 'worktree_unregistered', c.path));
    assert.equal(report.details.worktrees.length, 3); assert.deepEqual(snapshot(s.root), before);
    write(s.record(), '{broken');
    const damaged = snapshot(s.root), result = await s.check();
    assert.ok(hasIssue(result, 'data_record_invalid'));
    assert.equal(result.details.worktrees.length, 2);
    assert.ok(result.details.worktrees.some(item => item.path === a.path && item.registered));
    assert.ok(result.details.worktrees.some(item => item.path === b.path && item.registered));
    assert.deepEqual(snapshot(s.root), damaged);
  } finally { s.dispose(); }
});

test('renamed repositories fail ownership and path checks; initialization preserves resources without adopting them', async () => {
  const s = installation();
  try {
    await s.init(); const a = await s.acquire('codex/rename');
    const next = join(s.root, 'renamed'); renameSync(s.target, next);
    const diagnose = async () => (await doctor(next, { offline: true, fixedRepository: true, lang: 'en' })).checks.find(item => item.id === 'folder.gidd');
    let report = await diagnose(); assert.ok(hasIssue(report, 'worktree_path_mismatch', a.path));
    await assert.rejects(initializeRepository(next), /data_needs_attention/);
    assert.equal(existsSync(next + '.gidd'), false);
    renameSync(s.data, next + '.gidd');
    const before = snapshot(s.root); report = await diagnose();
    assert.ok(hasIssue(report, 'data_repository_mismatch'));
    await assert.rejects(initializeRepository(next), /data_needs_attention/);
    assert.deepEqual(snapshot(s.root), before);
  } finally { s.dispose(); }
});

test('directory links and worktrees from another repository are diagnosed without following or modifying them', async () => {
  const s = installation();
  try {
    await s.init(); const a = await s.acquire('codex/link');
    const elsewhere = join(s.root, 'elsewhere'); renameSync(a.path, elsewhere);
    symlinkSync(elsewhere, a.path, 'junction');
    assert.ok(hasIssue(await s.check(), 'reparse_path', a.path));
    unlinkSync(a.path); renameSync(elsewhere, a.path);
    const other = join(s.root, 'other'); mkdirSync(other); s.native(['init', '-b', 'main'], other);
    s.native(['config', 'user.name', 'Fixture'], other); s.native(['config', 'user.email', 'fixture@example.test'], other);
    s.native(['commit', '--allow-empty', '-m', 'initial'], other);
    const foreign = join(s.data, 'gidd-wt-' + randomUUID()); s.native(['worktree', 'add', '-b', 'foreign', foreign, 'main'], other);
    const report = await s.check();
    assert.ok(hasIssue(report, 'worktree_unregistered', foreign)); assert.ok(hasIssue(report, 'worktree_repository_mismatch', foreign));
    assert.equal(readFileSync(join(a.path, 'tracked.txt'), 'utf8'), 'content\n');
  } finally { s.dispose(); }
});

test('doctor reports working branch records and diagnoses mismatches while accepting released detached worktrees', async () => {
  const s = installation();
  try {
    await s.init(); const workspace = await s.acquire('gidd-issue-1');
    await assert.rejects(worktreeCommand(s.target, { action: 'remove', path: workspace.path }), error => {
      assert.equal(error.message, 'worktree_not_released'); assert.equal(error.details, undefined);
      return true;
    });
    let report = await s.check();
    assert.equal(report.details.worktrees[0].branch, 'gidd-issue-1');
    assert.equal(Object.hasOwn(report.details.worktrees[0], 'checked_out_branch'), false);
    s.native(['checkout', '-b', 'manual-branch'], workspace.path);
    report = await s.check();
    const mismatch = report.details.issues.find(item => item.code === 'worktree_state_changed');
    assert.equal(mismatch.expected_branch, 'gidd-issue-1'); assert.equal(mismatch.actual_branch, 'manual-branch');
    assert.equal(report.details.worktrees[0].branch, 'gidd-issue-1');
    s.native(['switch', 'gidd-issue-1'], workspace.path);
    await worktreeCommand(s.target, { action: 'cleanup', path: workspace.path });
    assert.equal(hasIssue(await s.check(), 'worktree_state_changed'), false);
    s.native(['switch', 'manual-branch'], workspace.path);
    report = await s.check();
    const releasedMismatch = report.details.issues.find(item => item.code === 'worktree_state_changed');
    assert.equal(releasedMismatch.expected_branch, null); assert.equal(releasedMismatch.actual_branch, 'manual-branch');
    await assert.rejects(worktreeCommand(s.target, { action: 'remove', path: workspace.path }), /worktree_state_changed/);
    await assert.rejects(worktreeCommand(s.target, { action: 'cleanup', path: workspace.path }), error => {
      assert.equal(error.message, 'worktree_state_changed');
      assert.deepEqual(error.details, { path: workspace.path, expected_branch: null, actual_branch: 'manual-branch' });
      return true;
    });
  } finally { s.dispose(); }
});

test('removed path settings and relocation commands are rejected without writing data', async () => {
  const s = installation(), originalLog = console.log, originalError = console.error;
  try {
    const before = snapshot(s.root), messages = []; console.log = message => messages.push(message); console.error = () => {};
    for (const args of [['set', 'repo.data.path', join(s.root, 'elsewhere')], ['clear', 'repo.data.path'], ['data.move', join(s.root, 'elsewhere')]]) {
      assert.equal(await main(args, { boundRepository: s.target }), 2);
      assert.match(JSON.parse(messages.at(-1)).details.code, /config_unknown_key|unknown_command/);
    }
    assert.throws(() => parseConfiguration('schema_version = 1\n[repo]\ndata.path = "D:/old"\n'), /config_unsupported/);
    assert.deepEqual(snapshot(s.root), before);
  } finally { console.log = originalLog; console.error = originalError; s.dispose(); }
});
