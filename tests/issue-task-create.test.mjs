import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { unlinkSync, rmdirSync, symlinkSync } from 'node:fs';
import { workspaceReport } from '../.agents/skills/gidd/scripts.js/shared/workspace-report.mjs';
import { readTasks } from '../.agents/skills/gidd/scripts.js/shared/task-records.mjs';
import { readCreatePending } from '../.agents/skills/gidd/scripts.js/shared/create-pending.mjs';
import { assert, existsSync, join, mkdirSync, readFileSync, run, write } from './support/helpers.mjs';
import { installation, noPreparedResources } from './support/issue-task.mjs';

test('numeric recovery of a confirmed created Issue permits the next creation request', async (t) => {
  const s = installation(t);
  try {
    const first = join(s.root, 'first.md'), second = join(s.root, 'second.md');
    write(first, '# First\nAcceptance'); write(second, '# Second\nAcceptance');
    s.control.fetchFailure = true;
    await assert.rejects(s.invoke('issue', ['--file', first, '--policy', '01/00']), /delivery_remote_failed/);
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 1);
    s.control.fetchFailure = false;
    await s.command('cleanup', ['11']);
    await s.invoke('policy.set', ['11', '00/00']);
    await s.command('workspace', ['11', '--policy', '00/00']);
    const next = await s.invoke('issue', ['--file', second, '--policy', '01/00']);
    assert.equal(next.issue.number, 12);
    assert.equal(next.workspace.state, 'assigned');
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 2);
  } finally { await s.dispose(); }
});

test('cleanup can retire a confirmed creation that failed before allocation', async (t) => {
  const s = installation(t);
  try {
    const first = join(s.root, 'first.md'), second = join(s.root, 'second.md');
    write(first, '# First\nAcceptance'); write(second, '# Second\nAcceptance');
    s.native(['branch', 'gidd-issue-11']);
    await assert.rejects(s.invoke('issue', ['--file', first, '--policy', '01/00']), /worktree_branch_exists/);
    await s.invoke('policy.set', ['11', '00/00']);
    const retired = await s.command('cleanup', ['11']);
    assert.equal(retired.registration_removed, true);
    assert.ok(s.native(['branch', '--list', 'gidd-issue-11']));
    const next = await s.invoke('issue', ['--file', second, '--policy', '01/00']);
    assert.equal(next.issue.number, 12);
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 2);
  } finally { await s.dispose(); }
});

test('creating an Issue stores its plan and prepares its workspace in one command', async (t) => {
  const s = installation(t);
  try {
    const data = s.target + '.gidd';
    unlinkSync(join(data, 'storage.json')); unlinkSync(join(data, 'README.md')); rmdirSync(data);
    s.select('direct-commit');
    await assert.rejects(s.invoke('issue', ['--file', join(s.root, 'missing.md')]), /issue_draft_missing/);
    assert.equal(existsSync(data), false, 'An invalid first request does not initialize data');
    const body = '# Requirements\r\n\r\n' + '正文与验收 $value `text`\n'.repeat(3000);
    const path = join(s.root, 'issue draft.md');
    const source = '\n \t\n# Fix "quoted" title\n' + body;
    write(path, source);
    const created = await s.invoke('issue', ['--file', path]);
    assert.deepEqual(created.issue, { number: 11, url: 'https://github.com/test/repo/issues/11' });
    assert.equal(created.task, undefined); assert.equal(created.workspace.state, 'assigned');
    assert.equal(s.control.issues.get(11).body, body);
    assert.equal(s.control.issues.get(11).title, '[gidd] Fix "quoted" title');
    assert.ok(existsSync(join(s.target + '.gidd', '11/state.json')));
    assert.equal(readFileSync(join(s.target + '.gidd', '11/issue.md'), 'utf8'), source.replace('# Fix', '# [gidd] Fix'));
    assert.equal(readFileSync(path, 'utf8'), source);
    await assert.rejects(s.invoke('issue', ['--file', join(s.root, 'missing.md')]), /issue_draft_missing/);
    const repeated = await s.invoke('issue', ['--file', path]);
    assert.equal(repeated.workspace.path, created.workspace.path);
    const workspace = await s.invoke('workspace', ['11']);
    assert.equal(workspace.workspace.branch, 'main');
    assert.equal((await s.invoke('status', ['11'])).issue.number, 11);
    await s.invoke('cleanup', ['11']);
    assert.equal(existsSync(join(s.target + '.gidd', '11')), false);
    assert.equal(readFileSync(path, 'utf8'), source);
    assert.equal(s.control.issues.get(11).state, 'open');
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 1);
  } finally { await s.dispose(); }
});

test('Issue drafts with the same relative name in separate worktrees remain independent', async (t) => {
  const s = installation(t);
  try {
    const first = (await s.command('workspace', ['2'])).workspace.path;
    const second = (await s.command('workspace', ['3'])).workspace.path;
    const file = '.agents/issue draft.md';
    const drafts = ['\uFEFF# First task\r\n\r\nFirst body\r\n', '# 第二个任务\n\nSecond body\n'];
    write(join(first, file), drafts[0]); write(join(second, file), drafts[1]);
    const createdFirst = await s.invoke('issue', ['--file', file], first);
    const createdSecond = await s.invoke('issue', ['--file', file], second);
    assert.equal(createdFirst.issue.number, 11); assert.equal(createdSecond.issue.number, 12);
    assert.equal(s.control.issues.get(11).title, '[gidd] First task');
    assert.equal(s.control.issues.get(11).body, 'First body\r\n');
    assert.equal(s.control.issues.get(12).title, '[gidd] 第二个任务');
    assert.equal(s.control.issues.get(12).body, 'Second body\n');
    for (const [index, directory] of [first, second].entries()) {
      assert.equal(readFileSync(join(directory, file), 'utf8'), drafts[index]);
      assert.equal(readFileSync(join(s.target + '.gidd', String(11 + index), 'issue.md'), 'utf8'), drafts[index].replace('# ', '# [gidd] '));
    }
    assert.equal(existsSync(join(s.target + '.gidd', 'issue.md')), false);
  } finally { await s.dispose(); }
});

test('invalid Issue draft files fail before authentication or remote creation', async (t) => {
  const s = installation(t);
  try {
    s.select('direct-commit');
    const file = join(s.root, 'draft.md');
    for (const text of ['', 'Body without title', '## Nested heading\nBody', 'Intro\n# Title\nBody',
      '\nIntro\n# Title\nBody', '# Title\n' + 'x'.repeat(1024 * 1024)]) {
      write(file, text);
      await assert.rejects(s.invoke('issue', ['--file', file]), /issue_draft_invalid/);
      assert.equal(readFileSync(file, 'utf8'), text);
    }
    for (const text of ['# \nBody', '# [gidd]\nBody', '# [GIDD]   \r\nBody']) {
      write(file, text);
      await assert.rejects(s.invoke('issue', ['--file', file]), error => {
        assert.equal(error.message, 'issue_title_empty');
        assert.equal(error.details.path, file);
        assert.equal(readFileSync(file, 'utf8'), text);
        return true;
      });
    }
    await assert.rejects(s.invoke('issue', ['--file', s.root]), /issue_draft_invalid/);
    await assert.rejects(s.invoke('issue', ['--file', join(s.root, 'missing.md')]), /issue_draft_missing/);
    const invalidUtf8 = Buffer.concat([Buffer.from('# Title\n\n'), Buffer.from([0xd6, 0xd0])]);
    write(file, invalidUtf8);
    await assert.rejects(s.invoke('issue', ['--file', file]), /issue_draft_invalid/);
    assert.deepEqual(readFileSync(file), invalidUtf8);
    write(file, '# [gidd]\nBody');
    const entry = new URL('../.agents/skills/gidd/scripts.js/gidd.mjs', import.meta.url).href;
    const cli = run(process.execPath, ['--input-type=module', '-e',
      `import { main } from ${JSON.stringify(entry)}; process.exitCode = await main(process.argv.slice(1), { boundRepository: ${JSON.stringify(s.target)} });`,
      'issue', '--file', file], { cwd: s.target });
    assert.equal(cli.status, 2, cli.stderr);
    const report = JSON.parse(cli.stdout);
    assert.equal(report.details.code, 'issue_title_empty');
    assert.equal(report.details.path, file);
    assert.match(report.hint, /Write an Issue title/);
    assert.ok(s.control.calls.every(args => !['auth', 'api'].includes(args[0])));
    assert.equal(readTasks({ path: s.target + '.gidd' }).length, 0);
  } finally { await s.dispose(); }
});

test('uncertain creation makes one request and can recover by registering the existing Issue', async (t) => {
  const s = installation(t);
  try {
    s.select('direct-commit');
    const body = join(s.root, 'draft.md'); write(body, '# Create\n\nAcceptance');
    s.control.intercept = (exe, args) => {
      if (!args.includes('POST')) return;
      s.control.issues.set(11, { number: 11, title: 'Create', body: 'Acceptance', state: 'open', html_url: 'https://github.com/test/repo/issues/11' });
      return { ok: false, reason: 'process_timeout' };
    };
    await assert.rejects(s.invoke('issue', ['--file', body]), error => {
      assert.equal(error.message, 'issue_creation_unconfirmed');
      assert.equal(error.workspace.delivery.remote.push.repository, 'https://github.com/test/repo');
      return true;
    });
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 1);
    assert.equal(readTasks({ path: s.target + '.gidd' }).length, 0);
    assert.equal(readFileSync(body, 'utf8'), '# Create\n\nAcceptance');
    await noPreparedResources(s, s.initial);
    s.control.intercept = null;
    assert.equal((await s.invoke('workspace', ['11', '--policy', '00/00'])).issue.number, 11);
    assert.equal(readFileSync(join(s.target + '.gidd', '11/issue.md'), 'utf8'), '# Create\n\nAcceptance');
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 1);
  } finally { await s.dispose(); }
});

test('a local save failure after creation reports the Issue number and preserves recovery', async (t) => {
  const s = installation(t);
  try {
    s.select('direct-commit');
    const body = join(s.root, 'draft.md'); write(body, '# Create\n\nAcceptance');
    const blocked = join(s.target + '.gidd', '11/state.json');
    s.control.intercept = (exe, args) => {
      if (args.includes('POST')) mkdirSync(blocked, { recursive: true });
    };
    await assert.rejects(s.invoke('issue', ['--file', body]), error => {
      const report = workspaceReport({ status: 'error', ...error.workspace });
      assert.equal(report.issue.number, 11); assert.equal(report.issue_created, true);
      assert.equal(report.issue.url, 'https://github.com/test/repo/issues/11');
      assert.equal(report.retry, '11 --policy 00.direct-commit/00.auto');
      return true;
    });
    assert.equal(readFileSync(body, 'utf8'), '# Create\n\nAcceptance');
    rmdirSync(blocked); s.control.intercept = null;
    assert.equal((await s.invoke('workspace', ['11', '--policy', '00/00'])).issue.number, 11);
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 1);
  } finally { await s.dispose(); }
});

test('Issue copies survive registration and failed cleanup; successful cleanup removes only the numbered directory', async (t) => {
  const s = installation(t);
  try {
    s.select('direct-commit');
    await s.create('1');
    const data = s.target + '.gidd', directory = join(data, '1');
    const copy = join(directory, 'issue.md'), state = readFileSync(join(directory, 'state.json'), 'utf8');
    write(copy, '# Local notes\n\nKeep until cleanup');
    await s.invoke('status', ['1']);
    assert.equal(readFileSync(copy, 'utf8'), '# Local notes\n\nKeep until cleanup');
    write(join(s.root, 'next-task.md'), '# Next task\n\nDraft');
    const outside = join(s.root, 'outside-notes'); mkdirSync(outside);
    write(join(outside, 'keep.txt'), 'keep');
    const link = join(directory, 'linked-notes'); symlinkSync(outside, link, 'junction');
    await assert.rejects(s.invoke('cleanup', ['1']), /reparse_path/);
    assert.equal(readFileSync(join(directory, 'state.json'), 'utf8'), state);
    assert.equal(readFileSync(copy, 'utf8'), '# Local notes\n\nKeep until cleanup');
    unlinkSync(link);
    write(join(directory, 'temporary/notes.txt'), 'temporary');
    await s.invoke('cleanup', ['1']);
    assert.equal(existsSync(directory), false);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(readFileSync(join(s.root, 'next-task.md'), 'utf8'), '# Next task\n\nDraft');
    assert.ok(existsSync(join(data, 'storage.json')));
  } finally { await s.dispose(); }
});

test('creation cannot overwrite an existing local number after a remote change', async (t) => {
  const s = installation(t);
  try {
    s.select('direct-commit');
    await s.create('1');
    const path = join(s.target + '.gidd', '1/state.json'), original = readFileSync(path, 'utf8');
    s.native(['remote', 'set-url', 'origin', 'https://github.com/test/other.git']);
    s.control.nextIssue = 1;
    const body = join(s.root, 'draft.md'); write(body, '# Create\n\nAcceptance');
    await assert.rejects(s.invoke('issue', ['--file', body]), error => {
      assert.equal(error.message, 'issue_registered');
      assert.equal(error.workspace.issue_created, true);
      assert.equal(error.workspace.delivery.remote.push.repository, 'https://github.com/test/other');
      return true;
    });
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally { await s.dispose(); }
});

test('creation retries a failed remote verification without treating it as an uncertain POST', async (t) => {
  const s = installation(t);
  try {
    s.select('direct-commit');
    const source = join(s.root, 'draft.md'), storage = { path: s.target + '.gidd' };
    write(source, '# Create\n\nAcceptance');
    let failed = false;
    s.control.intercept = (exe) => {
      if (failed || exe === process.execPath || !existsSync(join(storage.path, 'create-pending.json'))) return;
      failed = true;
      return { ok: false, reason: 'command_failed' };
    };
    await assert.rejects(s.invoke('issue', ['--file', source]), /delivery_remote_failed/);
    assert.equal(failed, true);
    assert.equal(readCreatePending(storage).phase, 'planned');
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 0);
    s.control.intercept = null;
    const created = await s.invoke('issue', ['--file', source]);
    assert.equal(created.workspace.state, 'assigned');
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 1);
    assert.equal(readCreatePending(storage).phase, 'ready');
  } finally { await s.dispose(); }
});

test('creation freezes submitted content and its hash before a concurrent draft edit', {
  skip: process.versions.bun ? 'Bun does not update named fs exports for read fault injection' : false,
}, async (t) => {
  const s = installation(t), originalRead = fs.readFileSync;
  try {
    s.select('direct-commit');
    const source = join(s.root, 'draft.md'), old = '# Old title\n\nOld body', next = '# New title\n\nNew body';
    write(source, old);
    let changed = false;
    fs.readFileSync = (path, ...args) => {
      const value = originalRead(path, ...args);
      if (String(path) === source && !changed) { changed = true; write(source, next); }
      return value;
    };
    syncBuiltinESMExports();
    const first = await s.invoke('issue', ['--file', source]);
    fs.readFileSync = originalRead; syncBuiltinESMExports();
    assert.equal(changed, true);
    assert.equal(s.control.issues.get(first.issue.number).body, 'Old body');
    assert.equal(readCreatePending({ path: s.target + '.gidd' }).sha256, createHash('sha256').update(old).digest('hex'));
    assert.equal(readFileSync(source, 'utf8'), next);
    await s.command('cleanup', [String(first.issue.number)]);
    const second = await s.invoke('issue', ['--file', source]);
    assert.notEqual(second.issue.number, first.issue.number);
    assert.equal(s.control.issues.get(second.issue.number).body, 'New body');
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 2);
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); await s.dispose(); }
});
