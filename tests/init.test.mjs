import { test } from 'node:test';
import { realpathSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { main } from '../.agents/skills/gidd/scripts.js/gidd.mjs';
import { initializeRepository } from '../.agents/skills/gidd/scripts.js/shared/repository-data.mjs';
import { readConfiguration } from '../.agents/skills/gidd/scripts.js/shared/config.mjs';
import { acquireStorageLock } from '../.agents/skills/gidd/scripts.js/shared/managed-storage.mjs';
import { assert, bindFixture, existsSync, findGit, fixture, join, mkdirSync, ok, readFileSync, readdirSync, run, snapshot, toolsRoot, write } from './support/helpers.mjs';

function setup() {
  const f = fixture(), git = findGit();
  let repository = join(f.root, 'repo spaces & 中文');
  mkdirSync(repository); repository = realpathSync.native(repository);
  ok(run(git, ['init', '--quiet', repository])); bindFixture(f.root, { git });
  const config = join(toolsRoot(f.root), 'config.toml'), data = repository + '.gidd';
  const invoke = async args => {
    const log = console.log, error = console.error, messages = [], previousDirectory = process.cwd();
    console.log = value => messages.push(value); console.error = () => {};
    process.chdir(repository);
    try { const code = await main(args, { boundRepository: repository }); return { code, report: JSON.parse(messages.at(-1)) }; }
    finally { process.chdir(previousDirectory); console.log = log; console.error = error; }
  };
  return { ...f, repository, config, data, invoke, initialize: () => initializeRepository(repository) };
}

test('internal initialization preserves configuration, records and resources on repeat', async () => {
  const s = setup();
  try {
    assert.equal(existsSync(s.config), false);
    const first = await s.initialize();
    assert.equal(first.path, s.data); assert.equal(realpathSync.native(first.main), s.repository);
    const settings = readConfiguration(s.repository);
    for (const key of ['repo', 'flow', 'git']) assert.equal(Object.hasOwn(settings, key), false);
    assert.deepEqual(settings.ui, {});
    const owner = readFileSync(join(s.data, 'storage.json'));
    assert.equal(existsSync(s.config), false, 'Data initialization does not create user preferences');
    const customized = 'schema_version = 1\n# user comment\n';
    write(s.config, customized);
    const before = snapshot(s.root);
    await s.initialize();
    assert.deepEqual(snapshot(s.root), before);
    assert.deepEqual(readFileSync(join(s.data, 'storage.json')), owner);
    assert.equal((await s.initialize()).path, s.data);
    assert.equal(Object.hasOwn(readConfiguration(s.repository), 'git'), false);
  } finally { s.dispose(); }
});

test('doctor and invalid first task requests leave data absent without a setup command', async () => {
  const s = setup();
  try {
    write(s.config, 'schema_version = 1\n');
    const before = snapshot(s.root);
    const report = (await s.invoke(['doctor', '--offline', '--lang', 'en'])).report;
    const item = report.checks.find(row => row.id === 'folder.gidd');
    assert.equal(item.status, 'ready'); assert.equal(item.details.code, 'data_missing');
    assert.equal(item.severity, 'info');
    assert.equal((await s.invoke(['worktree.list'])).report.details.code, 'data_missing');
    assert.deepEqual(snapshot(s.root), before);
    for (const args of [['1', '--flow'], ['1.workspace', '--flow', '00/00']])
      assert.equal((await s.invoke(args)).report.details.code, 'invalid_arguments');
    assert.deepEqual(snapshot(s.root), before);
    await s.initialize();
    assert.equal(existsSync(join(s.data, 'flow-history.jsonl')), false);
    const after = (await s.invoke(['doctor', '--offline'])).report;
    assert.equal(after.checks.find(row => row.id === 'folder.gidd').status, 'ready');
  } finally { s.dispose(); }
});

test('internal initialization preserves occupied, damaged and locked data and does not read user preferences', async () => {
  const s = setup();
  try {
    mkdirSync(s.data); write(join(s.data, 'user.txt'), 'keep');
    await assert.rejects(s.initialize(), /data_needs_attention/);
    assert.equal(existsSync(s.config), false); unlinkSync(join(s.data, 'user.txt'));
    await s.initialize();
    const manifest = join(s.data, 'storage.json'), hidden = join(s.root, 'hidden');
    renameSync(manifest, hidden);
    const missingManifest = snapshot(s.root);
    await assert.rejects(s.initialize(), error => {
      assert.equal(error.message, 'data_needs_attention');
      assert.equal(error.dataReport.issues[0].code, 'data_manifest_missing');
      return true;
    });
    assert.deepEqual(snapshot(s.root), missingManifest); renameSync(hidden, manifest);
    const lock = join(s.data, '.lock');
    const lease = acquireStorageLock({ lock });
    try { await assert.rejects(s.initialize(), /data_locked/); }
    finally { lease.release(); }
    write(s.config, 'broken TOML'); const before = snapshot(s.root);
    await s.initialize(); assert.deepEqual(snapshot(s.root), before);
  } finally { s.dispose(); }
});

test('removed init route rejects calls before tool discovery and creates no data', async () => {
  const s = setup();
  try {
    unlinkSync(join(toolsRoot(s.root), 'tool-bindings.json'));
    const before = snapshot(s.root);
    for (const args of [['init'], ['init', '--force']]) {
      const result = await s.invoke(args);
      assert.equal(result.code, 2); assert.equal(result.report.schema, 'gidd.cli/v1');
      assert.equal(result.report.details.code, 'unknown_command');
    }
    assert.equal(existsSync(s.data), false); assert.deepEqual(snapshot(s.root), before);
  } finally { s.dispose(); }
});

test('storage locks reuse a nested lease, reject active owners and reclaim a dead owner', () => {
  const f = fixture(), storage = { lock: join(f.root, 'data/.lock') };
  try {
    const lease = acquireStorageLock(storage);
    try {
      assert.equal(acquireStorageLock(storage, lease), lease);
      const before = snapshot(f.root);
      const probe = process.kill;
      let entries;
      process.kill = (pid, signal) => { entries = readdirSync(join(f.root, 'data')); return probe(pid, signal); };
      try { assert.throws(() => acquireStorageLock(storage), /data_locked/); }
      finally { process.kill = probe; }
      assert.deepEqual(entries, ['.lock']);
      assert.deepEqual(snapshot(f.root), before);
    } finally { lease.release(); }
    assert.equal(existsSync(join(f.root, 'data')), false);
    const pid = Number(ok(run(process.execPath, ['-e', 'console.log(process.pid)'])).stdout.trim());
    mkdirSync(storage.lock, { recursive: true });
    const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    write(join(storage.lock, `owner-${token}.json`), JSON.stringify({ pid, token }));
    const recovered = acquireStorageLock(storage);
    try { assert.equal(readdirSync(storage.lock).length, 1); }
    finally { recovered.release(); }
    mkdirSync(storage.lock);
    acquireStorageLock(storage).release();
    assert.equal(existsSync(storage.lock), false);
    write(storage.lock, 'unknown owner');
    assert.throws(() => acquireStorageLock(storage), /data_locked/);
    assert.equal(readFileSync(storage.lock, 'utf8'), 'unknown owner');
  } finally { f.dispose(); }
});

test('stale lock reclamation and release cannot delete a replacement owner', () => {
  const f = fixture(), storage = { lock: join(f.root, 'data/.lock') };
  const probe = process.kill;
  let replacement;
  try {
    const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pid = 2147483000;
    write(join(storage.lock, `owner-${token}.json`), JSON.stringify({ pid, token }));
    process.kill = (owner, signal) => {
      if (owner !== pid) return probe(owner, signal);
      unlinkSync(join(storage.lock, `owner-${token}.json`)); rmdirSync(storage.lock);
      replacement = acquireStorageLock(storage);
      throw Object.assign(new Error('owner exited'), { code: 'ESRCH' });
    };
    assert.throws(() => acquireStorageLock(storage), /data_locked/);
    process.kill = probe;
    assert.equal(JSON.parse(readFileSync(join(storage.lock, readdirSync(storage.lock)[0]))).pid, process.pid);
    replacement.release(); replacement = undefined;
    const previous = acquireStorageLock(storage);
    unlinkSync(join(storage.lock, readdirSync(storage.lock)[0])); rmdirSync(storage.lock);
    replacement = acquireStorageLock(storage);
    previous.release();
    assert.throws(() => acquireStorageLock(storage), /data_locked/);
  } finally {
    process.kill = probe;
    replacement?.release(); f.dispose();
  }
});
