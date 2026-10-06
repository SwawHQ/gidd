import { test } from 'node:test';
import { realpathSync, renameSync, unlinkSync } from 'node:fs';
import { main } from '../.agents/skills/gidd/scripts.js/gidd.mjs';
import { readConfiguration } from '../.agents/skills/gidd/scripts.js/shared/config.mjs';
import { assert, bindFixture, existsSync, findGit, fixture, join, mkdirSync, ok, readFileSync, run, snapshot, write } from './support/helpers.mjs';

function setup() {
  const f = fixture(), git = findGit();
  let repository = join(f.root, 'repo spaces & 中文');
  mkdirSync(repository); repository = realpathSync.native(repository);
  ok(run(git, ['init', '--quiet', repository])); bindFixture(f.root, { git });
  const config = join(repository, '.agents/skills/gidd/config.toml'), data = repository + '.gidd';
  const invoke = async args => {
    const log = console.log, error = console.error, messages = [];
    console.log = value => messages.push(value); console.error = () => {};
    try { const code = await main(args, { boundRepository: repository }); return { code, report: JSON.parse(messages.at(-1)) }; }
    finally { console.log = log; console.error = error; }
  };
  return { ...f, repository, config, data, invoke };
}

test('init prepares fixed local data and preserves configuration, records and resources on repeat', async () => {
  const s = setup();
  try {
    assert.equal(existsSync(s.config), false);
    const first = await s.invoke(['init']);
    assert.equal(first.code, 0); assert.equal(first.report.schema, 'gidd.init/v1');
    assert.equal(first.report.data_path, s.data);
    const settings = readConfiguration(s.repository);
    assert.equal(settings.repo.data, undefined);
    assert.deepEqual(settings.git, { user: {}, credential: {} }); assert.deepEqual(settings.spec, {});
    const owner = readFileSync(join(s.data, 'state/storage.json'));
    const customized = readFileSync(s.config, 'utf8') + '# user comment\n[git]\nuser.mode = "inherit"\ncredential.mode = "inherit"\n';
    write(s.config, customized);
    const before = snapshot(s.root);
    assert.equal((await s.invoke(['init'])).code, 0);
    assert.deepEqual(snapshot(s.root), before);
    assert.deepEqual(readFileSync(join(s.data, 'state/storage.json')), owner);
    assert.equal((await s.invoke(['init'])).report.data_path, s.data);
    assert.equal(readConfiguration(s.repository).git.user.mode, 'inherit');
  } finally { s.dispose(); }
});

test('doctor and normal operations report missing fixed data without initializing it', async () => {
  const s = setup();
  try {
    write(s.config, 'schema_version = 1\n[repo]\nremote.name = "origin"\n');
    const before = snapshot(s.root);
    const report = (await s.invoke(['doctor', '--offline', '--lang', 'en'])).report;
    const item = report.checks.find(row => row.id === 'folder.gidd');
    assert.equal(item.status, 'missing'); assert.equal(item.reason, 'data_missing');
    assert.match(item.hint, /gidd\.link init/);
    assert.equal((await s.invoke(['worktree.list'])).report.reason, 'data_missing');
    assert.deepEqual(snapshot(s.root), before);
    assert.equal((await s.invoke(['init'])).code, 0);
    const after = (await s.invoke(['doctor', '--offline'])).report;
    assert.equal(after.checks.find(row => row.id === 'folder.gidd').status, 'ready');
  } finally { s.dispose(); }
});

test('init preserves occupied, damaged, locked and malformed state and rejects arguments', async () => {
  const s = setup();
  try {
    mkdirSync(s.data); write(join(s.data, 'user.txt'), 'keep');
    assert.equal((await s.invoke(['init'])).report.reason, 'data_needs_attention');
    assert.equal(existsSync(s.config), false); unlinkSync(join(s.data, 'user.txt'));
    assert.equal((await s.invoke(['init'])).code, 0);
    const manifest = join(s.data, 'state/storage.json'), hidden = join(s.root, 'hidden');
    renameSync(manifest, hidden);
    const missingManifest = snapshot(s.root), failed = await s.invoke(['init']);
    assert.equal(failed.report.reason, 'data_needs_attention');
    assert.equal(failed.report.details.issues[0].reason, 'data_manifest_missing');
    assert.deepEqual(snapshot(s.root), missingManifest); renameSync(hidden, manifest);
    write(s.config + '.lock', JSON.stringify({ pid: process.pid }));
    assert.equal((await s.invoke(['init'])).report.reason, 'data_locked'); unlinkSync(s.config + '.lock');
    write(s.config, 'broken TOML'); const before = snapshot(s.root);
    assert.notEqual((await s.invoke(['init'])).code, 0); assert.deepEqual(snapshot(s.root), before);
    assert.equal((await s.invoke(['init', '--force'])).report.reason, 'invalid_arguments');
  } finally { s.dispose(); }
});
