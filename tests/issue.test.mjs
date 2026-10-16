import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { issueCommand, parseIssueArguments } from '../.agents/skills/gidd/scripts.js/commands/issue/index.mjs';
import { createPendingPath, newCreatePending, readCreatePending, sameCreationRequest,
  saveCreatePending } from '../.agents/skills/gidd/scripts.js/shared/create-pending.mjs';
import { policySnapshot } from '../.agents/skills/gidd/scripts.js/shared/policy-definition.mjs';
import { readPolicy } from '../.agents/skills/gidd/scripts.js/shared/policies.mjs';
import { completeTaskRegistration } from '../.agents/skills/gidd/scripts.js/shared/task-registration.mjs';
import { issuePath, readTask, taskPath, readDraft } from '../.agents/skills/gidd/scripts.js/shared/task-records.mjs';
import { readPolicyHistory } from '../.agents/skills/gidd/scripts.js/shared/policy-history.mjs';
import { assert, fixture, join, repo, run, ok, bindFixture, findGit, existsSync,
  initializeDataFixture, readFileSync, write } from './support/helpers.mjs';

test('Issue creation accepts file and policy flags and rejects other command domains', () => {
  assert.deepEqual(parseIssueArguments('issue', ['--file', 'draft notes.md', '--policy', '00/00']),
    { action: 'create', file: 'draft notes.md', policy: '00/00' });
  for (const args of [[], ['7'], ['7', '--policy', '00/00'], ['--file', ''],
    ['--file', 'draft', '--file', 'other'], ['--file', 'draft', '--policy', '--bad'], ['--file', 'draft', '--spec', '00/00'],
    ['--file', 'draft', '--flow', '00/00'],
    ['--file', 'draft', '--policy', '00/00', '--policy', '01/00'], ['--file', 'draft', '--unknown', 'value']])
    assert.throws(() => parseIssueArguments('issue', args), /invalid_arguments/);
  for (const route of ['gh.auth', '7', '7.workspace', '7.policy', 'task'])
    assert.throws(() => parseIssueArguments(route, ['--file', 'draft']), /invalid_arguments/);
});

test('Issue CLI checks the draft before login or initializing repository data', () => {
  const f = fixture();
  try {
    const target = join(f.root, 'repo'), git = findGit();
    bindFixture(f.root, { git });
    ok(run(git, ['init', '-b', 'main', target]));
    const entry = pathToFileURL(join(repo, '.agents/skills/gidd/scripts.js/gidd.mjs')).href;
    const result = run(process.execPath, ['--input-type=module', '-e',
      `const {main}=await import(${JSON.stringify(entry)}); process.exitCode=await main(['issue','--file','missing.md','--policy','00/00'],{boundRepository:process.argv[1]});`, target], { cwd: target });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).details.code, 'issue_draft_missing');
    assert.equal(existsSync(target + '.gidd'), false);
  } finally { f.dispose(); }
});

function creationPlan() {
  const policy = policySnapshot(readPolicy('00/00'));
  return { schema: 'gidd.task/v1', target_branch: 'main', policy, github_account: 'tester',
    delivery: { mode: policy.mode, remote: {
      fetch: { repository: 'https://github.com/test/repo', branch: 'main' },
      push: { repository: 'https://github.com/test/repo' },
    } } };
}

test('creation intent retains the frozen plan and matches only the same source, content and policy', () => {
  const f = fixture();
  try {
    initializeDataFixture(f.root);
    const storage = { path: f.root + '.gidd' }, source = join(f.root, 'draft.md');
    write(source, '\uFEFF# Create\r\nAcceptance');
    assert.equal(readCreatePending(storage), null);
    const original = readFileSync(source), hash = readDraft(source).sha256;
    const pending = newCreatePending(source, hash, '00/00', creationPlan());
    saveCreatePending(storage, pending);
    const restored = readCreatePending(storage);
    assert.deepEqual(restored, pending);
    assert.equal(sameCreationRequest(restored, source, hash, '00/00'), true);
    assert.equal(sameCreationRequest(restored, join(f.root, 'other.md'), hash, '00/00'), false);
    assert.equal(sameCreationRequest(restored, source, hash, '00/01'), false);
    write(source, '# Changed\nAcceptance');
    assert.equal(sameCreationRequest(restored, source, readDraft(source).sha256, '00/00'), false);
    write(source, original);
    assert.deepEqual(readFileSync(source), original);
    assert.equal(Object.hasOwn(restored, 'body'), false);
  } finally { f.dispose(); }
});

test('creation phases distinguish an uncertain POST from a confirmed Issue and reject malformed records', () => {
  const f = fixture();
  try {
    initializeDataFixture(f.root);
    const storage = { path: f.root + '.gidd' }, source = join(f.root, 'draft.md');
    write(source, '# Create\nAcceptance');
    const pending = newCreatePending(source, readDraft(source).sha256, '00/00', creationPlan());
    pending.phase = 'creating'; saveCreatePending(storage, pending);
    assert.equal(readCreatePending(storage).task.issue, undefined);
    pending.phase = 'created';
    assert.throws(() => saveCreatePending(storage, pending), /issue_creation_record_invalid/);
    pending.task.issue = 42; saveCreatePending(storage, pending);
    assert.equal(readCreatePending(storage).task.issue, 42);
    pending.phase = 'ready'; saveCreatePending(storage, pending);
    assert.equal(readCreatePending(storage).phase, 'ready');
    const { policy, ...withoutPolicy } = pending, { policy: taskPolicy, ...withoutTaskPolicy } = pending.task;
    for (const malformed of [{ ...pending, task: { ...pending.task, github_account: '-invalid' } },
      { ...pending, task: { ...pending.task, registration: { id: pending.request, complete: true } } },
      { ...withoutPolicy, flow: policy }, { ...pending, flow: policy },
      { ...pending, task: { ...withoutTaskPolicy, flow: taskPolicy } },
      { ...pending, task: { ...pending.task, flow: taskPolicy } },
      { ...pending, phase: 'creating' }, { ...pending, source: 'relative.md' },
      { ...pending, sha256: 'bad' }, { ...pending, body: 'unexpected' }]) {
      write(createPendingPath(storage), JSON.stringify(malformed));
      assert.throws(() => readCreatePending(storage), /issue_creation_record_invalid/);
    }
    write(createPendingPath(storage), '{');
    assert.throws(() => readCreatePending(storage), /issue_creation_record_invalid/);
  } finally { f.dispose(); }
});

test('an uncertain creation blocks repeated POSTs and different drafts before authentication', async () => {
  const f = fixture();
  try {
    const target = join(f.root, 'repo'), git = findGit();
    bindFixture(f.root, { git });
    ok(run(git, ['init', '-b', 'main', target]));
    initializeDataFixture(target);
    const storage = { path: target + '.gidd' }, source = join(f.root, 'draft.md');
    write(source, '# Create\nAcceptance');
    const pending = newCreatePending(source, readDraft(source).sha256, '00/00', creationPlan());
    pending.phase = 'creating'; saveCreatePending(storage, pending);
    const original = readFileSync(createPendingPath(storage), 'utf8');
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(issueCommand(target, { action: 'create', file: source, policy: '00/00' }, { cwd: target }), /issue_creation_unconfirmed/);
    const other = join(f.root, 'other.md'); write(other, '# Other\nAcceptance');
    await assert.rejects(issueCommand(target, { action: 'create', file: other, policy: '00/00' }, { cwd: target }), /issue_creation_pending/);
    assert.equal(readFileSync(createPendingPath(storage), 'utf8'), original);
    assert.equal(existsSync(join(storage.path, '.lock')), false);
  } finally { f.dispose(); }
});

test('registration resumes a failed history write without replacing the Issue copy or duplicating history', () => {
  const f = fixture();
  try {
    initializeDataFixture(f.root);
    const storage = { path: f.root + '.gidd', initialized: true }, task = { ...creationPlan(), issue: 42 };
    const history = join(storage.path, 'policy-history.jsonl');
    fs.mkdirSync(history);
    assert.throws(() => completeTaskRegistration(storage, task, '# Create\nAcceptance'), /policy_history_invalid/);
    assert.equal(readTask(storage, 42).registration.complete, false);
    assert.equal(readFileSync(issuePath(storage, 42), 'utf8'), '# Create\nAcceptance');
    fs.rmdirSync(history);
    const saved = completeTaskRegistration(storage, task, '# Other\nReplacement');
    assert.equal(saved.registration.complete, true);
    assert.equal(readFileSync(issuePath(storage, 42), 'utf8'), '# Create\nAcceptance');
    assert.deepEqual(completeTaskRegistration(storage, task), saved);
    assert.equal(readPolicyHistory(storage).length, 1);
  } finally { f.dispose(); }
});

test('registration rejects an occupied Issue copy path and repairs a missing completed copy', () => {
  const f = fixture();
  try {
    initializeDataFixture(f.root);
    const storage = { path: f.root + '.gidd', initialized: true }, task = { ...creationPlan(), issue: 42 };
    const copy = issuePath(storage, 42);
    fs.mkdirSync(copy, { recursive: true });
    assert.throws(() => completeTaskRegistration(storage, task, '# Create\nAcceptance'), /issue_draft_invalid/);
    assert.equal(existsSync(taskPath(storage, 42)), false);
    fs.rmdirSync(copy);
    const first = completeTaskRegistration(storage, task, '# Create\nAcceptance');
    fs.unlinkSync(copy);
    const restored = completeTaskRegistration(storage, task, '# Restored\nAcceptance');
    assert.equal(restored.registration.complete, true);
    assert.equal(restored.registration.id, first.registration.id);
    assert.equal(readFileSync(copy, 'utf8'), '# Restored\nAcceptance');
    assert.equal(readPolicyHistory(storage).length, 1);
  } finally { f.dispose(); }
});

test('registration replays a committed history event after its final task save fails', {
  skip: process.versions.bun ? 'Bun does not update named fs exports for rename fault injection' : false,
}, () => {
  const f = fixture(), rename = fs.renameSync;
  try {
    initializeDataFixture(f.root);
    const storage = { path: f.root + '.gidd', initialized: true }, task = { ...creationPlan(), issue: 42 };
    let stateWrites = 0;
    fs.renameSync = (source, destination) => {
      if (destination === taskPath(storage, 42) && ++stateWrites === 2)
        throw Object.assign(new Error('fixture_state_save_failed'), { code: 'EPERM' });
      return rename(source, destination);
    };
    syncBuiltinESMExports();
    assert.throws(() => completeTaskRegistration(storage, task, '# Create\nAcceptance'), /fixture_state_save_failed/);
    fs.renameSync = rename; syncBuiltinESMExports();
    const before = readPolicyHistory(storage);
    assert.equal(before.length, 1);
    const partial = readTask(storage, 42);
    assert.equal(partial.registration.complete, false);
    const complete = completeTaskRegistration(storage, task);
    assert.equal(complete.registration.id, partial.registration.id);
    assert.equal(complete.registration.complete, true);
    assert.deepEqual(readPolicyHistory(storage), before);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); f.dispose(); }
});
