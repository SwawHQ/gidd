import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { unlinkSync } from 'node:fs';
import { repositoryCommandContext } from '../.agents/skills/gidd/scripts.js/shared/repository-command.mjs';
import { parseIssueTaskArguments, issueTaskCommand } from '../.agents/skills/gidd/scripts.js/commands/issue-task/index.mjs';
import { parseGhArguments, ghCommand } from '../.agents/skills/gidd/scripts.js/commands/gh/index.mjs';
import { workspaceReport } from '../.agents/skills/gidd/scripts.js/shared/workspace-report.mjs';
import { repositoryConnection } from '../.agents/skills/gidd/scripts.js/shared/repository-remote.mjs';
import { doctor } from '../.agents/skills/gidd/scripts.js/commands/doctor/index.mjs';
import { readTasks, validTask } from '../.agents/skills/gidd/scripts.js/shared/task-records.mjs';
import { readPolicy } from '../.agents/skills/gidd/scripts.js/shared/policies.mjs';
import { policySnapshot } from '../.agents/skills/gidd/scripts.js/shared/policy-definition.mjs';
import { recordPolicyUse, policyStorage, readPolicyHistory } from '../.agents/skills/gidd/scripts.js/shared/policy-history.mjs';
import { assert, existsSync, join, readFileSync, until, write } from './support/helpers.mjs';
import { installation, noPreparedResources } from './support/issue-task.mjs';

test('task commands reuse fresh storage paths and refresh supplied contexts', async (t) => {
  const s = installation(t);
  let context;
  try {
    await s.command('workspace', ['1']);
    const commonRead = args => args.slice(2).join(' ') === 'rev-parse --path-format=absolute --git-common-dir';
    s.control.calls.length = 0;
    assert.equal((await s.command('status', ['1'])).issue.number, 1);
    assert.equal(s.control.calls.filter(commonRead).length, 2, 'Only the reads before and after the storage lock are needed');
    context = await s.track(repositoryCommandContext(s.target, { execute: s.execute, signal: s.signal, cwd: s.target }));
    s.control.calls.length = 0;
    s.control.intercept = (exe, args) => commonRead(args) ? { ok: false, reason: 'command_failed', text: '' } : undefined;
    await assert.rejects(s.track(issueTaskCommand(s.target, { action: 'status', issue: '1' }, {
      execute: s.execute, signal: s.signal, cwd: s.target, context,
    })), /delivery_git_failed/);
    assert.equal(s.control.calls.filter(commonRead).length, 1);
  } finally { context?.lease.release(); await s.dispose(); }
});

test('account verification still rejects a concurrent delivery repository change', async (t) => {
  const s = installation(t);
  let changed = false;
  try {
    s.control.intercept = (exe, args) => {
      if (exe === process.execPath && args[0] === 'api' && args.includes('user')) {
        changed = true;
        s.native(['config', 'remote.origin.url', 'https://github.com/test/other.git']);
      }
    };
    await assert.rejects(s.track(repositoryConnection(s.target, {
      execute: s.execute, signal: s.signal, github: true, branch: 'main',
    })), /delivery_remote_changed/);
    assert.equal(changed, true);
  } finally { await s.dispose(); }
});

test('task fixture cancels active commands and waits before deleting their files', async () => {
  for (const origin of ['test', 'dispose']) {
    const parent = new AbortController(), s = installation({ signal: parent.signal });
    let started = false, settled = false;
    try {
      s.control.intercept = (exe, args, { signal }) => new Promise(resolve => {
        started = true;
        signal.addEventListener('abort', () => setTimeout(() => {
          assert.equal(existsSync(s.root), true, 'Pending commands still own their files');
          settled = true;
          resolve({ ok: false, reason: 'cancelled', text: '' });
        }, 25), { once: true });
      });
      const command = s.command('workspace', ['2']);
      const rejected = assert.rejects(command, { name: 'AbortError' });
      await until(() => started);
      if (origin === 'test') parent.abort();
      const closing = s.dispose();
      assert.equal(existsSync(s.root), true);
      await rejected;
      await closing;
      assert.equal(settled, true);
      assert.equal(existsSync(s.root), false);
      assert.throws(() => s.invoke('status', ['2']), { name: 'AbortError' });
    } finally { await s.dispose(); }
  }
});

test('task records require delivery and reject the retired field', () => {
  const policy = policySnapshot(readPolicy('00/04'));
  const task = { schema: 'gidd.task/v1', issue: 7, target_branch: 'main', policy, github_account: 'Fixture',
    delivery: { mode: policy.mode, remote: { fetch: { repository: 'https://github.com/test/repo', branch: 'main' },
      push: { repository: 'https://github.com/test/repo' } } } };
  assert.equal(validTask(task), true);
  const { policy: savedPolicy, ...withoutPolicy } = task;
  assert.equal(validTask({ ...withoutPolicy, flow: savedPolicy }), false);
  assert.equal(validTask({ ...task, flow: savedPolicy }), false);
  assert.equal(validTask({ ...withoutPolicy, spec: savedPolicy }), false);
  assert.equal(validTask({ ...task, spec: savedPolicy }), false);
  const { delivery, ...fields } = task;
  assert.equal(validTask({ ...fields, workflow: delivery }), false);
  assert.equal(validTask({ ...task, workflow: delivery }), false);
});

test('repository authorization shares the target profile from a linked worktree and preserves task records', async (t) => {
  const s = installation(t);
  try {
    const prepared = await s.command('workspace', ['8']);
    const state = join(s.target + '.gidd', '8/state.json'), before = readFileSync(state, 'utf8');
    s.native(['remote', 'add', 'other', 'https://github.example.test/other/repo']);
    s.native(['config', 'branch.gidd-issue-8.pushRemote', 'other']);
    const configBefore = readFileSync(join(s.target, '.git/config'), 'utf8');
    const report = await s.track(ghCommand(prepared.workspace.path, { action: 'auth' }, {
      execute: s.execute, cwd: prepared.workspace.path, signal: s.signal,
      login: async (exe, args, options) => {
        assert.equal(args[args.indexOf('--hostname') + 1], 'github.com');
        assert.equal(options.env.GH_CONFIG_DIR, join(s.target + '.gidd', 'gh'));
        write(join(options.env.GH_CONFIG_DIR, 'hosts.yml'), 'repository profile fixture');
        return 0;
      },
    }));
    assert.equal(report.github.account, 'tester');
    assert.equal(report.github.config_directory, join(s.target + '.gidd', 'gh'));
    assert.equal(report.issue, undefined);
    assert.equal(readFileSync(state, 'utf8'), before);
    assert.equal(readFileSync(join(s.target, '.git/config'), 'utf8'), configBefore);
  } finally { await s.dispose(); }
});

test('doctor and offline resume reject changed bindings while explicit equivalent defaults remain valid', async (t) => {
  const s = installation(t);
  try {
    await s.command('workspace', ['1']);
    s.native(['config', 'branch.main.remote', 'origin']);
    await s.command('status', ['1']);
    let report = await s.track(doctor(s.target, { offline: true }));
    assert.equal(report.checks.find(row => row.id === 'folder.gidd.remote').status, 'ready');
    s.native(['remote', 'add', 'for.swaw.gidd', 'https://github.com/test/elsewhere.git']);
    await assert.rejects(s.command('status', ['1']), /delivery_remote_changed/);
    report = await s.track(doctor(s.target, { offline: true }));
    const changed = report.checks.find(row => row.id === 'folder.gidd.remote');
    assert.equal(changed.status, 'invalid');
    assert.equal(changed.details.issues[0].issue, 1);
  } finally { await s.dispose(); }
});

test('task policy changes preserve bindings and history failures restore the previous plan', async (t) => {
  const s = installation(t);
  try {
    const created = await s.register('1', '00/00');
    assert.equal(created.next, '1 --policy 00.direct-commit/00.auto');
    const path = join(s.target + '.gidd', '1/state.json'), copy = readFileSync(join(s.target + '.gidd', '1/issue.md'), 'utf8');
    const original = JSON.parse(readFileSync(path, 'utf8'));
    write(path, JSON.stringify({ ...original, registration: { ...original.registration, complete: false } }));
    await assert.rejects(s.invoke('policy.set', ['1', '01/00']), /task_registration_pending/);
    write(path, JSON.stringify(original));
    const changed = await s.invoke('policy.set', ['1', '01/00']);
    assert.equal(changed.policy.mode, 'direct-merge');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(record.delivery.mode, 'direct-merge');
    assert.deepEqual(record.delivery.remote, original.delivery.remote);
    assert.equal(record.target_branch, original.target_branch);
    assert.equal(record.github_account, original.github_account);
    assert.equal(readFileSync(join(s.target + '.gidd', '1/issue.md'), 'utf8'), copy);
    assert.equal(readPolicyHistory(policyStorage(s.target)).length, 2);
    const before = readFileSync(path, 'utf8'), history = readFileSync(join(s.target + '.gidd', 'policy-history.jsonl'), 'utf8');
    await s.invoke('policy.set', ['1', '01/00']);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(readPolicyHistory(policyStorage(s.target)).length, 2);
    // Bun does not update named builtin imports through syncBuiltinESMExports.
    if (!process.versions.bun) {
      const open = fs.openSync;
      try {
        fs.openSync = (file, flags, ...args) => {
          if (String(file).endsWith('policy-history.jsonl') && flags === 'a') throw new Error('injected_history_failure');
          return open(file, flags, ...args);
        };
        syncBuiltinESMExports();
        await assert.rejects(s.invoke('policy.set', ['1', '00/04']), /injected_history_failure/);
      } finally { fs.openSync = open; syncBuiltinESMExports(); }
    }
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(readFileSync(join(s.target + '.gidd', 'policy-history.jsonl'), 'utf8'), history);
    write(join(s.target + '.gidd', 'policy-history.jsonl'), '{}\n');
    await assert.rejects(s.invoke('policy.set', ['1', '00/04']), /policy_history_invalid/);
    assert.equal(readFileSync(path, 'utf8'), before);
    write(join(s.target + '.gidd', 'policy-history.jsonl'), history);
    const prepared = await s.invoke('workspace', ['1']);
    assert.equal(prepared.workspace.delivery_mode, 'direct-merge');
    await assert.rejects(s.invoke('policy.set', ['1', '00/00']), /task_policy_mode_locked/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace, prepared.id);
    const interrupted = JSON.parse(readFileSync(path, 'utf8')); delete interrupted.workspace;
    write(path, JSON.stringify(interrupted));
    assert.equal((await s.invoke('status', ['1'])).workspace.path, prepared.workspace.path);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace, undefined);
    await assert.rejects(s.invoke('policy.set', ['1', '00/00']), /task_policy_mode_locked/);
    await s.invoke('workspace', ['1']);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace, prepared.id);
    assert.equal(readPolicyHistory(policyStorage(s.target)).length, 2);
  } finally { await s.dispose(); }
});

test('prepared task policies change approval points within the same delivery mode offline', async (t) => {
  const s = installation(t);
  try {
    await s.command('workspace', ['1']);
    const path = join(s.target + '.gidd', '1/state.json'), original = JSON.parse(readFileSync(path, 'utf8'));
    s.control.calls.length = 0;
    const changed = await s.invoke('policy.set', ['1', '00/04']);
    assert.equal(changed.policy.authorization.commit, 'ask');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual({ ...record, policy: original.policy }, original);
    assert.ok(s.control.calls.every(args => !args.some(arg => ['api', 'auth', 'fetch', 'ls-remote', 'push'].includes(arg))));
    assert.equal(s.native(['rev-parse', 'HEAD']), s.initial);
    assert.equal(readPolicyHistory(policyStorage(s.target)).length, 2);
    await assert.rejects(s.invoke('workspace', ['1', '--policy', '00/00']), /task_policy_changed/);
    assert.equal((await s.invoke('workspace', ['1', '--policy', '00/04'])).policy.authorization.commit, 'ask');
    await assert.rejects(s.invoke('policy.set', ['1', '02/00']), /task_policy_mode_locked/);
    assert.equal(readPolicyHistory(policyStorage(s.target)).length, 2);
    const manifest = join(s.target + '.gidd', 'storage.json'), owner = readFileSync(manifest, 'utf8');
    const state = readFileSync(path, 'utf8');
    unlinkSync(manifest);
    try {
      await assert.rejects(s.invoke('workspace', ['1']), /data_needs_attention/);
      assert.equal(readFileSync(path, 'utf8'), state);
      assert.equal(s.native(['rev-parse', 'HEAD']), s.initial);
    } finally { write(manifest, owner); }
  } finally { await s.dispose(); }
});

test('registered Issues detect remote changes before use and unprepared cleanup remains local', async (t) => {
  const s = installation(t);
  try {
    s.select('direct-commit');
    await s.register('1');
    s.native(['remote', 'set-url', 'origin', 'https://github.com/test/other.git']);
    s.control.calls.length = 0;
    await assert.rejects(s.invoke('status', ['1']), /delivery_remote_changed/);
    await assert.rejects(s.invoke('workspace', ['1']), /delivery_remote_changed/);
    assert.ok(s.control.calls.every(args => !args.includes('api') && !args.includes('auth')));
    const result = await s.track(doctor(s.target, { offline: true }));
    assert.equal(result.checks.find(check => check.id === 'folder.gidd.remote').status, 'invalid');
    await noPreparedResources(s, s.initial);
    s.control.calls.length = 0;
    assert.equal((await s.invoke('cleanup', ['1'])).registration_removed, true);
    assert.equal(readTasks({ path: s.target + '.gidd' }).length, 0);
    assert.ok(s.control.calls.every(args => !args.some(arg => ['api', 'auth', 'push', 'fetch', 'ls-remote'].includes(arg))));
    assert.equal(s.control.issues.get(1).state, 'open');
  } finally { await s.dispose(); }
});

test('changing the delivery repository cannot replace a local Issue with the same number', async (t) => {
  const s = installation(t);
  try {
    s.select('direct-commit');
    const first = await s.register('1');
    const path = join(s.target + '.gidd', '1/state.json');
    const original = readFileSync(path, 'utf8');
    s.native(['remote', 'set-url', 'origin', 'https://github.com/test/another.git']);
    s.control.issues.get(1).html_url = 'https://github.com/test/another/issues/1';
    await assert.rejects(s.invoke('status', ['1']), /delivery_remote_changed/);
    await assert.rejects(s.invoke('workspace', ['1']), /delivery_remote_changed/);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(first.issue.url, 'https://github.com/test/repo/issues/1');
    await s.invoke('cleanup', ['1']);
    assert.equal((await s.create('1')).issue.url, 'https://github.com/test/another/issues/1');
  } finally { await s.dispose(); }
});

test('released worktree evidence does not become the workspace of a newly registered Issue', async (t) => {
  const s = installation(t);
  try {
    const first = await s.command('workspace', ['2']);
    await s.command('cleanup', ['2']);
    s.select('direct-merge');
    await s.create('2');
    assert.equal((await s.invoke('status', ['2'])).workspace.state, 'assigned');
    const second = await s.invoke('workspace', ['2']);
    assert.equal(second.workspace.path, first.workspace.path);
  } finally { await s.dispose(); }
});

test('Issue task routes accept numbered commands and reject other command domains', () => {
  assert.deepEqual(parseIssueTaskArguments('7', ['--policy', '01/00']), { action: 'workspace', issue: 7, policy: '01/00' });
  assert.throws(() => parseIssueTaskArguments('7.workspace', []), /invalid_arguments/);
  assert.deepEqual(parseIssueTaskArguments('7', []), { action: 'status', issue: 7 });
  assert.deepEqual(parseIssueTaskArguments('7.policy', ['--lang', 'zh']), { action: 'policy', issue: 7, lang: 'zh-CN' });
  assert.throws(() => parseGhArguments('7', []), /invalid_arguments/);
  assert.throws(() => parseGhArguments('issue', []), /invalid_arguments/);
  assert.deepEqual(parseIssueTaskArguments('7.policy.set', ['01/00']), { action: 'policy.set', issue: 7, policy: '01/00' });
  assert.equal(parseIssueTaskArguments('7.merge', ['--squash']).method, 'squash');
  assert.equal(parseIssueTaskArguments('7.merge', ['--rebase']).method, 'rebase');
  assert.throws(() => parseIssueTaskArguments('7.merge', ['--restart']), /invalid_arguments/);
  assert.throws(() => parseIssueTaskArguments('7.merge', ['--restart', '--restart']), /invalid_arguments/);
  assert.deepEqual(parseIssueTaskArguments('7.close-issue', []), { action: 'close-issue', issue: 7 });
  for (const action of ['workspace', 'push', 'merge', 'target-sync', 'close-issue', 'cleanup', 'policy.set'])
    for (const number of ['0', '-1', '01', '9007199254740992', 'main', 'D:/repo'])
      assert.throws(() => parseIssueTaskArguments(number + '.' + action, []), /invalid_arguments/);
  for (const [route, args] of [
    ['issue', ['--file', 'draft']], ['gh.auth', []], ['task', []],
    ['7.policy', ['--lang', '']], ['7.policy', ['--lang', '--lang']], ['7.policy', ['--lang']],
    ['7.workspace', ['--resume']], ['7.workspace', ['--file', 'draft']],
    ['7.workspace', ['--policy', '00/00', '--policy', '01/00']], ['7.workspace', ['--policy', '--bad']],
    ['7', ['--policy']], ['7', ['--policy', '--bad']], ['7.push', ['8']], ['7.policy.set', []], ['7.policy.set', ['00/00', '01/00']],
    ['7.merge', ['--squash', '--rebase']], ['7.merge', ['--rebase', '--message', 'title']],
    ['7.unknown', []], ['workflow.gh.auth', []], ['workflow.issue', ['7']], ['workflow.workspace', ['7']],
  ]) assert.throws(() => parseIssueTaskArguments(route, args), /invalid_arguments/);
});

test('task policies and accounts remain independent of later selections and active gh accounts', async (t) => {
  const s = installation(t);
  try {
    const registered = await s.command('workspace', ['8', '--policy', '01/00']);
    assert.equal(registered.github_account, 'tester');
    const state = join(s.target + '.gidd', '8/state.json'), original = readFileSync(state, 'utf8');
    recordPolicyUse(policyStorage(s.target), policySnapshot(readPolicy('02/00')));
    s.control.intercept = (exe, args, options) => {
      if (exe !== process.execPath) return;
      if (args[0] === 'config') return { ok: true, text: 'another' };
      if (args[0] === 'auth') return { ok: true, text: args.at(-1) === 'tester' ? 'fixture-token' : 'another-token' };
      if (args.includes('user')) return { ok: true, text: options.env.GH_TOKEN === 'fixture-token' ? 'tester' : 'another' };
      // Fixture API accepts either authenticated identity.
      if (options.env.GH_TOKEN === 'another-token') options.env.GH_TOKEN = 'fixture-token';
    };
    const second = await s.create('3', '02/00');
    assert.equal(second.github_account, 'another');
    await assert.rejects(s.invoke('workspace', ['8', '--policy', '02/00']), /task_policy_changed/);
    assert.equal(readFileSync(state, 'utf8'), original);
    assert.equal((await s.invoke('status', ['8'])).github_account, 'tester');
    const history = readPolicyHistory({ path: s.target + '.gidd' });
    assert.equal(history.filter(entry => entry.selector === registered.policy.selector).length, 1);
    s.control.calls.length = 0;
    const prepared = await s.command('workspace', ['8']);
    assert.equal(prepared.workspace.delivery_mode, 'direct-merge');
    assert.ok(s.control.calls.every(args => args[0] !== 'auth'));
    s.control.intercept = (exe, args) => exe === process.execPath && args.includes('user') ? { ok: true, text: 'another' } : undefined;
    await assert.rejects(s.command('close-issue', ['8']), /unexpected_account/);
    assert.equal(JSON.parse(readFileSync(state)).github_account, 'tester');
    await s.command('cleanup', ['8']);
    assert.deepEqual(readPolicyHistory({ path: s.target + '.gidd' }), history);
  } finally { await s.dispose(); }
});

test('resume and direct delivery use only local context after Issue edits or credential loss', async (t) => {
  const s = installation(t);
  try {
    const a = await s.command('workspace', ['8']);
    const head = s.change(a.workspace.path);
    s.control.issues.set(8, { state: 'closed', body: 'Change the target and delivery mode' });
    write(s.config, 'invalid TOML');
    const bindings = JSON.parse(readFileSync(s.binding, 'utf8'));
    delete bindings.tools.gh; write(s.binding, JSON.stringify(bindings));
    s.control.intercept = (exe, args) => {
      assert.notEqual(exe, process.execPath, 'Existing tasks must not invoke gh for local actions');
      assert.ok(!args.some(arg => ['ls-remote', 'fetch', 'push'].includes(arg)), 'Resume and local merge must stay offline');
    };
    s.control.calls.length = 0;
    const resumed = await s.command('status', ['8']);
    assert.equal(resumed.workspace.delivery_mode, 'direct-merge'); assert.equal(resumed.target.branch, 'main');
    assert.equal(resumed.workspace.branch, 'gidd-issue-8');
    assert.equal((await s.command('merge', ['8'])).target.head, head);
    assert.ok(s.control.calls.every(args => args[0] !== 'api' && args[0] !== 'auth'));
    s.control.intercept = (exe, args) => {
      assert.notEqual(exe, process.execPath, 'Push and direct cleanup do not read the Issue');
    };
    await s.command('push', ['8']);
    await s.command('cleanup', ['8']);
    assert.equal((await s.show(a.workspace.path)).worktree.state, 'available');
  } finally { await s.dispose(); }
});

test('new workspaces reject closed Issues, missing policies and duplicate bindings', async (t) => {
  const s = installation(t);
  try {
    assert.throws(() => parseIssueTaskArguments('1', ['--policy']), /invalid_arguments/);
    await assert.rejects(s.invoke('status', ['1']), /task_required/);
    s.native(['checkout', '--detach']);
    await assert.rejects(s.command('workspace', ['1']), /delivery_target_branch_required/);
    s.native(['checkout', 'main']);
    s.native(['branch', 'gidd-issue-2']);
    await assert.rejects(s.command('workspace', ['2']), /worktree_branch_exists/);
    await assert.rejects(s.invoke('workspace', ['1', '--policy', 'invalid-selection']), /policy_/);
    s.control.issues.get(1).state = 'closed';
    await assert.rejects(s.command('workspace', ['1']), /issue_closed/);
    s.control.issues.get(1).state = 'open';
    await s.command('workspace', ['1']);
    s.control.issues.get(1).state = 'closed';
    assert.equal((await s.command('workspace', ['1'])).issue.number, 1);
    assert.equal((await s.command('status', ['1'])).issue.number, 1);
  } finally { await s.dispose(); }
});

test('registered workspaces recover saved policies after presets change or disappear', async (t) => {
  const s = installation(t);
  try {
    const prepared = await s.invoke('workspace', ['8', '--policy', '01/00']);
    const state = join(s.target + '.gidd', '8/state.json'), saved = JSON.parse(readFileSync(state, 'utf8'));
    s.control.fetchFailure = true;
    for (const number of ['2', '10'])
      await assert.rejects(s.invoke('workspace', [number, '--policy', '01/00']), /delivery_remote_failed/);
    s.control.fetchFailure = false;
    const history = readFileSync(join(s.target + '.gidd', 'policy-history.jsonl'), 'utf8');
    const { copySkill } = await import('./support/helpers.mjs');
    const { pathToFileURL } = await import('node:url');
    const skill = join(s.root, 'skill');
    copySkill(skill);
    const { issueTaskCommand: copiedCommand } = await import(pathToFileURL(join(skill, 'scripts.js/commands/issue-task/index.mjs')).href);
    const resume = (number, policy = saved.policy.selector) => s.track(copiedCommand(s.target,
      parseIssueTaskArguments(number, ['--policy', policy]), { execute: s.execute, cwd: s.target, signal: s.signal }).then(workspaceReport));
    const preset = join(skill, 'policies', saved.policy.selector + '.toml');
    const original = readFileSync(preset, 'utf8');
    const changed = original.replace(/^direct_merge\s*=\s*"auto"/m, 'direct_merge = "ask"');
    assert.notEqual(changed, original);
    write(preset, changed);
    for (const selector of [saved.policy.selector, '01/00']) {
      const repeated = await resume('8', selector);
      assert.equal(repeated.workspace.path, prepared.workspace.path);
      assert.deepEqual(repeated.policy, saved.policy);
    }
    assert.deepEqual((await resume('2', '01/00')).policy, saved.policy);
    await assert.rejects(resume('8', '00/00'), /task_policy_changed/);
    unlinkSync(preset);
    assert.deepEqual((await resume('8')).policy, saved.policy);
    const pending = await s.invoke('status', ['10']);
    assert.equal(pending.workspace.state, 'needs_check');
    assert.equal(pending.next, '10 --policy ' + saved.policy.selector);
    const [number, ...args] = pending.next.split(' ');
    const completed = workspaceReport(await s.track(copiedCommand(s.target, parseIssueTaskArguments(number, args),
      { execute: s.execute, cwd: s.target, signal: s.signal })));
    assert.equal(completed.workspace.state, 'assigned');
    assert.deepEqual(completed.policy, saved.policy);
    await assert.rejects(resume('7'), /policy_resources_missing/);
    assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), saved);
    assert.equal(readFileSync(join(s.target + '.gidd', 'policy-history.jsonl'), 'utf8'), history);
  } finally { await s.dispose(); }
});
