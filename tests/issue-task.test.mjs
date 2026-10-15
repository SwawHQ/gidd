import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { realpathSync, unlinkSync, rmdirSync, symlinkSync } from 'node:fs';
import { parseIssueTaskArguments, issueTaskCommand } from '../.agents/skills/gidd/scripts.js/commands/issue-task/index.mjs';
import { parseIssueArguments, issueCommand } from '../.agents/skills/gidd/scripts.js/commands/issue/index.mjs';
import { parseGhArguments, ghCommand } from '../.agents/skills/gidd/scripts.js/commands/gh/index.mjs';
import { worktreeCommand } from '../.agents/skills/gidd/scripts.js/commands/worktree/index.mjs';
import { runCommand } from '../.agents/skills/gidd/scripts.js/shared/process.mjs';
import { workspaceReport } from '../.agents/skills/gidd/scripts.js/shared/workspace-report.mjs';
import { doctor } from '../.agents/skills/gidd/scripts.js/commands/doctor/index.mjs';
import { readTasks, validTask } from '../.agents/skills/gidd/scripts.js/shared/task-records.mjs';
import { readFlow } from '../.agents/skills/gidd/scripts.js/shared/flows.mjs';
import { flowSnapshot } from '../.agents/skills/gidd/scripts.js/shared/flow-definition.mjs';
import { validLocalMerge } from '../.agents/skills/gidd/scripts.js/shared/local-delivery.mjs';
import { readCreatePending } from '../.agents/skills/gidd/scripts.js/shared/create-pending.mjs';
import { recordFlowUse, flowStorage, readFlowHistory } from '../.agents/skills/gidd/scripts.js/shared/flow-history.mjs';
import { assert, bindFixture, existsSync, findGit, fixture, initializeDataFixture, join, mkdirSync, ok, readFileSync, run, write } from './support/helpers.mjs';

function installation() {
  const f = fixture(), git = findGit(), target = join(f.root, 'repo with spaces'), bare = join(f.root, 'remote.git');
  mkdirSync(target);
  const native = (args, cwd = target) => ok(run(git, ['-C', cwd, ...args])).stdout.trim();
  native(['init', '-b', 'main']);
  native(['config', 'user.name', 'Fixture']); native(['config', 'user.email', 'fixture@example.test']);
  native(['config', 'commit.gpgsign', 'false']); native(['config', 'core.autocrlf', 'false']);
  write(join(target, '.gitignore'), '.agents/\n'); write(join(target, 'tracked.txt'), 'base\n');
  native(['add', '.']); native(['commit', '-m', 'base']);
  const initial = native(['rev-parse', 'HEAD']);
  native(['init', '--bare', bare]); native(['push', bare, 'main']);
  native(['remote', 'add', 'origin', 'https://github.com/test/repo.git']);
  bindFixture(f.root, { git });
  const binding = join(f.root, '.agents/skills.tools/gidd/tool-bindings.json');
  const bindings = JSON.parse(readFileSync(binding, 'utf8'));
  bindings.tools.gh = { path: process.execPath, source: 'path', version: '99.0.0' }; write(binding, JSON.stringify(bindings));
  const config = join(target, '.agents/skills/gidd/config.toml');
  const configuration = 'schema_version = 1\n';
  write(config, configuration);
  initializeDataFixture(target);
  const control = { issues: new Map(), links: new Map(), pr: null, calls: [], intercept: null, fetchFailure: false };
  const plans = new Map([[1, 'direct-commit'], [10, 'direct-commit'], [2, 'direct-merge'],
    [3, 'pr-merge'], [4, 'pr-merge'], [5, 'pr-merge'], [6, 'pr-merge'], [7, 'pr-merge'], [8, 'direct-merge']]);
  for (const number of plans.keys()) control.issues.set(number, {
    number, title: '[gidd] Fixture ' + number, node_id: 'I_' + number, state: 'open', html_url: 'https://github.com/test/repo/issues/' + number, body: 'Requirements and acceptance',
  });
  let selected;
  const select = mode => {
    const id = { 'direct-commit': '00', 'direct-merge': '01', 'pr-merge': '02' }[mode];
    selected = id + '/00';
  };
  const execute = async (exe, args, options) => {
    control.calls.push(args);
    const intercepted = await control.intercept?.(exe, args, options);
    if (intercepted) return intercepted;
    if (exe === process.execPath) {
      assert.equal(options.env.GH_CONFIG_DIR, join(target + '.gidd', 'gh'));
      if (args[0] === 'config') return { ok: true, text: 'tester' };
      if (args[0] === 'auth') return { ok: true, text: 'fixture-token' };
      assert.equal(options.env.GH_TOKEN, 'fixture-token');
      if (args.includes('user')) return { ok: true, text: 'tester' };
      const endpoint = args.at(-1);
      if (endpoint.endsWith('/issues') && args.includes('POST')) {
        assert.ok(args.includes('--input') && args.includes('-'));
        const content = JSON.parse(options.input);
        const number = sNumber();
        const repository = endpoint.slice('repos/'.length, -'/issues'.length);
        const issue = { number, node_id: 'I_' + number, state: 'open', ...content,
          html_url: `https://github.com/${repository}/issues/${number}` };
        control.issues.set(number, issue);
        return { ok: true, text: JSON.stringify(issue) };
      }
      if (endpoint.includes('/issues/')) {
        const issue = control.issues.get(Number(endpoint.split('/').at(-1)));
        if (args.includes('PATCH')) {
          assert.ok(args.includes('state=closed')); assert.ok(args.includes('state_reason=completed'));
          issue.state = 'closed'; issue.state_reason = 'completed';
        }
        return { ok: true, text: JSON.stringify(issue ?? null) };
      }
      if (endpoint === 'graphql') {
        const number = Number(args.find(arg => arg.startsWith('issue=')).slice('issue=I_'.length));
        const issue = control.issues.get(number);
        if (args.some(arg => arg.includes('addCloseIssueReferences'))) {
          assert.ok(args.includes('pr=PR_42'));
          control.links.set(number, [{ id: 'PR_42', number: 42, url: 'https://github.com/test/repo/pull/42' }]);
          return { ok: true, text: JSON.stringify({ data: { addCloseIssueReferences: { issue: { id: issue.node_id } } } }) };
        }
        assert.ok(args.some(arg => arg.includes('includeClosedPrs:true')));
        return { ok: true, text: JSON.stringify({ data: { node: { id: issue.node_id, number, url: issue.html_url,
          closedByPullRequestsReferences: { nodes: control.links.get(number) ?? [], pageInfo: { hasNextPage: false } } } } }) };
      }
      if (endpoint.endsWith('/pulls/42/merge')) {
        if (control.mergeResponse) return { ok: true, text: JSON.stringify(control.mergeResponse) };
        assert.ok(args.includes('sha=' + control.pr.head.sha));
        control.pr = { ...control.pr, state: 'closed', merged: true, merged_at: '2026-10-05T00:00:00Z', merge_commit_sha: control.pr.head.sha };
        native(['update-ref', 'refs/heads/main', control.pr.head.sha], bare);
        return { ok: true, text: JSON.stringify({ merged: true, sha: control.pr.head.sha }) };
      }
      if (endpoint.includes('/pulls?')) {
        const state = new URLSearchParams(endpoint.split('?')[1]).get('state');
        const prs = control.pr ? (Array.isArray(control.pr) ? control.pr : [control.pr]).filter(pr => pr.state === state) : [];
        return { ok: true, text: JSON.stringify(prs) };
      }
      if (endpoint.endsWith('/pulls/42')) return { ok: true, text: JSON.stringify(control.pr) };
      throw new Error('unexpected API request');
    }
    // Redirect only transport. Keep the named remote's refspec/prune/mirror
    // configuration active so tests exercise the same semantics as production.
    const redirected = args.some(arg => ['ls-remote', 'push', 'fetch'].includes(arg))
      ? ['-c', `url.${bare.replaceAll('\\', '/')}.insteadOf=https://github.com/test/repo.git`,
        '-c', `url.${bare.replaceAll('\\', '/')}.insteadOf=https://github.com/test/another.git`,
        '-c', `url.${bare.replaceAll('\\', '/')}.insteadOf=https://github.com/test/other.git`,
        '-c', `url.${bare.replaceAll('\\', '/')}.insteadOf=git@github.com:test/repo.git`,
        ...(control.fetchBare ? ['-c', `url.${control.fetchBare.replaceAll('\\', '/')}.insteadOf=https://github.com/upstream/repo.git`] : []), ...args] : args;
    const result = await runCommand(exe, redirected, options);
    return control.fetchFailure && args.includes('fetch') && result.ok ? { ok: false, reason: 'command_failed' } : result;
  };
  const sNumber = () => control.nextIssue ?? Math.max(...control.issues.keys()) + 1;
  const invoke = (action, args = [], cwd = target) => {
    args = [...args];
    if (action === 'issue' && selected && !args.includes('--flow')) args.push('--flow', selected);
    const number = action === 'issue' ? null : args.shift();
    if (action === 'workspace' && !args.includes('--flow')) {
      const task = readTasks({ path: target + '.gidd' }).find(task => task.issue === Number(number));
      if (task) args.push('--flow', task.flow.selector);
    }
    const route = action === 'issue' ? action : number + (['status', 'workspace'].includes(action) ? '' : '.' + action);
    const command = route === 'issue' ? issueCommand : issueTaskCommand;
    const parsed = route === 'issue' ? parseIssueArguments(route, args) : parseIssueTaskArguments(route, args);
    return command(target, parsed, { execute, cwd }).then(workspaceReport);
  };
  const command = (action, args = [], cwd = target) => {
    if (action === 'workspace' && !args.includes('--flow') && !readTasks({ path: target + '.gidd' }).some(task => task.issue === Number(args[0]))) {
      select(plans.get(Number(args[0])) ?? 'direct-commit');
      args = [...args, '--flow', selected];
    }
    return invoke(action, args, cwd);
  };
  const create = async (number, flow = selected) => {
    const draft = join(f.root, 'create-' + number + '.md'), previous = control.nextIssue;
    const issue = control.issues.get(Number(number));
    write(draft, '# ' + (issue?.title ?? 'Fixture') + '\n\n' + (issue?.body ?? 'Acceptance'));
    control.nextIssue = Number(number);
    try { return await invoke('issue', ['--file', draft, '--flow', flow]); }
    finally { control.nextIssue = previous; }
  };
  const register = async (number, flow = selected) => {
    const previous = control.fetchFailure; control.fetchFailure = true;
    try { await assert.rejects(invoke('workspace', [number, '--flow', flow]), /delivery_remote_failed/); }
    finally { control.fetchFailure = previous; }
    await invoke('cleanup', [number]);
    return invoke('status', [number]);
  };
  const show = path => worktreeCommand(target, { action: 'show', path });
  const change = (path, message = 'feature') => { write(join(path, 'tracked.txt'), message + '\n'); native(['commit', '-am', message], path); return native(['rev-parse', 'HEAD'], path); };
  let remoteUpdates = 0;
  const advanceRemote = () => {
    const previous = native(['rev-parse', 'main']);
    const head = change(target, 'remote update' + (++remoteUpdates === 1 ? '' : ' ' + remoteUpdates));
    native(['push', bare, 'main']); native(['reset', '--hard', previous]);
    return head;
  };
  async function delivery() {
    const workspace = await command('workspace', ['7']);
    control.issues.delete(7); // Later operations must not depend on Issue availability.
    const head = change(workspace.workspace.path);
    await command('push', ['7'], workspace.workspace.path);
    native(['merge', '--squash', 'gidd-issue-7']); native(['commit', '-m', 'squash delivery']);
    const merge = native(['rev-parse', 'HEAD']); native(['push', bare, 'main']); native(['reset', '--hard', initial]);
    control.pr = { number: 42, node_id: 'PR_42', state: 'closed', merged: true, merged_at: '2026-10-03T00:00:00Z', merge_commit_sha: merge,
      head: { ref: 'gidd-issue-7', sha: head, repo: { full_name: 'test/repo' } }, base: { ref: 'main', repo: { full_name: 'test/repo' } } };
    return { workspace, head, merge };
  }
  return { ...f, git, target, bare, initial, native, config, configuration, control, select, invoke, execute, binding, command, create, register, show, change, advanceRemote, delivery };
}

test('task records require delivery and reject the retired field', () => {
  const flow = flowSnapshot(readFlow('00/04'));
  const task = { schema: 'gidd.task/v1', issue: 7, target_branch: 'main', flow, github_account: 'Fixture',
    delivery: { mode: flow.mode, remote: { fetch: { repository: 'https://github.com/test/repo', branch: 'main' },
      push: { repository: 'https://github.com/test/repo' } } } };
  assert.equal(validTask(task), true);
  const { flow: savedFlow, ...withoutFlow } = task;
  assert.equal(validTask({ ...withoutFlow, spec: savedFlow }), false);
  assert.equal(validTask({ ...task, spec: savedFlow }), false);
  const { delivery, ...fields } = task;
  assert.equal(validTask({ ...fields, workflow: delivery }), false);
  assert.equal(validTask({ ...task, workflow: delivery }), false);
});

test('repository authorization shares the target profile from a linked worktree and preserves task records', async () => {
  const s = installation();
  try {
    const prepared = await s.command('workspace', ['8']);
    const state = join(s.target + '.gidd', '8/state.json'), before = readFileSync(state, 'utf8');
    s.native(['remote', 'add', 'other', 'https://github.example.test/other/repo']);
    s.native(['config', 'branch.gidd-issue-8.pushRemote', 'other']);
    const configBefore = readFileSync(join(s.target, '.git/config'), 'utf8');
    const report = await ghCommand(prepared.workspace.path, { action: 'auth' }, {
      execute: s.execute, cwd: prepared.workspace.path,
      login: async (exe, args, options) => {
        assert.equal(args[args.indexOf('--hostname') + 1], 'github.com');
        assert.equal(options.env.GH_CONFIG_DIR, join(s.target + '.gidd', 'gh'));
        write(join(options.env.GH_CONFIG_DIR, 'hosts.yml'), 'repository profile fixture');
        return 0;
      },
    });
    assert.equal(report.github.account, 'tester');
    assert.equal(report.github.config_directory, join(s.target + '.gidd', 'gh'));
    assert.equal(report.issue, undefined);
    assert.equal(readFileSync(state, 'utf8'), before);
    assert.equal(readFileSync(join(s.target, '.git/config'), 'utf8'), configBefore);
  } finally { s.dispose(); }
});

test('separate fetch and delivery repositories stay distinct through PR merge, sync, Issue closure and cleanup', async () => {
  const s = installation();
  try {
    const source = join(s.root, 'source.git');
    s.native(['init', '--bare', source]); s.native(['push', source, 'main']);
    s.control.fetchBare = source;
    s.native(['remote', 'add', 'for.swaw.gidd', 'https://github.com/upstream/repo.git']);
    s.native(['config', 'remote.for.swaw.gidd.pushurl', 'https://github.com/test/repo.git']);
    const prepared = await s.command('workspace', ['7']);
    assert.equal(prepared.target.remote.fetch.repository, 'https://github.com/upstream/repo');
    assert.equal(prepared.target.remote.push.repository, 'https://github.com/test/repo');
    assert.equal(prepared.issue.url, 'https://github.com/test/repo/issues/7');
    const head = s.change(prepared.workspace.path);
    await s.command('push', ['7']);
    assert.equal(s.native(['rev-parse', 'gidd-issue-7'], s.bare), head);
    assert.equal(s.native(['branch', '--list', 'gidd-issue-7'], source), '');
    s.control.pr = { number: 42, node_id: 'PR_42', state: 'open', draft: false,
      head: { ref: 'gidd-issue-7', sha: head, repo: { full_name: 'test/repo' } },
      base: { ref: 'main', repo: { full_name: 'test/repo' } } };
    await s.command('merge', ['7']);
    s.control.calls.length = 0;
    await s.command('target-sync', ['7']);
    await s.command('close-issue', ['7']);
    await s.command('cleanup', ['7']);
    assert.equal(s.native(['rev-parse', 'main']), head);
    assert.equal(s.native(['rev-parse', 'main'], source), s.initial);
    assert.equal(s.native(['branch', '--list', 'gidd-issue-7'], s.bare), '');
    assert.ok(s.control.calls.filter(args => args.includes('fetch')).every(args => args.includes('https://github.com/test/repo.git')));
    assert.ok(s.control.calls.filter(args => args[0] === 'api').every(args => !args.at(-1).includes('repos/upstream/')));
  } finally { s.dispose(); }
});

test('doctor and offline resume reject changed bindings while explicit equivalent defaults remain valid', async () => {
  const s = installation();
  try {
    await s.command('workspace', ['1']);
    s.native(['config', 'branch.main.remote', 'origin']);
    await s.command('status', ['1']);
    let report = await doctor(s.target, { offline: true });
    assert.equal(report.checks.find(row => row.id === 'folder.gidd.remote').status, 'ready');
    s.native(['remote', 'add', 'for.swaw.gidd', 'https://github.com/test/elsewhere.git']);
    await assert.rejects(s.command('status', ['1']), /delivery_remote_changed/);
    report = await doctor(s.target, { offline: true });
    const changed = report.checks.find(row => row.id === 'folder.gidd.remote');
    assert.equal(changed.status, 'invalid');
    assert.equal(changed.details.issues[0].issue, 1);
  } finally { s.dispose(); }
});

test('workspace registration retains its plan after preparation fails and repeats offline', async () => {
  const s = installation();
  try {
    s.control.fetchFailure = true;
    await assert.rejects(s.invoke('workspace', ['1', '--flow', '01/00']), /delivery_remote_failed/);
    const registered = await s.invoke('status', ['1']);
    assert.equal(registered.workspace.state, 'needs_check');
    assert.equal(registered.issue.number, 1);
    assert.equal(registered.workspace.delivery_mode, 'direct-merge');
    assert.equal(registered.next, '1 --flow 01.direct-merge/00.auto');
    await noPreparedResources(s, s.initial);
    s.control.fetchFailure = false;
    s.select('direct-commit');
    const prepared = await s.invoke('workspace', ['1']);
    assert.equal(prepared.workspace.branch, 'gidd-issue-1');
    const state = readFileSync(join(s.target + '.gidd', '1/state.json'), 'utf8');
    const history = readFileSync(join(s.target + '.gidd', 'flow-history.jsonl'), 'utf8');
    s.control.calls.length = 0;
    const repeated = await s.invoke('workspace', ['1']);
    assert.equal(repeated.workspace.path, prepared.workspace.path);
    assert.ok(s.control.calls.every(args => !args.some(arg => ['api', 'auth', 'push', 'fetch', 'ls-remote'].includes(arg))));
    assert.equal(readFileSync(join(s.target + '.gidd', '1/state.json'), 'utf8'), state);
    assert.equal(readFileSync(join(s.target + '.gidd', 'flow-history.jsonl'), 'utf8'), history);
  } finally { s.dispose(); }
});

test('first registration failures retain the Issue flow in the retry context and release the lock', async () => {
  const s = installation();
  try {
    const data = s.target + '.gidd';
    unlinkSync(join(data, 'storage.json'));
    await assert.rejects(s.invoke('workspace', ['1', '--flow', '00/00']), error => {
      assert.equal(error.message, 'data_needs_attention');
      assert.equal(error.workspace.issue, 1);
      assert.equal(error.workspace.flow.selector, '00.direct-commit/00.auto');
      assert.equal(error.workspace.retry, '1 --flow 00.direct-commit/00.auto');
      return true;
    });
    assert.equal(existsSync(join(data, '.lock')), false);
    assert.equal(existsSync(join(data, '1/state.json')), false);
    assert.ok(s.control.calls.every(args => !args.some(arg => ['auth', 'api', 'fetch', 'push'].includes(arg))));
  } finally { s.dispose(); }
});

test('target update interruption resumes its saved commit even after the remote advances again', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('failed allocation cleanup retains the Issue plan and permits preparation again', async () => {
  const s = installation();
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
    assert.deepEqual(resumed.flow, planned.flow);
    assert.equal(readFlowHistory({ path: s.target + '.gidd' }).length, 1);
  } finally { s.dispose(); }
});

test('symbolic recovery refs cannot delete the target branch during cleanup', async () => {
  const s = installation();
  try {
    s.advanceRemote(); s.control.fetchFailure = true;
    await assert.rejects(s.command('workspace', ['2']), /delivery_remote_failed/);
    const state = join(s.target + '.gidd', '2/state.json'), saved = JSON.parse(readFileSync(state, 'utf8'));
    s.native(['update-ref', '-d', saved.preparation.reference]);
    s.native(['symbolic-ref', saved.preparation.reference, 'refs/heads/main']);
    await assert.rejects(s.command('cleanup', ['2']), /delivery_target_changed/);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), saved);
  } finally { s.dispose(); }
});

test('cleanup resolves Task housekeeping after allocation was committed', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('numeric recovery of a confirmed created Issue permits the next creation request', async () => {
  const s = installation();
  try {
    const first = join(s.root, 'first.md'), second = join(s.root, 'second.md');
    write(first, '# First\nAcceptance'); write(second, '# Second\nAcceptance');
    s.control.fetchFailure = true;
    await assert.rejects(s.invoke('issue', ['--file', first, '--flow', '01/00']), /delivery_remote_failed/);
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 1);
    s.control.fetchFailure = false;
    await s.command('cleanup', ['11']);
    await s.invoke('flow.set', ['11', '00/00']);
    await s.command('workspace', ['11', '--flow', '00/00']);
    const next = await s.invoke('issue', ['--file', second, '--flow', '01/00']);
    assert.equal(next.issue.number, 12);
    assert.equal(next.workspace.state, 'assigned');
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 2);
  } finally { s.dispose(); }
});

test('cleanup can retire a confirmed creation that failed before allocation', async () => {
  const s = installation();
  try {
    const first = join(s.root, 'first.md'), second = join(s.root, 'second.md');
    write(first, '# First\nAcceptance'); write(second, '# Second\nAcceptance');
    s.native(['branch', 'gidd-issue-11']);
    await assert.rejects(s.invoke('issue', ['--file', first, '--flow', '01/00']), /worktree_branch_exists/);
    await s.invoke('flow.set', ['11', '00/00']);
    const retired = await s.command('cleanup', ['11']);
    assert.equal(retired.registration_removed, true);
    assert.ok(s.native(['branch', '--list', 'gidd-issue-11']));
    const next = await s.invoke('issue', ['--file', second, '--flow', '01/00']);
    assert.equal(next.issue.number, 12);
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 2);
  } finally { s.dispose(); }
});

test('task flow changes preserve bindings and history failures restore the previous plan', async () => {
  const s = installation();
  try {
    const created = await s.register('1', '00/00');
    assert.equal(created.next, '1 --flow 00.direct-commit/00.auto');
    const path = join(s.target + '.gidd', '1/state.json'), copy = readFileSync(join(s.target + '.gidd', '1/issue.md'), 'utf8');
    const original = JSON.parse(readFileSync(path, 'utf8'));
    write(path, JSON.stringify({ ...original, registration: { ...original.registration, complete: false } }));
    await assert.rejects(s.invoke('flow.set', ['1', '01/00']), /task_registration_pending/);
    write(path, JSON.stringify(original));
    const changed = await s.invoke('flow.set', ['1', '01/00']);
    assert.equal(changed.flow.mode, 'direct-merge');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(record.delivery.mode, 'direct-merge');
    assert.deepEqual(record.delivery.remote, original.delivery.remote);
    assert.equal(record.target_branch, original.target_branch);
    assert.equal(record.github_account, original.github_account);
    assert.equal(readFileSync(join(s.target + '.gidd', '1/issue.md'), 'utf8'), copy);
    assert.equal(readFlowHistory(flowStorage(s.target)).length, 2);
    const before = readFileSync(path, 'utf8'), history = readFileSync(join(s.target + '.gidd', 'flow-history.jsonl'), 'utf8');
    await s.invoke('flow.set', ['1', '01/00']);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(readFlowHistory(flowStorage(s.target)).length, 2);
    // Bun does not update named builtin imports through syncBuiltinESMExports.
    if (!process.versions.bun) {
      const open = fs.openSync;
      try {
        fs.openSync = (file, flags, ...args) => {
          if (String(file).endsWith('flow-history.jsonl') && flags === 'a') throw new Error('injected_history_failure');
          return open(file, flags, ...args);
        };
        syncBuiltinESMExports();
        await assert.rejects(s.invoke('flow.set', ['1', '00/04']), /injected_history_failure/);
      } finally { fs.openSync = open; syncBuiltinESMExports(); }
    }
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(readFileSync(join(s.target + '.gidd', 'flow-history.jsonl'), 'utf8'), history);
    write(join(s.target + '.gidd', 'flow-history.jsonl'), '{}\n');
    await assert.rejects(s.invoke('flow.set', ['1', '00/04']), /flow_history_invalid/);
    assert.equal(readFileSync(path, 'utf8'), before);
    write(join(s.target + '.gidd', 'flow-history.jsonl'), history);
    const prepared = await s.invoke('workspace', ['1']);
    assert.equal(prepared.workspace.delivery_mode, 'direct-merge');
    await assert.rejects(s.invoke('flow.set', ['1', '00/00']), /task_flow_mode_locked/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace, prepared.id);
    const interrupted = JSON.parse(readFileSync(path, 'utf8')); delete interrupted.workspace;
    write(path, JSON.stringify(interrupted));
    assert.equal((await s.invoke('status', ['1'])).workspace.path, prepared.workspace.path);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace, undefined);
    await assert.rejects(s.invoke('flow.set', ['1', '00/00']), /task_flow_mode_locked/);
    await s.invoke('workspace', ['1']);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace, prepared.id);
    assert.equal(readFlowHistory(flowStorage(s.target)).length, 2);
  } finally { s.dispose(); }
});

test('prepared task flows change approval points within the same delivery mode offline', async () => {
  const s = installation();
  try {
    await s.command('workspace', ['1']);
    const path = join(s.target + '.gidd', '1/state.json'), original = JSON.parse(readFileSync(path, 'utf8'));
    s.control.calls.length = 0;
    const changed = await s.invoke('flow.set', ['1', '00/04']);
    assert.equal(changed.flow.authorization.commit, 'ask');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual({ ...record, flow: original.flow }, original);
    assert.ok(s.control.calls.every(args => !args.some(arg => ['api', 'auth', 'fetch', 'ls-remote', 'push'].includes(arg))));
    assert.equal(s.native(['rev-parse', 'HEAD']), s.initial);
    assert.equal(readFlowHistory(flowStorage(s.target)).length, 2);
    await assert.rejects(s.invoke('workspace', ['1', '--flow', '00/00']), /task_flow_changed/);
    assert.equal((await s.invoke('workspace', ['1', '--flow', '00/04'])).flow.authorization.commit, 'ask');
    await assert.rejects(s.invoke('flow.set', ['1', '02/00']), /task_flow_mode_locked/);
    assert.equal(readFlowHistory(flowStorage(s.target)).length, 2);
    const manifest = join(s.target + '.gidd', 'storage.json'), owner = readFileSync(manifest, 'utf8');
    const state = readFileSync(path, 'utf8');
    unlinkSync(manifest);
    try {
      await assert.rejects(s.invoke('workspace', ['1']), /data_needs_attention/);
      assert.equal(readFileSync(path, 'utf8'), state);
      assert.equal(s.native(['rev-parse', 'HEAD']), s.initial);
    } finally { write(manifest, owner); }
  } finally { s.dispose(); }
});

test('registered Issues detect remote changes before use and unprepared cleanup remains local', async () => {
  const s = installation();
  try {
    s.select('direct-commit');
    await s.register('1');
    s.native(['remote', 'set-url', 'origin', 'https://github.com/test/other.git']);
    s.control.calls.length = 0;
    await assert.rejects(s.invoke('status', ['1']), /delivery_remote_changed/);
    await assert.rejects(s.invoke('workspace', ['1']), /delivery_remote_changed/);
    assert.ok(s.control.calls.every(args => !args.includes('api') && !args.includes('auth')));
    const result = await doctor(s.target, { offline: true });
    assert.equal(result.checks.find(check => check.id === 'folder.gidd.remote').status, 'invalid');
    await noPreparedResources(s, s.initial);
    s.control.calls.length = 0;
    assert.equal((await s.invoke('cleanup', ['1'])).registration_removed, true);
    assert.equal(readTasks({ path: s.target + '.gidd' }).length, 0);
    assert.ok(s.control.calls.every(args => !args.some(arg => ['api', 'auth', 'push', 'fetch', 'ls-remote'].includes(arg))));
    assert.equal(s.control.issues.get(1).state, 'open');
  } finally { s.dispose(); }
});

test('changing the delivery repository cannot replace a local Issue with the same number', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('creating an Issue stores its plan and prepares its workspace in one command', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('Issue drafts with the same relative name in separate worktrees remain independent', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('invalid Issue draft files fail before authentication or remote creation', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('uncertain creation makes one request and can recover by registering the existing Issue', async () => {
  const s = installation();
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
    assert.equal((await s.invoke('workspace', ['11', '--flow', '00/00'])).issue.number, 11);
    assert.equal(readFileSync(join(s.target + '.gidd', '11/issue.md'), 'utf8'), '# Create\n\nAcceptance');
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 1);
  } finally { s.dispose(); }
});

test('a local save failure after creation reports the Issue number and preserves recovery', async () => {
  const s = installation();
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
      assert.equal(report.retry, '11 --flow 00.direct-commit/00.auto');
      return true;
    });
    assert.equal(readFileSync(body, 'utf8'), '# Create\n\nAcceptance');
    rmdirSync(blocked); s.control.intercept = null;
    assert.equal((await s.invoke('workspace', ['11', '--flow', '00/00'])).issue.number, 11);
    assert.equal(s.control.calls.filter(args => args.includes('POST')).length, 1);
  } finally { s.dispose(); }
});

test('Issue copies survive registration and failed cleanup; successful cleanup removes only the numbered directory', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('creation cannot overwrite an existing local number after a remote change', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('released worktree evidence does not become the workspace of a newly registered Issue', async () => {
  const s = installation();
  try {
    const first = await s.command('workspace', ['2']);
    await s.command('cleanup', ['2']);
    s.select('direct-merge');
    await s.create('2');
    assert.equal((await s.invoke('status', ['2'])).workspace.state, 'assigned');
    const second = await s.invoke('workspace', ['2']);
    assert.equal(second.workspace.path, first.workspace.path);
  } finally { s.dispose(); }
});

test('task delivery follows the target branch after alias and transport changes and ignores working defaults', async () => {
  const s = installation();
  try {
    const prepared = await s.command('workspace', ['2']);
    s.native(['remote', 'rename', 'origin', 'renamed']);
    s.native(['config', 'branch.main.remote', 'renamed']);
    s.native(['remote', 'add', 'other', 'https://github.com/test/other.git']);
    s.native(['config', 'branch.gidd-issue-2.remote', 'other']);
    s.native(['config', 'branch.gidd-issue-2.pushRemote', 'other']);
    s.native(['config', 'remote.renamed.pushurl', 'git@github.com:test/repo.git']);
    const head = s.change(prepared.workspace.path);
    await s.command('merge', ['2']);
    await s.command('push', ['2']);
    assert.equal(s.native(['rev-parse', 'main'], s.bare), head);
    const push = s.control.calls.findLast(args => args.includes('push'));
    assert.ok(push.includes('git@github.com:test/repo.git'));
    assert.ok(!push.includes('renamed') && !push.includes('other'));
    s.native(['config', '--add', 'remote.renamed.pushurl', 'https://github.com/test/repo.git']);
    await assert.rejects(s.command('push', ['2']), /remote_multiple_push_urls/);
  } finally { s.dispose(); }
});

async function noPreparedResources(s, head) {
  assert.equal(s.native(['rev-parse', 'main']), head);
  assert.equal(s.native(['branch', '--list', 'gidd-issue-*']), '');
  assert.equal((await worktreeCommand(s.target, { action: 'list' })).worktrees.length, 0);
  assert.ok(readTasks({ path: s.target + '.gidd' }).every(task => !task.workspace));
  const references = readTasks({ path: s.target + '.gidd' }).flatMap(task => task.preparation?.reference ? [task.preparation.reference] : []);
  const actual = s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']);
  assert.ok((actual ? actual.split('\n') : []).every(reference => references.includes(reference)));
  assert.equal(existsSync(join(s.target + '.gidd', '.lock')), false);
}

test('Issue task routes accept numbered commands and reject other command domains', () => {
  assert.deepEqual(parseIssueTaskArguments('7', ['--flow', '01/00']), { action: 'workspace', issue: 7, flow: '01/00' });
  assert.throws(() => parseIssueTaskArguments('7.workspace', []), /invalid_arguments/);
  assert.deepEqual(parseIssueTaskArguments('7', []), { action: 'status', issue: 7 });
  assert.deepEqual(parseIssueTaskArguments('7.flow', ['--lang', 'zh']), { action: 'flow', issue: 7, lang: 'zh-CN' });
  assert.throws(() => parseGhArguments('7', []), /invalid_arguments/);
  assert.throws(() => parseGhArguments('issue', []), /invalid_arguments/);
  assert.deepEqual(parseIssueTaskArguments('7.flow.set', ['01/00']), { action: 'flow.set', issue: 7, flow: '01/00' });
  assert.equal(parseIssueTaskArguments('7.merge', ['--squash']).method, 'squash');
  assert.equal(parseIssueTaskArguments('7.merge', ['--rebase']).method, 'rebase');
  assert.throws(() => parseIssueTaskArguments('7.merge', ['--restart']), /invalid_arguments/);
  assert.throws(() => parseIssueTaskArguments('7.merge', ['--restart', '--restart']), /invalid_arguments/);
  assert.deepEqual(parseIssueTaskArguments('7.close-issue', []), { action: 'close-issue', issue: 7 });
  for (const action of ['workspace', 'push', 'merge', 'target-sync', 'close-issue', 'cleanup', 'flow.set'])
    for (const number of ['0', '-1', '01', '9007199254740992', 'main', 'D:/repo'])
      assert.throws(() => parseIssueTaskArguments(number + '.' + action, []), /invalid_arguments/);
  for (const [route, args] of [
    ['issue', ['--file', 'draft']], ['gh.auth', []], ['task', []],
    ['7.flow', ['--lang', '']], ['7.flow', ['--lang', '--lang']], ['7.flow', ['--lang']],
    ['7.workspace', ['--resume']], ['7.workspace', ['--file', 'draft']],
    ['7.workspace', ['--flow', '00/00', '--flow', '01/00']], ['7.workspace', ['--flow', '--bad']],
    ['7', ['--flow']], ['7', ['--flow', '--bad']], ['7.push', ['8']], ['7.flow.set', []], ['7.flow.set', ['00/00', '01/00']],
    ['7.merge', ['--squash', '--rebase']], ['7.merge', ['--rebase', '--message', 'title']],
    ['7.unknown', []], ['workflow.gh.auth', []], ['workflow.issue', ['7']], ['workflow.workspace', ['7']],
  ]) assert.throws(() => parseIssueTaskArguments(route, args), /invalid_arguments/);
});

test('current workspace retains its starting point, pushes only the target and cleans only its context', async () => {
  const s = installation();
  try {
    const prepared = await s.command('workspace', ['1']);
    assert.equal(prepared.status, 'success');
    assert.equal(prepared.workspace.state, 'assigned');
    assert.equal(prepared.target.remote.push.name, undefined);
    assert.equal(prepared.target.remote.push.repository, 'https://github.com/test/repo');
    assert.equal(Object.hasOwn(prepared, 'delivery'), false);
    assert.equal(prepared.workspace.delivery_mode, 'direct-commit');
    assert.equal(prepared.target.path, s.target);
    assert.equal(Object.hasOwn(prepared.target, 'repository'), false);
    assert.equal(Object.hasOwn(prepared, 'worktree'), false);
    assert.equal(prepared.workspace.path, s.target);
    for (const field of ['workspace_path', 'workspace_state', 'worktree_path', 'worktree_state', 'target_repository', 'target_branch', 'delivery_mode', 'start_commit', 'development_branch']) assert.equal(Object.hasOwn(prepared, field), false);
    assert.equal(prepared.workspace.branch, 'main');
    for (const field of ['development_branch', 'checked_out_branch']) assert.equal(Object.hasOwn(prepared.workspace, field), false);
    assert.equal(prepared.target.branch, 'main'); assert.equal(prepared.workspace.start_commit, s.initial);
    const resumed = await s.command('status', ['1']);
    assert.equal(resumed.workspace.path, s.target);
    assert.equal(resumed.workspace.delivery_mode, 'direct-commit');
    assert.equal(Object.hasOwn(resumed, 'delivery_mode'), false);
    assert.equal(resumed.workspace.state, 'assigned');
    assert.equal(resumed.workspace.head, s.initial);
    assert.equal(resumed.workspace.branch, 'main');
    assert.equal(Object.hasOwn(resumed, 'state'), false);
    await assert.rejects(s.command('target-sync', ['1']), /delivery_not_applicable/);
    const recordPath = join(s.target + '.gidd', '1/state.json');
    const originalRecord = readFileSync(recordPath, 'utf8');
    assert.equal((await s.command('workspace', ['1'])).issue.number, 1);
    assert.equal(readFileSync(recordPath, 'utf8'), originalRecord);
    const head = s.change(s.target);
    s.native(['branch', 'other']); s.native(['tag', '-a', 'do-not-push', '-m', 'tag']);
    s.native(['config', 'push.followTags', 'true']); s.native(['config', 'remote.origin.mirror', 'true']);
    recordFlowUse(flowStorage(s.target), flowSnapshot(readFlow('02/00')));
    const continued = await s.command('status', ['1']);
    assert.equal(continued.workspace.start_commit, s.initial);
    assert.equal(continued.workspace.head, head);
    assert.equal(continued.workspace.branch, 'main');
    await assert.rejects(s.command('cleanup', ['1']), /delivery_target_not_pushed/);
    const pushed = await s.command('push', ['1']);
    assert.equal(pushed.workspace.state, 'assigned');
    assert.equal(pushed.workspace.path, prepared.workspace.path);
    assert.equal(pushed.workspace.branch, 'main');
    assert.equal(pushed.pushed_branch, 'main'); assert.equal(pushed.pushed_commit, head);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)'], s.bare), 'refs/heads/main');
    write(join(s.target, 'keep.tmp'), 'user file');
    const cleaned = await s.command('cleanup', ['1']);
    assert.equal(cleaned.context_removed, true); assert.equal(cleaned.status, 'success');
    assert.equal(cleaned.workspace.state, 'needs_check'); assert.deepEqual(cleaned.workspace.details, { code: 'worktree_dirty' });
    assert.equal(Object.hasOwn(cleaned, 'reason'), false); assert.equal(cleaned.details, undefined);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
    assert.equal(s.native(['branch', '--show-current']), 'main');
    assert.equal(existsSync(join(s.target + '.gidd', '1/state.json')), false);
    await assert.rejects(s.command('push', ['999']), /task_required/);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    const next = await s.command('workspace', ['10']);
    assert.equal(next.workspace.state, 'assigned'); assert.equal(next.workspace.details, undefined);
    assert.equal(Object.hasOwn(next, 'reason'), false);
    assert.equal(next.workspace.start_commit, head);
    assert.equal(next.target.branch, 'main');
    assert.equal(next.workspace.path, prepared.workspace.path);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
    unlinkSync(join(s.target, 'keep.tmp'));
    const ready = await s.command('cleanup', ['10']);
    assert.equal(ready.workspace.state, 'available'); assert.equal(ready.workspace.details, undefined);
  } finally { s.dispose(); }
});

test('dedicated direct delivery requires merge, selects the target and releases the recorded workspace', async () => {
  const s = installation();
  try {
    const a = await s.command('workspace', ['2']);
    assert.equal(a.workspace.state, 'assigned');
    assert.equal(a.schema, 'gidd.task-command/v1'); assert.equal(a.workspace.delivery_mode, 'direct-merge');
    assert.equal(realpathSync.native(a.workspace.path), a.workspace.path);
    const head = s.change(a.workspace.path);
    const continued = await s.command('status', ['2']);
    assert.equal(continued.workspace.head, head);
    assert.equal(continued.workspace.start_commit, s.initial);
    assert.equal(continued.workspace.branch, 'gidd-issue-2');
    await assert.rejects(s.command('push', ['999']), /task_required/);
    await assert.rejects(s.command('push', ['2'], a.workspace.path), /worktree_not_delivered/);
    assert.equal((await s.command('merge', ['2'])).target.head, head);
    await assert.rejects(s.command('cleanup', ['2']), /delivery_target_not_pushed/);
    const result = await s.command('push', ['2']);
    assert.equal(result.workspace.state, 'assigned');
    assert.equal(result.pushed_branch, 'main'); assert.equal(result.pushed_commit, head);
    assert.equal(s.native(['branch', '--list', 'gidd-issue-2'], s.bare), '');
    assert.equal((await s.command('cleanup', ['2'])).local_branch_deleted, true);
    assert.equal((await s.show(a.workspace.path)).worktree.state, 'available');
    await assert.rejects(s.command('status', ['2']), /task_required/);
    const b = await s.command('workspace', ['3']);
    assert.equal(b.workspace.path, a.workspace.path); assert.equal(b.workspace.delivery_mode, 'pr-merge');
    assert.equal((await s.show(b.workspace.path)).record.delivery.mode, 'pr-merge');
  } finally { s.dispose(); }
});

test('PR preparation checks remote branches; parallel workspaces never share a guessed current task', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('PR target sync verifies squash delivery, fast-forwards the checked out target, then cleanup deletes working branch refs', async () => {
  const s = installation();
  try {
    const { workspace, merge } = await s.delivery();
    await assert.rejects(s.command('cleanup', ['7']), /worktree_not_delivered/);
    s.native(['config', 'remote.origin.prune', 'true']); s.native(['config', 'remote.origin.pruneTags', 'true']);
    s.native(['config', 'fetch.prune', 'true']); s.native(['config', 'fetch.pruneTags', 'true']);
    s.native(['config', 'branch.main.mergeOptions', '--squash --autostash --overwrite-ignore']);
    s.native(['tag', 'keep-tag', s.initial]); s.native(['tag', 'remote-tag', s.initial], s.bare);
    s.native(['update-ref', 'refs/remotes/origin/main', s.initial]);
    s.native(['update-ref', 'refs/remotes/origin/stale', s.initial]);
    const synced = await s.command('target-sync', ['7'], workspace.workspace.path);
    assert.equal(synced.workspace.state, 'assigned');
    assert.equal(synced.target.head, merge);
    assert.equal(Object.hasOwn(synced.workspace, 'head'), false);
    assert.equal(synced.updated, true); assert.equal(synced.pr, 42);
    assert.equal(s.native(['rev-parse', 'main']), merge);
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'feature\n');
    assert.equal(s.native(['tag', '--list']), 'keep-tag');
    assert.equal(s.native(['rev-parse', 'refs/remotes/origin/main']), s.initial);
    assert.equal(s.native(['rev-parse', 'refs/remotes/origin/stale']), s.initial);
    assert.equal(s.native(['status', '--porcelain']), '');
    assert.equal((await s.command('target-sync', ['7'])).updated, false);
    const cleaned = await s.command('cleanup', ['7']);
    assert.deepEqual(cleaned.target, workspace.target);
    assert.equal(cleaned.workspace.delivery_mode, workspace.workspace.delivery_mode);
    assert.equal(cleaned.local_branch_deleted, true); assert.equal(cleaned.remote_branch_deleted, true);
    assert.equal(s.native(['branch', '--list', 'gidd-issue-7']), '');
    assert.equal(s.native(['branch', '--list', 'gidd-issue-7'], s.bare), '');
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'available');
  } finally { s.dispose(); }
});

test('sync preserves dirty, hidden and diverged target work instead of stashing or resetting it', async () => {
  const s = installation();
  try {
    await s.delivery();
    write(join(s.target, 'tracked.txt'), 'keep me\n');
    await assert.rejects(s.command('target-sync', ['7']), /delivery_target_dirty/);
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'keep me\n');
    s.native(['update-index', '--assume-unchanged', 'tracked.txt']);
    await assert.rejects(s.command('target-sync', ['7']), /delivery_target_index_flags/);
    s.native(['update-index', '--no-assume-unchanged', 'tracked.txt']);
    const diverged = s.change(s.target, 'diverged');
    await assert.rejects(s.command('target-sync', ['7']), /delivery_target_not_fast_forward/);
    assert.equal(s.native(['rev-parse', 'main']), diverged);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
  } finally { s.dispose(); }
});

test('sync finds the target in another checkout and also supports an unoccupied target ref', async () => {
  const s = installation();
  try {
    const { merge } = await s.delivery();
    s.native(['checkout', '-b', 'parking']);
    const targetPath = join(s.root, 'target checkout');
    s.native(['worktree', 'add', targetPath, 'main']);
    await s.command('target-sync', ['7']);
    assert.equal(s.native(['rev-parse', 'HEAD'], targetPath), merge);
    assert.equal(s.native(['branch', '--show-current']), 'parking');
    s.native(['checkout', '--detach'], targetPath);
    s.native(['update-ref', 'refs/heads/main', s.initial, merge]);
    await s.command('target-sync', ['7']);
    assert.equal(s.native(['rev-parse', 'main']), merge);
    assert.equal(s.native(['rev-parse', 'HEAD']), s.initial);
  } finally { s.dispose(); }
});

test('sync CAS rejects a concurrent update to an unoccupied target branch', async () => {
  const s = installation();
  try {
    const { merge } = await s.delivery();
    s.native(['checkout', '-b', 'parking']);
    const concurrent = s.change(s.target, 'concurrent');
    s.control.intercept = async (exe, args) => {
      if (args.includes('update-ref') && args.includes('refs/heads/main') && args.includes(merge)) {
        s.control.intercept = null;
        s.native(['update-ref', 'refs/heads/main', concurrent, s.initial]);
      }
    };
    await assert.rejects(s.command('target-sync', ['7']), /delivery_git_failed/);
    assert.equal(s.native(['rev-parse', 'main']), concurrent);
  } finally { s.dispose(); }
});

for (const [mode, issue] of [['direct-commit', 1], ['direct-merge', 2], ['pr-merge', 3]]) {
  test(`${mode} rejects another branch or detached HEAD before delivery actions and preserves the recorded branch`, async () => {
    const s = installation();
    try {
      const prepared = await s.command('workspace', [String(issue)]), path = prepared.workspace.path;
      const expected = mode === 'direct-commit' ? 'main' : `gidd-issue-${issue}`;
      assert.equal(prepared.workspace.branch, expected);
      assert.equal(prepared.workspace.state, 'assigned');
      const tracked = join(path, 'tracked.txt'), original = readFileSync(tracked, 'utf8');
      write(tracked, 'normal task edit\n');
      let inspected = await s.command('status', [String(issue)]);
      assert.equal(inspected.workspace.state, 'assigned'); assert.equal(inspected.workspace.details, undefined);
      assert.equal(Object.hasOwn(inspected, 'reason'), false); assert.equal(inspected.details, undefined);
      s.native(['update-index', '--assume-unchanged', 'tracked.txt'], path);
      inspected = await s.command('status', [String(issue)]);
      assert.equal(inspected.workspace.state, 'needs_check'); assert.deepEqual(inspected.workspace.details, { code: 'worktree_index_flags' });
      s.native(['update-index', '--no-assume-unchanged', 'tracked.txt'], path);
      write(tracked, original);
      s.native(['checkout', '-b', 'manual-branch'], path);
      const record = readFileSync(mode === 'direct-commit'
        ? join(s.target + '.gidd', String(issue), 'state.json')
        : join(s.target + '.gidd', 'storage.json'), 'utf8');
      s.control.calls.length = 0;
      for (const action of ['workspace', 'push', 'merge', 'target-sync', 'close-issue', 'cleanup']) {
        const args = [String(issue)];
        await assert.rejects(s.command(action, args), error => {
          assert.equal(error.message, 'workspace_branch_changed');
          assert.deepEqual(error.details, { path, expected_branch: expected, actual_branch: 'manual-branch' });
          const report = workspaceReport({ schema: 'gidd.task-command/v1', status: 'error', reason: error.message,
            ...error.workspace, details: error.details });
          assert.equal(report.schema, 'gidd.task-command/v1');
          assert.equal(report.workspace.branch, expected);
          assert.equal(report.workspace.state, 'needs_check');
          assert.deepEqual(report.details, { code: 'workspace_branch_changed', ...error.details });
          assert.equal(Object.hasOwn(report, 'reason'), false); assert.equal(report.workspace.details, undefined);
          for (const field of ['id', 'record', 'git']) assert.equal(Object.hasOwn(report, field), false);
          return true;
        });
      }
      assert.ok(s.control.calls.every(args => !args.some(arg => ['api', 'auth', 'push', 'fetch', 'ls-remote'].includes(arg))));
      assert.equal(readFileSync(mode === 'direct-commit'
        ? join(s.target + '.gidd', String(issue), 'state.json')
        : join(s.target + '.gidd', 'storage.json'), 'utf8'), record);
      s.native(['checkout', '--detach', 'HEAD'], path);
      await assert.rejects(s.command('status', [String(issue)]), error => {
        assert.deepEqual(error.details, { path, expected_branch: expected, actual_branch: null });
        return true;
      });
      s.native(['switch', expected], path);
      const restored = await s.command('status', [String(issue)]);
      assert.equal(restored.workspace.branch, expected); assert.equal(restored.workspace.state, 'assigned');
    } finally { s.dispose(); }
  });
}

test('changed configuration, mismatched URLs, branch changes and network failures retain resources', async () => {
  const s = installation();
  try {
    const a = await s.command('workspace', ['8']);
    s.native(['remote', 'add', 'other', 'https://github.com/test/other.git']);
    s.native(['config', 'branch.main.pushRemote', 'other']);
    await assert.rejects(s.command('push', ['8']), /delivery_remote_changed/);
    s.native(['config', '--unset', 'branch.main.pushRemote']);
    s.native(['config', 'remote.origin.pushurl', 'https://github.com/test/other.git']);
    await assert.rejects(s.command('push', ['8']), /delivery_remote_changed/);
    s.native(['config', '--unset', 'remote.origin.pushurl']);
    s.native(['checkout', '-b', 'renamed'], a.workspace.path);
    await assert.rejects(s.command('push', ['8']), /workspace_branch_changed/);
    s.native(['checkout', 'gidd-issue-8'], a.workspace.path);
    s.control.intercept = async (exe, args) => args.includes('push') ? { ok: false, reason: 'command_failed' } : undefined;
    await assert.rejects(s.command('push', ['8']), /delivery_remote_failed/);
    s.control.intercept = null; s.control.fetchFailure = true;
    await assert.rejects(s.command('cleanup', ['8']), /delivery_remote_failed/);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    assert.equal((await s.show(a.workspace.path)).worktree.state, 'assigned');
    assert.equal(existsSync(join(s.target + '.gidd', '.lock')), false);
  } finally { s.dispose(); }
});

test('task flows and accounts remain independent of later selections and active gh accounts', async () => {
  const s = installation();
  try {
    const registered = await s.command('workspace', ['8', '--flow', '01/00']);
    assert.equal(registered.github_account, 'tester');
    const state = join(s.target + '.gidd', '8/state.json'), original = readFileSync(state, 'utf8');
    recordFlowUse(flowStorage(s.target), flowSnapshot(readFlow('02/00')));
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
    await assert.rejects(s.invoke('workspace', ['8', '--flow', '02/00']), /task_flow_changed/);
    assert.equal(readFileSync(state, 'utf8'), original);
    assert.equal((await s.invoke('status', ['8'])).github_account, 'tester');
    const history = readFlowHistory({ path: s.target + '.gidd' });
    assert.equal(history.filter(entry => entry.selector === registered.flow.selector).length, 1);
    s.control.calls.length = 0;
    const prepared = await s.command('workspace', ['8']);
    assert.equal(prepared.workspace.delivery_mode, 'direct-merge');
    assert.ok(s.control.calls.every(args => args[0] !== 'auth'));
    s.control.intercept = (exe, args) => exe === process.execPath && args.includes('user') ? { ok: true, text: 'another' } : undefined;
    await assert.rejects(s.command('close-issue', ['8']), /unexpected_account/);
    assert.equal(JSON.parse(readFileSync(state)).github_account, 'tester');
    await s.command('cleanup', ['8']);
    assert.deepEqual(readFlowHistory({ path: s.target + '.gidd' }), history);
  } finally { s.dispose(); }
});

test('resume and direct delivery use only local context after Issue edits or credential loss', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('new workspaces reject closed Issues, missing flows and duplicate bindings', async () => {
  const s = installation();
  try {
    assert.throws(() => parseIssueTaskArguments('1', ['--flow']), /invalid_arguments/);
    await assert.rejects(s.invoke('status', ['1']), /task_required/);
    s.native(['checkout', '--detach']);
    await assert.rejects(s.command('workspace', ['1']), /delivery_target_branch_required/);
    s.native(['checkout', 'main']);
    s.native(['branch', 'gidd-issue-2']);
    await assert.rejects(s.command('workspace', ['2']), /worktree_branch_exists/);
    await assert.rejects(s.invoke('workspace', ['1', '--flow', 'invalid-selection']), /flow_/);
    s.control.issues.get(1).state = 'closed';
    await assert.rejects(s.command('workspace', ['1']), /issue_closed/);
    s.control.issues.get(1).state = 'open';
    await s.command('workspace', ['1']);
    s.control.issues.get(1).state = 'closed';
    assert.equal((await s.command('workspace', ['1'])).issue.number, 1);
    assert.equal((await s.command('status', ['1'])).issue.number, 1);
  } finally { s.dispose(); }
});

test('PR proof failures and partial cleanup remain inspectable and retry through delivery commands', async () => {
  const s = installation();
  try {
    const { workspace } = await s.delivery(), pr = s.control.pr;
    s.control.pr = null;
    await assert.rejects(s.command('target-sync', ['7']), /worktree_pr_not_found/);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    s.control.pr = pr;
    await s.command('target-sync', ['7']);
    s.control.intercept = async (exe, args) => args.includes('push') && args.some(arg => arg.startsWith(':refs/heads/'))
      ? { ok: false, reason: 'command_failed' } : undefined;
    const failed = await s.command('cleanup', ['7']);
    assert.equal(failed.status, 'error'); assert.equal(failed.retry, '7.cleanup');
    assert.deepEqual(failed.details, { code: 'worktree_remote_failed' });
    assert.equal(failed.workspace.details, undefined); assert.equal(Object.hasOwn(failed, 'reason'), false);
    assert.equal(failed.workspace.detached, true); assert.equal(failed.local_branch_deleted, false);
    assert.equal(failed.workspace.state, 'needs_check');
    const continued = await s.command('status', ['7']);
    assert.equal(continued.workspace.state, 'needs_check');
    assert.deepEqual(continued.workspace.details, { code: 'worktree_cleanup_pending' });
    assert.equal(continued.details, undefined); assert.equal(Object.hasOwn(continued, 'reason'), false);
    assert.equal(continued.workspace.head, pr.head.sha);
    assert.equal(Object.hasOwn(continued.workspace, 'checked_out_branch'), false);
    assert.equal(continued.workspace.branch, 'gidd-issue-7');
    assert.equal(continued.workspace.detached, true);
    s.native(['checkout', '--detach', s.initial], workspace.workspace.path);
    await assert.rejects(s.command('status', ['7']), error => {
      assert.equal(error.message, 'workspace_branch_changed');
      assert.deepEqual(error.details, { path: workspace.workspace.path, expected_branch: 'gidd-issue-7', actual_branch: null });
      return true;
    });
    s.native(['checkout', '--detach', pr.head.sha], workspace.workspace.path);
    await assert.rejects(s.command('push', ['7']), /task_cleanup_pending/);
    // Ref deletion can succeed before branch configuration cleanup fails.
    // The original name must still locate the persisted cleanup record.
    s.native(['config', 'branch.gidd-issue-7.description', 'cleanup fixture']);
    s.control.intercept = async (exe, args) => args.includes('--remove-section')
      ? { ok: false, reason: 'command_failed' } : undefined;
    const deleted = await s.command('cleanup', ['7']);
    assert.equal(deleted.status, 'error'); assert.equal(deleted.local_branch_deleted, true);
    assert.equal(deleted.retry, '7.cleanup');
    assert.equal(s.native(['branch', '--list', 'gidd-issue-7']), '');
    const detached = await s.command('status', ['7']);
    assert.equal(detached.workspace.branch, 'gidd-issue-7');
    assert.equal(Object.hasOwn(detached.workspace, 'checked_out_branch'), false);
    assert.equal(detached.workspace.head, pr.head.sha);
    assert.equal((await s.command('status', ['7'], workspace.workspace.path)).workspace.state, 'needs_check');
    s.control.intercept = null;
    const completed = await s.command('cleanup', ['7']);
    assert.equal(completed.status, 'success'); assert.equal(completed.workspace.state, 'available');
    assert.equal(completed.workspace.details, undefined); assert.equal(completed.details, undefined);
  } finally { s.dispose(); }
});

test('local merge preserves dirty targets and conflicts, and uses the requested message for a merge commit', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('local squash records the source and result, supports later target commits, and completes delivery', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
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

test('local squash preserves additional source work and refuses a reset target', async () => {
  for (const change of ['source', 'target']) {
    const s = installation();
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
    } finally { s.dispose(); }
  }
});

test('local squash resumes interruptions before staging, before commit, and after commit without duplication', async () => {
  for (const interruption of ['before-stage', 'before-commit', 'after-commit']) {
    const s = installation();
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
    } finally { s.dispose(); }
  }
});

test('local squash does not commit additional staged or unstaged files during recovery', async () => {
  for (const staged of [false, true]) {
    const s = installation();
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
    } finally { s.dispose(); }
  }
});

test('local squash recovers a completed commit before later target commits and can verify without replaying merge', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('local squash recovery rejects a changed result tree and preserves the working branch', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('local squash detects conflicts before changing the target', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('local squash refuses to commit if the target checkout switches branches after staging', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('local squash records delivery when the combined change is empty', async () => {
  const s = installation();
  try {
    const workspace = await s.command('workspace', ['2']);
    s.native(['commit', '--allow-empty', '-m', 'empty source change'], workspace.workspace.path);
    const merged = await s.command('merge', ['2', '--squash']);
    assert.equal(s.native(['log', '-1', '--format=%P']), s.initial);
    assert.equal(s.native(['rev-parse', 'main^{tree}']), s.native(['rev-parse', s.initial + '^{tree}']));
    assert.equal((await s.command('merge', ['2'])).merge_commit, merged.merge_commit);
    await s.command('push', ['2']);
    assert.equal((await s.command('cleanup', ['2'])).local_branch_deleted, true);
  } finally { s.dispose(); }
});

test('local merge updates an unoccupied target only by fast-forward and leaves the caller branch intact', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('PR merge requires a unique current head, confirms delivery and can be safely retried', async () => {
  const s = installation();
  try {
    const workspace = await s.command('workspace', ['7']);
    s.control.issues.delete(7);
    const head = s.change(workspace.workspace.path);
    await s.command('push', ['7']);
    const pr = { number: 42, state: 'open', draft: false, merged: false,
      head: { ref: 'gidd-issue-7', sha: head, repo: { full_name: 'test/repo' } },
      base: { ref: 'main', repo: { full_name: 'test/repo' } } };
    s.control.pr = { ...pr, base: { ...pr.base, ref: 'other-target' } };
    await assert.rejects(s.command('merge', ['7']), /worktree_pr_not_found/);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    s.control.pr = { ...pr, head: { ...pr.head, sha: s.initial } };
    await assert.rejects(s.command('merge', ['7']), /pr_head_changed/);
    s.control.pr = [pr, { ...pr, number: 43 }];
    await assert.rejects(s.command('merge', ['7']), /worktree_pr_ambiguous/);
    s.control.pr = { ...pr, draft: true };
    await assert.rejects(s.command('merge', ['7']), /pr_draft/);
    assert.equal(s.control.calls.some(args => args.includes('PUT')), false);
    s.control.pr = pr;
    s.control.mergeResponse = { merged: false };
    await assert.rejects(s.command('merge', ['7']), /pr_merge_pending/);
    delete s.control.mergeResponse;
    const merged = await s.command('merge', ['7', '--squash', '--message', 'feat: ship the Issue']);
    assert.equal(merged.merged, true); assert.equal(merged.pr, 42); assert.equal(merged.already_merged, false);
    const call = s.control.calls.findLast(args => args.includes('PUT'));
    assert.ok(call.includes('sha=' + head)); assert.ok(call.includes('merge_method=squash'));
    assert.ok(call.includes('commit_title=feat: ship the Issue'));
    // Merging alone leaves synchronization and cleanup to their own stages.
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'assigned');
    const mutations = s.control.calls.filter(args => args.includes('PUT')).length;
    assert.equal((await s.command('merge', ['7'])).already_merged, true);
    assert.equal(s.control.calls.filter(args => args.includes('PUT')).length, mutations);
    await s.command('target-sync', ['7']);
    assert.equal((await s.command('cleanup', ['7'])).local_branch_deleted, true);
  } finally { s.dispose(); }
});

for (const [issue, mode] of [[1, 'direct-commit'], [2, 'direct-merge'], [7, 'pr-merge']]) {
  test(`${mode} preparation fast-forwards only the target and records its updated starting point`, async () => {
    const s = installation();
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
    } finally { s.dispose(); }
  });

  for (const state of ['ahead', 'diverged']) test(`${mode} preparation stops when the local target is ${state}`, async () => {
    const s = installation();
    try {
      const incoming = state === 'diverged' ? s.advanceRemote() : s.initial;
      const local = s.change(s.target, 'unpublished work');
      await assert.rejects(s.command('workspace', [String(issue)]), new RegExp('delivery_target_' + state));
      await noPreparedResources(s, local);
      assert.equal(s.native(['rev-parse', 'main'], s.bare), incoming);
      assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'unpublished work\n');
      assert.equal(s.control.calls.some(args => args.includes('push')), false);
    } finally { s.dispose(); }
  });

  test(`${mode} preparation handles an absent remote target without publishing it`, async () => {
    const s = installation();
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
    } finally { s.dispose(); }
  });

  test(`${mode} resume leaves an outdated target and the original starting point unchanged offline`, async () => {
    const s = installation();
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
    } finally { s.dispose(); }
  });
}

test('preparation preserves target edits, hidden index changes and unfinished Git operations', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('preparation rejects fetch failures and concurrent target changes before allocating resources', async () => {
  for (const state of ['fetch-failure', 'branch-switch', 'allocation-race']) {
    const s = installation();
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
    } finally { s.dispose(); }
  }
});

test('preparation rejects occupied resources and closed Issues before advancing the target', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('direct-commit closure requires published target commits and preserves the context and user files', async () => {
  const s = installation();
  try {
    await s.command('workspace', ['1']); s.change(s.target);
    write(join(s.target, 'keep.tmp'), 'user file');
    const recordPath = join(s.target + '.gidd', '1/state.json');
    const original = readFileSync(recordPath, 'utf8');
    await assert.rejects(s.command('close-issue', ['1']), error => {
      assert.equal(error.message, 'delivery_target_not_pushed');
      assert.equal(error.workspace.retry, '1.close-issue');
      const failed = workspaceReport({ schema: 'gidd.task-command/v1', status: 'error', reason: error.message, ...error.workspace });
      assert.deepEqual(failed.details, { code: 'delivery_target_not_pushed' });
      assert.equal(Object.hasOwn(failed, 'reason'), false); assert.equal(failed.workspace.details, undefined);
      assert.equal(failed.workspace.state, 'assigned');
      assert.equal(failed.workspace.delivery_mode, 'direct-commit');
      assert.equal(Object.hasOwn(failed, 'delivery_mode'), false);
      return true;
    });
    assert.equal(s.control.issues.get(1).state, 'open');
    await s.command('push', ['1']); write(join(s.target, 'keep.tmp'), 'user file');
    // Existing delivery settings remain authoritative after a flow change.
    s.select('pr-merge');
    const result = await s.command('close-issue', ['1']);
    assert.equal(result.status, 'success'); assert.equal(result.issue_closed, true);
    assert.equal(result.workspace.state, 'assigned');
    assert.equal(result.workspace.delivery_mode, 'direct-commit'); assert.equal(result.already_closed, false);
    assert.equal(result.pr, undefined);
    assert.equal((await s.command('close-issue', ['1'])).already_closed, true);
    assert.equal(s.control.calls.filter(args => args.includes('PATCH')).length, 1);
    assert.equal(s.control.calls.some(args => args.at(-1) === 'graphql'), false);
    assert.equal(readFileSync(recordPath, 'utf8'), original);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    assert.equal((await s.command('status', ['1'])).workspace.state, 'assigned');
  } finally { s.dispose(); }
});

test('direct-merge closure requires the working branch tip to be merged and pushed, without releasing it', async () => {
  const s = installation();
  try {
    const workspace = await s.command('workspace', ['2']);
    const head = s.change(workspace.workspace.path);
    await assert.rejects(s.command('close-issue', ['2']), /worktree_not_delivered/);
    await s.command('merge', ['2']);
    await assert.rejects(s.command('close-issue', ['2']), /delivery_target_not_pushed/);
    assert.equal(s.control.calls.some(args => args.includes('PATCH')), false);
    await s.command('push', ['2']);
    assert.equal((await s.command('close-issue', ['2'], workspace.workspace.path)).issue_closed, true);
    assert.equal(s.native(['rev-parse', 'gidd-issue-2']), head);
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'assigned');
    assert.equal(s.control.issues.get(2).state, 'closed');
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
  } finally { s.dispose(); }
});

test('PR closure verifies unique delivery and target synchronization before creating an association', async () => {
  const s = installation();
  try {
    const { workspace, merge } = await s.delivery();
    s.control.issues.set(7, { number: 7, node_id: 'I_7', state: 'open', html_url: 'https://github.com/test/repo/issues/7' });
    const pr = s.control.pr;
    s.control.pr = { ...pr, state: 'open', merged: false };
    await assert.rejects(s.command('close-issue', ['7']), /worktree_pr_not_found/);
    s.control.pr = { ...pr, head: { ...pr.head, sha: s.initial } };
    await assert.rejects(s.command('close-issue', ['7']), /worktree_pr_not_found/);
    s.control.pr = [pr, { ...pr, number: 43 }];
    await assert.rejects(s.command('close-issue', ['7']), /worktree_pr_ambiguous/);
    s.control.pr = pr;
    s.native(['update-ref', 'refs/heads/main', s.initial, merge], s.bare);
    await assert.rejects(s.command('close-issue', ['7']), /delivery_remote_not_delivered/);
    s.native(['update-ref', 'refs/heads/main', merge, s.initial], s.bare);
    await assert.rejects(s.command('close-issue', ['7']), /delivery_target_not_synced/);
    assert.equal(s.control.calls.some(args => args.at(-1) === 'graphql' || args.includes('PATCH')), false);
    await s.command('target-sync', ['7']);
    const result = await s.command('close-issue', ['7'], workspace.workspace.path);
    assert.equal(result.pr, 42); assert.equal(result.pr_linked, true); assert.equal(result.issue_closed, true);
    assert.equal(result.already_linked, false);
    const repeated = await s.command('close-issue', ['7']);
    assert.equal(repeated.already_linked, true); assert.equal(repeated.already_closed, true);
    assert.equal(s.control.calls.filter(args => args.some(arg => arg.includes('addCloseIssueReferences'))).length, 1);
    assert.equal(s.control.calls.filter(args => args.includes('PATCH')).length, 1);
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'assigned');
    assert.equal(s.native(['rev-parse', 'gidd-issue-7'], s.bare), pr.head.sha);
  } finally { s.dispose(); }
});

test('PR closure retains confirmed association progress when closing fails, then retries safely', async () => {
  const s = installation();
  try {
    const { workspace } = await s.delivery();
    s.control.issues.set(7, { number: 7, node_id: 'I_7', state: 'open', html_url: 'https://github.com/test/repo/issues/7' });
    await s.command('target-sync', ['7']);
    s.control.intercept = async (exe, args) => args.includes('PATCH') ? { ok: false, reason: 'command_failed' } : undefined;
    await assert.rejects(s.command('close-issue', ['7']), error => {
      assert.equal(error.workspace.pr_linked, true); assert.equal(error.workspace.pr, 42);
      assert.equal(error.workspace.issue_closed, undefined);
      assert.equal(error.workspace.retry, '7.close-issue'); return true;
    });
    assert.equal(s.control.issues.get(7).state, 'open');
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'assigned');
    s.control.intercept = null;
    assert.equal((await s.command('close-issue', ['7'])).already_linked, true);
    assert.equal(s.control.calls.filter(args => args.some(arg => arg.includes('addCloseIssueReferences'))).length, 1);
    assert.equal(existsSync(join(s.target + '.gidd', '.lock')), false);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
  } finally { s.dispose(); }
});

test('closure detects a concurrent development change before making GitHub mutations', async () => {
  const s = installation();
  try {
    const { workspace } = await s.delivery();
    s.control.issues.set(7, { number: 7, node_id: 'I_7', state: 'open', html_url: 'https://github.com/test/repo/issues/7' });
    await s.command('target-sync', ['7']);
    s.control.intercept = async (exe, args) => {
      if (args.at(-1)?.endsWith('/issues/7')) {
        s.control.intercept = null; s.change(workspace.workspace.path, 'concurrent development');
      }
    };
    await assert.rejects(s.command('close-issue', ['7']), /delivery_target_changed/);
    assert.equal(s.control.issues.get(7).state, 'open');
    assert.equal(s.control.calls.some(args => args.includes('PATCH') || args.some(arg => arg.includes('addCloseIssueReferences'))), false);
    assert.equal((await s.show(workspace.workspace.path)).worktree.state, 'assigned');
  } finally { s.dispose(); }
});

test('local squash preserves content added in source merge commits', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('local squash uses its planned tree despite user merge configuration', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('local merge rejects rebase before changing branches or creating a replay checkout', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('PR merge retains rebase and completes synchronization and cleanup', async () => {
  const s = installation();
  try {
    const workspace = await s.command('workspace', ['7']), source = s.change(workspace.workspace.path);
    await s.command('push', ['7']);
    s.control.pr = { number: 42, state: 'open', draft: false, merged: false,
      head: { ref: 'gidd-issue-7', sha: source, repo: { full_name: 'test/repo' } },
      base: { ref: 'main', repo: { full_name: 'test/repo' } } };
    const merged = await s.command('merge', ['7', '--rebase']);
    assert.equal(merged.merged, true); assert.equal(merged.pr, 42);
    const call = s.control.calls.findLast(args => args.includes('PUT'));
    assert.ok(call.includes('merge_method=rebase')); assert.ok(call.includes('sha=' + source));
    assert.equal(call.some(arg => arg.startsWith('commit_title=')), false);
    assert.equal(s.native(['rev-parse', 'gidd-issue-7']), source);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    assert.equal((await s.show(workspace.workspace.path)).record.local_merge, undefined);
    assert.equal((await s.command('merge', ['7', '--rebase'])).already_merged, true);
    await s.command('target-sync', ['7']);
    assert.equal(s.native(['rev-parse', 'main']), source);
    assert.equal((await s.command('cleanup', ['7'])).local_branch_deleted, true);
  } finally { s.dispose(); }
});

test('creation retries a failed remote verification without treating it as an uncertain POST', async () => {
  const s = installation();
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
  } finally { s.dispose(); }
});

test('creation freezes submitted content and its hash before a concurrent draft edit', {
  skip: process.versions.bun ? 'Bun does not update named fs exports for read fault injection' : false,
}, async () => {
  const s = installation(), originalRead = fs.readFileSync;
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
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); s.dispose(); }
});

test('a failed task removal keeps its released workspace reserved until cleanup can retry', {
  skip: process.versions.bun ? 'Bun does not update named fs exports for unlink fault injection' : false,
}, async () => {
  const s = installation(), originalUnlink = fs.unlinkSync;
  try {
    const first = await s.command('workspace', ['2']), path = first.workspace.path;
    s.change(path); await s.command('merge', ['2']); await s.command('push', ['2']);
    const state = join(s.target + '.gidd', '2/state.json');
    fs.unlinkSync = file => {
      if (String(file) === state) throw new Error('fixture_task_remove_failed');
      return originalUnlink(file);
    };
    syncBuiltinESMExports();
    await assert.rejects(s.command('cleanup', ['2']), /fixture_task_remove_failed/);
    fs.unlinkSync = originalUnlink; syncBuiltinESMExports();
    assert.equal((await s.show(path)).worktree.state, 'available');
    await assert.rejects(worktreeCommand(s.target, { action: 'remove', path }), /task_cleanup_pending/);
    const second = await s.command('workspace', ['8']);
    assert.notEqual(second.id, first.id);
    assert.equal((await s.show(path)).record.issue, 2);
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).workspace, first.id);
    assert.equal((await s.command('cleanup', ['2'])).workspace.state, 'available');
    assert.equal(existsSync(state), false);
    assert.equal((await s.command('status', ['8'])).workspace.path, second.workspace.path);
  } finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); s.dispose(); }
});

test('registered workspaces recover saved flows after presets change or disappear', async () => {
  const s = installation();
  try {
    const prepared = await s.invoke('workspace', ['8', '--flow', '01/00']);
    const state = join(s.target + '.gidd', '8/state.json'), saved = JSON.parse(readFileSync(state, 'utf8'));
    s.control.fetchFailure = true;
    for (const number of ['2', '10'])
      await assert.rejects(s.invoke('workspace', [number, '--flow', '01/00']), /delivery_remote_failed/);
    s.control.fetchFailure = false;
    const history = readFileSync(join(s.target + '.gidd', 'flow-history.jsonl'), 'utf8');
    const { copySkill } = await import('./support/helpers.mjs');
    const { pathToFileURL } = await import('node:url');
    const skill = join(s.root, 'skill');
    copySkill(skill);
    const { issueTaskCommand: copiedCommand } = await import(pathToFileURL(join(skill, 'scripts.js/commands/issue-task/index.mjs')).href);
    const resume = (number, flow = saved.flow.selector) => copiedCommand(s.target,
      parseIssueTaskArguments(number, ['--flow', flow]), { execute: s.execute, cwd: s.target }).then(workspaceReport);
    const preset = join(skill, 'flows', saved.flow.selector + '.toml');
    const original = readFileSync(preset, 'utf8');
    const changed = original.replace(/^direct_merge\s*=\s*"auto"/m, 'direct_merge = "ask"');
    assert.notEqual(changed, original);
    write(preset, changed);
    for (const selector of [saved.flow.selector, '01/00']) {
      const repeated = await resume('8', selector);
      assert.equal(repeated.workspace.path, prepared.workspace.path);
      assert.deepEqual(repeated.flow, saved.flow);
    }
    assert.deepEqual((await resume('2', '01/00')).flow, saved.flow);
    await assert.rejects(resume('8', '00/00'), /task_flow_changed/);
    unlinkSync(preset);
    assert.deepEqual((await resume('8')).flow, saved.flow);
    const pending = await s.invoke('status', ['10']);
    assert.equal(pending.workspace.state, 'needs_check');
    assert.equal(pending.next, '10 --flow ' + saved.flow.selector);
    const [number, ...args] = pending.next.split(' ');
    const completed = workspaceReport(await copiedCommand(s.target, parseIssueTaskArguments(number, args),
      { execute: s.execute, cwd: s.target }));
    assert.equal(completed.workspace.state, 'assigned');
    assert.deepEqual(completed.flow, saved.flow);
    await assert.rejects(resume('7'), /flow_resources_missing/);
    assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), saved);
    assert.equal(readFileSync(join(s.target + '.gidd', 'flow-history.jsonl'), 'utf8'), history);
  } finally { s.dispose(); }
});
