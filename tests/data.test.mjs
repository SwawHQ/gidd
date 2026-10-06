import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { initializeRepository } from '../.agents/skills/gidd/scripts.js/commands/init.mjs';
import { doctor } from '../.agents/skills/gidd/scripts.js/commands/doctor/index.mjs';
import { worktreeCommand } from '../.agents/skills/gidd/scripts.js/commands/worktree/index.mjs';
import { main } from '../.agents/skills/gidd/scripts.js/gidd.mjs';
import { parseConfiguration } from '../.agents/skills/gidd/scripts.js/shared/storage.mjs';
import { assert, bindFixture, existsSync, findGit, fixture, join, mkdirSync, ok, readFileSync, run, snapshot, write } from './support/helpers.mjs';

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
  write(config, 'schema_version = 1\n[repo]\nremote.name = "origin"\n');
  const check = async () => (await doctor(target, { offline: true, fixedRepository: true, lang: 'en' })).checks.find(item => item.id === 'folder.gidd');
  return { ...f, target, native, config, data, check,
    init: () => initializeRepository(target),
    acquire: branch => worktreeCommand(target, { action: 'acquire', branch, base: 'main', issue: 1,
      workflow: { mode: 'direct-merge', remote: 'origin', identity: 'https://github.com/test/repo' } }),
    record: id => join(data, 'state/worktrees', id + '.json') };
}

const hasIssue = (report, reason, path) => report.details.issues.some(item => item.reason === reason && (!path || item.path === path));

test('fixed data is initialized explicitly; linked entries share it and new worktrees use absolute GIDD paths', async () => {
  const s = installation();
  try {
    const before = snapshot(s.root);
    assert.equal((await s.check()).reason, 'data_missing'); assert.deepEqual(snapshot(s.root), before);
    const config = readFileSync(s.config); await s.init(); assert.deepEqual(readFileSync(s.config), config);
    s.native(['config', 'worktree.useRelativePaths', 'true']);
    const a = await s.acquire('codex/one');
    assert.match(a.id, /^gidd-wt-/); assert.equal(a.path, join(s.data, a.id));
    assert.match(readFileSync(join(a.path, '.git'), 'utf8'), /^gitdir: [A-Za-z]:[\\/]/);
    const linked = await initializeRepository(a.path);
    assert.equal(linked.data_path, s.data); assert.equal(existsSync(a.path + '.gidd'), false);
    assert.equal((await s.check()).status, 'ready');
    const stable = snapshot(s.root); await s.init(); assert.deepEqual(snapshot(s.root), stable);
  } finally { s.dispose(); }
});

test('misplaced GIDD registrations block initialization before data creation; ordinary and old names are ignored', async () => {
  const s = installation();
  try {
    for (const name of ['manual-worktree', 'wt-' + randomUUID()])
      s.native(['worktree', 'add', '-b', name, join(s.root, name), 'main']);
    assert.equal((await s.check()).reason, 'data_missing');
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

test('doctor reports missing, unregistered and damaged records together even with a damaged manifest or config', async () => {
  const s = installation();
  try {
    await s.init();
    const a = await s.acquire('codex/missing'), b = await s.acquire('codex/broken'), c = await s.acquire('codex/unregistered');
    renameSync(a.path, join(s.root, 'hidden-worktree'));
    write(s.record(b.id), '{broken');
    s.native(['worktree', 'remove', c.path]);
    write(join(s.data, 'state/storage.json'), '{broken');
    write(s.config, 'invalid TOML');
    const before = snapshot(s.root), report = await s.check();
    assert.ok(hasIssue(report, 'data_record_invalid'));
    assert.ok(hasIssue(report, 'worktree_record_invalid', s.record(b.id)));
    assert.ok(hasIssue(report, 'worktree_missing', a.path));
    assert.ok(hasIssue(report, 'worktree_unregistered', c.path));
    assert.equal(report.details.worktrees.length, 3); assert.deepEqual(snapshot(s.root), before);
  } finally { s.dispose(); }
});

test('renamed repositories fail ownership and path checks; init preserves resources without adopting them', async () => {
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

test('removed path settings and relocation commands are rejected without writing data', async () => {
  const s = installation(), originalLog = console.log, originalError = console.error;
  try {
    const before = snapshot(s.root), messages = []; console.log = message => messages.push(message); console.error = () => {};
    for (const args of [['set', 'repo.data.path', join(s.root, 'elsewhere')], ['clear', 'repo.data.path'], ['data.move', join(s.root, 'elsewhere')]]) {
      assert.equal(await main(args, { boundRepository: s.target }), 2);
      assert.match(JSON.parse(messages.at(-1)).reason, /config_unknown_key|unknown_command/);
    }
    assert.throws(() => parseConfiguration('schema_version = 1\n[repo]\ndata.path = "D:/old"\n'), /config_unsupported/);
    assert.deepEqual(snapshot(s.root), before);
  } finally { console.log = originalLog; console.error = originalError; s.dispose(); }
});
