import { contextName } from '../.agents/skills/gidd/scripts.js/shared/managed-storage.mjs';
import { test } from 'node:test';
import { realpathSync, unlinkSync } from 'node:fs';
import { parseWorkflowArguments, workflowCommand } from '../.agents/skills/gidd/scripts.js/commands/workflow/index.mjs';
import { worktreeCommand } from '../.agents/skills/gidd/scripts.js/commands/worktree/index.mjs';
import { runCommand } from '../.agents/skills/gidd/scripts.js/shared/process.mjs';
import { workspaceReport } from '../.agents/skills/gidd/scripts.js/shared/workspace-report.mjs';
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
  const configuration = 'schema_version = 1\n[repo]\nremote.name = "origin"\nremote.url = "https://github.com/test/repo"\nremote.account = "tester"\n[git]\nuser.mode = "inherit"\ncredential.mode = "inherit"\n';
  write(config, configuration);
  initializeDataFixture(target);
  const control = { issues: new Map(), links: new Map(), pr: null, calls: [], intercept: null, fetchFailure: false };
  const plans = new Map([[1, 'direct-commit'], [10, 'direct-commit'], [2, 'direct-merge'],
    [3, 'pr-merge'], [4, 'pr-merge'], [5, 'pr-merge'], [6, 'pr-merge'], [7, 'pr-merge'], [8, 'direct-merge']]);
  for (const number of plans.keys()) control.issues.set(number, {
    number, node_id: 'I_' + number, state: 'open', html_url: 'https://github.com/test/repo/issues/' + number, body: 'Requirements and acceptance',
  });
  const select = mode => {
    const id = { 'direct-commit': '00', 'direct-merge': '01', 'pr-merge': '02' }[mode];
    write(config, configuration + '[spec]\ncurrent = "' + id + '/00"\n');
  };
  const execute = async (exe, args, options) => {
    control.calls.push(args);
    const intercepted = await control.intercept?.(exe, args, options);
    if (intercepted) return intercepted;
    if (exe === process.execPath) {
      if (args[0] === 'auth') return { ok: true, text: 'fixture-token' };
      assert.equal(options.env.GH_TOKEN, 'fixture-token');
      if (args.includes('user')) return { ok: true, text: 'tester' };
      const endpoint = args.at(-1);
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
      ? ['-c', `url.${bare.replaceAll('\\', '/')}.insteadOf=https://github.com/test/repo.git`, ...args] : args;
    const result = await runCommand(exe, redirected, options);
    return control.fetchFailure && args.includes('fetch') && result.ok ? { ok: false, reason: 'command_failed' } : result;
  };
  const invoke = (action, args = [], cwd = target) => workflowCommand(target, parseWorkflowArguments('workflow.' + action, args), { execute, cwd }).then(workspaceReport);
  const command = (action, args = [], cwd = target) => {
    if (action === 'workspace' && args[0] !== '--resume') select(plans.get(Number(args[0])) ?? 'direct-commit');
    return invoke(action, args, cwd);
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
    const head = change(workspace.worktree.path);
    await command('push', ['7'], workspace.worktree.path);
    native(['merge', '--squash', 'codex/issue-7']); native(['commit', '-m', 'squash delivery']);
    const merge = native(['rev-parse', 'HEAD']); native(['push', bare, 'main']); native(['reset', '--hard', initial]);
    control.pr = { number: 42, node_id: 'PR_42', state: 'closed', merged: true, merged_at: '2026-10-03T00:00:00Z', merge_commit_sha: merge,
      head: { ref: 'codex/issue-7', sha: head, repo: { full_name: 'test/repo' } }, base: { ref: 'main', repo: { full_name: 'test/repo' } } };
    return { workspace, head, merge };
  }
  return { ...f, git, target, bare, initial, native, config, configuration, control, select, invoke, binding, command, show, change, advanceRemote, delivery };
}

async function noPreparedResources(s, head) {
  assert.equal(s.native(['rev-parse', 'main']), head);
  assert.equal(s.native(['branch', '--list', 'codex/issue-*']), '');
  assert.equal((await worktreeCommand(s.target, { action: 'list' })).worktrees.length, 0);
  assert.equal(existsSync(join(s.target + '.gidd', 'state/workflows', contextName(join(s.target, '.git')))), false);
  assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
  assert.equal(existsSync(join(s.target, '.agents/skills/gidd/config.toml.lock')), false);
}

test('workflow interfaces require an explicit Issue and reject branches, paths and mode overrides', () => {
  assert.deepEqual(parseWorkflowArguments('workflow.workspace', ['7']), { action: 'workspace', issue: 7 });
  assert.equal(parseWorkflowArguments('workflow.workspace', ['--resume', '7']).resume, true);
  assert.equal(parseWorkflowArguments('workflow.merge', ['7', '--squash']).method, 'squash');
  assert.deepEqual(parseWorkflowArguments('workflow.close-issue', ['7']), { action: 'close-issue', issue: 7 });
  for (const action of ['workspace', 'push', 'merge', 'target-sync', 'close-issue', 'cleanup']) {
    for (const args of [[], ['main'], ['D:/repo'], ['0'], ['-1'], ['01'], ['9007199254740992'], ['7', '--pr'], ['7','8']])
      assert.throws(() => parseWorkflowArguments('workflow.' + action, args), /invalid_arguments/);
  }
  for (const args of [['--resume'], ['--resume', 'main'], ['--resume', '7', '--pr']])
    assert.throws(() => parseWorkflowArguments('workflow.workspace', args), /invalid_arguments/);
  assert.throws(() => parseWorkflowArguments('workflow.merge', ['7', '--squash', '--rebase']), /invalid_arguments/);
});

test('current workspace retains its starting point, pushes only the target and cleans only its context', async () => {
  const s = installation();
  try {
    const prepared = await s.command('workspace', ['1']);
    assert.equal(prepared.status, 'success');
    assert.deepEqual(prepared.target.remote, { name: 'origin', url: 'https://github.com/test/repo' });
    assert.equal(Object.hasOwn(prepared, 'workflow'), false);
    assert.equal(prepared.worktree.delivery_mode, 'direct-commit');
    assert.equal(prepared.target.repository, s.target);
    assert.equal(prepared.worktree.path, s.target);
    for (const field of ['workspace_path', 'workspace_state', 'worktree_path', 'worktree_state', 'target_repository', 'target_branch', 'delivery_mode', 'start_commit', 'development_branch']) assert.equal(Object.hasOwn(prepared, field), false);
    assert.equal(prepared.worktree.development_branch, null);
    assert.equal(prepared.target.branch, 'main'); assert.equal(prepared.worktree.start_commit, s.initial);
    const resumed = await s.command('workspace', ['--resume', '1']);
    assert.equal(resumed.worktree.path, s.target);
    assert.equal(resumed.worktree.delivery_mode, 'direct-commit');
    assert.equal(Object.hasOwn(resumed, 'delivery_mode'), false);
    assert.equal(resumed.worktree.state, 'current');
    assert.equal(resumed.worktree.head, s.initial);
    assert.equal(resumed.worktree.checked_out_branch, 'main');
    assert.equal(Object.hasOwn(resumed, 'state'), false);
    await assert.rejects(s.command('target-sync', ['1']), /workflow_not_applicable/);
    const recordPath = join(s.target + '.gidd', 'state/workflows', contextName(join(s.target, '.git')));
    const originalRecord = readFileSync(recordPath, 'utf8');
    await assert.rejects(s.command('workspace', ['1']), /workflow_issue_registered/);
    assert.equal(readFileSync(recordPath, 'utf8'), originalRecord);
    const head = s.change(s.target);
    s.native(['branch', 'other']); s.native(['tag', '-a', 'do-not-push', '-m', 'tag']);
    s.native(['config', 'push.followTags', 'true']); s.native(['config', 'remote.origin.mirror', 'true']);
    write(s.config, s.configuration + '[spec]\ncurrent = "02/00.auto"\n');
    const continued = await s.command('workspace', ['--resume', '1']);
    assert.equal(continued.worktree.start_commit, s.initial);
    assert.equal(continued.worktree.head, head);
    assert.equal(continued.worktree.checked_out_branch, 'main');
    await assert.rejects(s.command('cleanup', ['1']), /workflow_target_not_pushed/);
    const pushed = await s.command('push', ['1']);
    assert.equal(pushed.worktree.path, prepared.worktree.path);
    assert.equal(pushed.worktree.development_branch, null);
    assert.equal(pushed.pushed_branch, 'main'); assert.equal(pushed.pushed_commit, head);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)'], s.bare), 'refs/heads/main');
    write(join(s.target, 'keep.tmp'), 'user file');
    assert.equal((await s.command('cleanup', ['1'])).context_removed, true);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
    assert.equal(s.native(['branch', '--show-current']), 'main');
    assert.equal(existsSync(join(s.target + '.gidd', 'state/workflows', contextName(join(s.target, '.git')))), false);
    await assert.rejects(s.command('push', ['999']), /workflow_context_required/);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    const next = await s.command('workspace', ['10']);
    assert.equal(next.worktree.start_commit, head);
    assert.equal(next.target.branch, 'main');
    assert.equal(next.worktree.path, prepared.worktree.path);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
  } finally { s.dispose(); }
});

test('dedicated direct delivery requires merge, selects the target and releases the recorded workspace', async () => {
  const s = installation();
  try {
    const a = await s.command('workspace', ['2']);
    assert.equal(a.schema, 'gidd.workflow/v1'); assert.equal(a.worktree.delivery_mode, 'direct-merge');
    assert.equal(realpathSync.native(a.worktree.path), a.worktree.path);
    const head = s.change(a.worktree.path);
    const continued = await s.command('workspace', ['--resume', '2']);
    assert.equal(continued.worktree.head, head);
    assert.equal(continued.worktree.start_commit, s.initial);
    assert.equal(continued.worktree.checked_out_branch, 'codex/issue-2');
    await assert.rejects(s.command('push', ['999']), /workflow_context_required/);
    await assert.rejects(s.command('push', ['2'], a.worktree.path), /worktree_not_delivered/);
    assert.equal((await s.command('merge', ['2'])).target.head, head);
    await assert.rejects(s.command('cleanup', ['2']), /workflow_target_not_pushed/);
    const result = await s.command('push', ['2']);
    assert.equal(result.pushed_branch, 'main'); assert.equal(result.pushed_commit, head);
    assert.equal(s.native(['branch', '--list', 'codex/issue-2'], s.bare), '');
    assert.equal((await s.command('cleanup', ['2'])).local_branch_deleted, true);
    assert.equal((await s.show(a.worktree.path)).worktree.state, 'available');
    await assert.rejects(s.command('workspace', ['--resume', '2']), /workflow_workspace_released/);
    const b = await s.command('workspace', ['3']);
    assert.equal(b.worktree.path, a.worktree.path); assert.equal(b.worktree.delivery_mode, 'pr-merge');
    assert.equal((await s.show(b.worktree.path)).record.workflow.mode, 'pr-merge');
  } finally { s.dispose(); }
});

test('PR preparation checks remote branches; parallel workspaces never share a guessed current task', async () => {
  const s = installation();
  try {
    s.native(['branch', 'absent']);
    s.native(['checkout', 'absent']);
    await assert.rejects(s.command('workspace', ['4']), /workflow_remote_target_missing/);
    s.native(['checkout', 'main']);
    s.native(['push', s.bare, 'main:refs/heads/codex/issue-6']);
    await assert.rejects(s.command('workspace', ['6']), /workflow_remote_branch_exists/);
    const a = await s.command('workspace', ['4']);
    const b = await s.command('workspace', ['5']);
    assert.notEqual(a.worktree.path, b.worktree.path);
    s.change(a.worktree.path, 'one'); s.change(b.worktree.path, 'two');
    assert.equal((await s.command('push', ['4'], a.worktree.path)).pushed_branch, 'codex/issue-4');
    assert.equal(s.native(['branch', '--list', 'codex/issue-5'], s.bare), '');
    assert.equal((await s.command('push', ['5'])).pushed_branch, 'codex/issue-5');
    assert.equal(s.native(['rev-parse', 'main'], s.bare), s.initial);
    await assert.rejects(s.command('push', ['999']), /workflow_context_required/);
  } finally { s.dispose(); }
});

test('PR target sync verifies squash delivery, fast-forwards the checked out target, then cleanup deletes development refs', async () => {
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
    const synced = await s.command('target-sync', ['7'], workspace.worktree.path);
    assert.equal(synced.target.head, merge);
    assert.equal(Object.hasOwn(synced.worktree, 'head'), false);
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
    assert.equal(cleaned.worktree.delivery_mode, workspace.worktree.delivery_mode);
    assert.equal(cleaned.local_branch_deleted, true); assert.equal(cleaned.remote_branch_deleted, true);
    assert.equal(s.native(['branch', '--list', 'codex/issue-7']), '');
    assert.equal(s.native(['branch', '--list', 'codex/issue-7'], s.bare), '');
    assert.equal((await s.show(workspace.worktree.path)).worktree.state, 'available');
  } finally { s.dispose(); }
});

test('sync preserves dirty, hidden and diverged target work instead of stashing or resetting it', async () => {
  const s = installation();
  try {
    await s.delivery();
    write(join(s.target, 'tracked.txt'), 'keep me\n');
    await assert.rejects(s.command('target-sync', ['7']), /workflow_target_dirty/);
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'keep me\n');
    s.native(['update-index', '--assume-unchanged', 'tracked.txt']);
    await assert.rejects(s.command('target-sync', ['7']), /workflow_target_index_flags/);
    s.native(['update-index', '--no-assume-unchanged', 'tracked.txt']);
    const diverged = s.change(s.target, 'diverged');
    await assert.rejects(s.command('target-sync', ['7']), /workflow_target_not_fast_forward/);
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
    await assert.rejects(s.command('target-sync', ['7']), /workflow_git_failed/);
    assert.equal(s.native(['rev-parse', 'main']), concurrent);
  } finally { s.dispose(); }
});

test('changed configuration, mismatched URLs, branch changes and network failures retain resources', async () => {
  const s = installation();
  try {
    const a = await s.command('workspace', ['8']);
    write(s.config, s.configuration.replace('https://github.com/test/repo', 'https://github.com/test/other'));
    await assert.rejects(s.command('push', ['8']), /workflow_remote_changed/);
    write(s.config, s.configuration);
    s.native(['config', 'remote.origin.pushurl', 'https://github.com/test/other.git']);
    await assert.rejects(s.command('push', ['8']), /workflow_remote_mismatch/);
    s.native(['config', '--unset', 'remote.origin.pushurl']);
    s.native(['checkout', '-b', 'renamed'], a.worktree.path);
    await assert.rejects(s.command('push', ['8']), /workflow_branch_changed/);
    s.native(['checkout', 'codex/issue-8'], a.worktree.path);
    s.control.intercept = async (exe, args) => args.includes('push') ? { ok: false, reason: 'command_failed' } : undefined;
    await assert.rejects(s.command('push', ['8']), /workflow_remote_failed/);
    s.control.intercept = null; s.control.fetchFailure = true;
    await assert.rejects(s.command('cleanup', ['8']), /workflow_remote_failed/);
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    assert.equal((await s.show(a.worktree.path)).worktree.state, 'unreleased');
    assert.equal(existsSync(join(s.target, '.agents/skills/gidd/config.toml.lock')), false);
  } finally { s.dispose(); }
});

test('resume and direct delivery use only local context after Issue edits or credential loss', async () => {
  const s = installation();
  try {
    const a = await s.command('workspace', ['8']);
    const head = s.change(a.worktree.path);
    s.control.issues.set(8, { state: 'closed', body: 'Change the target and delivery mode' });
    write(s.config, s.configuration + '[spec]\ncurrent = "invalid-selection"\n');
    const bindings = JSON.parse(readFileSync(s.binding, 'utf8'));
    delete bindings.tools.gh; write(s.binding, JSON.stringify(bindings));
    s.control.intercept = (exe, args) => {
      assert.notEqual(exe, process.execPath, 'Existing workflows must not invoke gh for local actions');
      assert.ok(!args.some(arg => ['ls-remote', 'fetch', 'push'].includes(arg)), 'Resume and local merge must stay offline');
    };
    s.control.calls.length = 0;
    const resumed = await s.command('workspace', ['--resume', '8']);
    assert.equal(resumed.worktree.delivery_mode, 'direct-merge'); assert.equal(resumed.target.branch, 'main');
    assert.equal(resumed.worktree.development_branch, 'codex/issue-8');
    assert.equal((await s.command('merge', ['8'])).target.head, head);
    assert.ok(s.control.calls.every(args => args[0] !== 'api' && args[0] !== 'auth'));
    s.control.intercept = (exe, args) => {
      assert.notEqual(exe, process.execPath, 'Push and direct cleanup do not read the Issue');
    };
    await s.command('push', ['8']);
    await s.command('cleanup', ['8']);
    assert.equal((await s.show(a.worktree.path)).worktree.state, 'available');
  } finally { s.dispose(); }
});

test('new workspaces reject closed Issues, missing specs and duplicate bindings', async () => {
  const s = installation();
  try {
    await assert.rejects(s.invoke('workspace', ['1']), /spec_current_missing/);
    s.native(['checkout', '--detach']);
    await assert.rejects(s.command('workspace', ['1']), /workflow_target_branch_required/);
    s.native(['checkout', 'main']);
    s.native(['branch', 'codex/issue-2']);
    await assert.rejects(s.command('workspace', ['2']), /worktree_branch_exists/);
    write(s.config, s.configuration + '[spec]\ncurrent = "invalid-selection"\n');
    await assert.rejects(s.invoke('workspace', ['1']), /spec_/);
    s.control.issues.get(1).state = 'closed';
    await assert.rejects(s.command('workspace', ['1']), /workflow_issue_closed/);
    s.control.issues.get(1).state = 'open';
    await s.command('workspace', ['1']);
    s.control.issues.get(1).state = 'closed';
    await assert.rejects(s.command('workspace', ['1']), /workflow_issue_registered/);
    assert.equal((await s.command('workspace', ['--resume', '1'])).issue.number, 1);
  } finally { s.dispose(); }
});

test('PR proof failures and partial cleanup remain inspectable and retry through workflow commands', async () => {
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
    assert.equal(failed.status, 'error'); assert.equal(failed.retry, 'workflow.cleanup 7');
    assert.equal(failed.worktree.detached, true); assert.equal(failed.local_branch_deleted, false);
    assert.equal(failed.worktree.state, 'needs_check');
    const continued = await s.command('workspace', ['--resume', '7']);
    assert.equal(continued.worktree.state, 'needs_check');
    assert.equal(continued.reason, 'worktree_cleanup_pending');
    assert.equal(continued.worktree.head, pr.head.sha);
    assert.equal(continued.worktree.checked_out_branch, null);
    assert.equal(continued.worktree.detached, true);
    await assert.rejects(s.command('push', ['7']), /workflow_cleanup_pending/);
    // Ref deletion can succeed before branch configuration cleanup fails.
    // The original name must still locate the persisted cleanup record.
    s.native(['config', 'branch.codex/issue-7.description', 'cleanup fixture']);
    s.control.intercept = async (exe, args) => args.includes('--remove-section')
      ? { ok: false, reason: 'command_failed' } : undefined;
    const deleted = await s.command('cleanup', ['7']);
    assert.equal(deleted.status, 'error'); assert.equal(deleted.local_branch_deleted, true);
    assert.equal(deleted.retry, 'workflow.cleanup 7');
    assert.equal(s.native(['branch', '--list', 'codex/issue-7']), '');
    const detached = await s.command('workspace', ['--resume', '7']);
    assert.equal(detached.worktree.development_branch, 'codex/issue-7');
    assert.equal(detached.worktree.checked_out_branch, null);
    assert.equal(detached.worktree.head, pr.head.sha);
    assert.equal((await s.command('workspace', ['--resume', '7'], workspace.worktree.path)).worktree.state, 'needs_check');
    s.control.intercept = null;
    const completed = await s.command('cleanup', ['7']);
    assert.equal(completed.status, 'success'); assert.equal(completed.worktree.state, 'available');
  } finally { s.dispose(); }
});

test('local merge preserves dirty targets and conflicts, and uses the requested message for a merge commit', async () => {
  const s = installation();
  try {
    const workspace = await s.command('workspace', ['2']);
    const source = s.change(workspace.worktree.path);
    write(join(s.target, 'tracked.txt'), 'unsaved work\n');
    await assert.rejects(s.command('merge', ['2']), /workflow_target_dirty/);
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
    s.change(workspace.worktree.path, 'source conflict'); s.change(s.target, 'target conflict');
    await assert.rejects(s.command('merge', ['2']), /workflow_merge_failed/);
    assert.equal(existsSync(join(s.target, '.git/MERGE_HEAD')), true);
    assert.ok(s.native(['ls-files', '--unmerged']).includes('tracked.txt'));
    await assert.rejects(s.command('merge', ['2']), /workflow_target_busy/);
  } finally { s.dispose(); }
});

test('local merge updates an unoccupied target only by fast-forward and leaves the caller branch intact', async () => {
  const s = installation();
  try {
    const workspace = await s.command('workspace', ['2']);
    const source = s.change(workspace.worktree.path);
    s.native(['checkout', '-b', 'parking']);
    assert.equal((await s.command('merge', ['2'])).target.head, source);
    assert.equal(s.native(['branch', '--show-current']), 'parking');
    assert.equal(s.native(['rev-parse', 'HEAD']), s.initial);
    const diverged = s.change(s.target, 'parking work');
    s.native(['update-ref', 'refs/heads/main', diverged, source]);
    await assert.rejects(s.command('merge', ['2']), /workflow_target_checkout_required/);
    assert.equal(s.native(['rev-parse', 'main']), diverged);
  } finally { s.dispose(); }
});

test('PR merge requires a unique current head, confirms delivery and can be safely retried', async () => {
  const s = installation();
  try {
    const workspace = await s.command('workspace', ['7']);
    s.control.issues.delete(7);
    const head = s.change(workspace.worktree.path);
    await s.command('push', ['7']);
    const pr = { number: 42, state: 'open', draft: false, merged: false,
      head: { ref: 'codex/issue-7', sha: head, repo: { full_name: 'test/repo' } },
      base: { ref: 'main', repo: { full_name: 'test/repo' } } };
    s.control.pr = { ...pr, base: { ...pr.base, ref: 'other-target' } };
    await assert.rejects(s.command('merge', ['7']), /worktree_pr_not_found/);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    s.control.pr = { ...pr, head: { ...pr.head, sha: s.initial } };
    await assert.rejects(s.command('merge', ['7']), /workflow_pr_head_changed/);
    s.control.pr = [pr, { ...pr, number: 43 }];
    await assert.rejects(s.command('merge', ['7']), /worktree_pr_ambiguous/);
    s.control.pr = { ...pr, draft: true };
    await assert.rejects(s.command('merge', ['7']), /workflow_pr_draft/);
    assert.equal(s.control.calls.some(args => args.includes('PUT')), false);
    s.control.pr = pr;
    s.control.mergeResponse = { merged: false };
    await assert.rejects(s.command('merge', ['7']), /workflow_pr_merge_pending/);
    delete s.control.mergeResponse;
    const merged = await s.command('merge', ['7', '--squash', '--message', 'feat: ship the Issue']);
    assert.equal(merged.merged, true); assert.equal(merged.pr, 42); assert.equal(merged.already_merged, false);
    const call = s.control.calls.findLast(args => args.includes('PUT'));
    assert.ok(call.includes('sha=' + head)); assert.ok(call.includes('merge_method=squash'));
    assert.ok(call.includes('commit_title=feat: ship the Issue'));
    // Merging alone leaves synchronization and cleanup to their own stages.
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    assert.equal((await s.show(workspace.worktree.path)).worktree.state, 'unreleased');
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
      assert.equal(prepared.worktree.delivery_mode, mode);
      assert.equal(prepared.worktree.start_commit, incoming);
      assert.equal(s.native(['rev-parse', 'HEAD'], prepared.worktree.path), incoming);
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
      await assert.rejects(s.command('workspace', [String(issue)]), new RegExp('workflow_target_' + state));
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
        await assert.rejects(s.command('workspace', [String(issue)]), /workflow_remote_target_missing/);
        await noPreparedResources(s, s.initial);
      } else {
        const prepared = await s.command('workspace', [String(issue)]);
        assert.equal(prepared.worktree.start_commit, s.initial);
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
        ? join(s.target + '.gidd', 'state/workflows', contextName(join(s.target, '.git')))
        : join(s.target + '.gidd', 'state/worktrees', prepared.id + '.json');
      const record = readFileSync(recordPath, 'utf8');
      s.control.intercept = (exe, args) => {
        assert.notEqual(exe, process.execPath);
        assert.ok(!args.some(arg => ['ls-remote', 'fetch', 'push'].includes(arg)));
      };
      const resumed = await s.command('workspace', ['--resume', String(issue)]);
      assert.equal(resumed.worktree.start_commit, s.initial);
      assert.equal(resumed.worktree.head, s.initial);
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
    await assert.rejects(s.command('workspace', ['2']), /workflow_target_dirty/);
    assert.equal(readFileSync(join(s.target, 'tracked.txt'), 'utf8'), 'keep me\n');
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      s.native(['update-index', '--' + flag, 'tracked.txt']);
      await assert.rejects(s.command('workspace', ['2']), /workflow_target_index_flags/);
      s.native(['update-index', '--no-' + flag, 'tracked.txt']);
    }
    s.native(['restore', 'tracked.txt']);
    write(join(s.target, 'keep.tmp'), 'user file');
    await assert.rejects(s.command('workspace', ['2']), /workflow_target_dirty/);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
    unlinkSync(join(s.target, 'keep.tmp'));
    for (const marker of ['MERGE_HEAD', 'index.lock']) {
      write(join(s.target, '.git', marker), s.initial + '\n');
      await assert.rejects(s.command('workspace', ['2']), /workflow_target_busy/);
      assert.equal(readFileSync(join(s.target, '.git', marker), 'utf8'), s.initial + '\n');
      unlinkSync(join(s.target, '.git', marker));
    }
    await noPreparedResources(s, s.initial);
    assert.equal(s.native(['stash', 'list']), '');
    // No checkout update is needed when tips match, so existing edits survive.
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
        ? 'workflow_remote_failed' : state === 'branch-switch' ? 'workflow_target_branch_mismatch' : 'workflow_target_changed'));
      await noPreparedResources(s, retained);
      assert.equal(s.native(['rev-parse', 'main'], s.bare), incoming);
    } finally { s.dispose(); }
  }
});

test('preparation rejects occupied resources and closed Issues before advancing the target', async () => {
  const s = installation();
  try {
    s.advanceRemote();
    s.native(['branch', 'codex/issue-2']);
    await assert.rejects(s.command('workspace', ['2']), /worktree_branch_exists/);
    s.native(['push', s.bare, 'main:refs/heads/codex/issue-7']);
    await assert.rejects(s.command('workspace', ['7']), /workflow_remote_branch_exists/);
    s.control.issues.get(1).state = 'closed';
    await assert.rejects(s.command('workspace', ['1']), /workflow_issue_closed/);
    assert.equal(s.native(['rev-parse', 'main']), s.initial);
    s.control.issues.get(1).state = 'open';
    await s.command('workspace', ['1']);
    const target = s.native(['rev-parse', 'main']);
    s.advanceRemote(); s.control.calls.length = 0;
    await assert.rejects(s.command('workspace', ['1']), /workflow_issue_registered/);
    await assert.rejects(s.command('workspace', ['10']), /workflow_context_exists/);
    assert.equal(s.native(['rev-parse', 'main']), target);
    assert.equal(s.control.calls.some(args => args.includes('fetch') || args.includes('ls-remote')), false);
  } finally { s.dispose(); }
});

test('direct-commit closure requires published target commits and preserves the context and user files', async () => {
  const s = installation();
  try {
    await s.command('workspace', ['1']); s.change(s.target);
    const recordPath = join(s.target + '.gidd', 'state/workflows', contextName(join(s.target, '.git')));
    const original = readFileSync(recordPath, 'utf8');
    await assert.rejects(s.command('close-issue', ['1']), error => {
      assert.equal(error.message, 'workflow_target_not_pushed');
      assert.equal(error.workspace.retry, 'workflow.close-issue 1');
      const failed = workspaceReport({ schema: 'gidd.workflow/v1', status: 'error', reason: error.message, ...error.workspace });
      assert.equal(failed.worktree.delivery_mode, 'direct-commit');
      assert.equal(Object.hasOwn(failed, 'delivery_mode'), false);
      return true;
    });
    assert.equal(s.control.issues.get(1).state, 'open');
    await s.command('push', ['1']); write(join(s.target, 'keep.tmp'), 'user file');
    // Existing delivery settings remain authoritative after a spec change.
    s.select('pr-merge');
    const result = await s.command('close-issue', ['1']);
    assert.equal(result.status, 'success'); assert.equal(result.issue_closed, true);
    assert.equal(result.worktree.delivery_mode, 'direct-commit'); assert.equal(result.already_closed, false);
    assert.equal(result.pr, undefined);
    assert.equal((await s.command('close-issue', ['1'])).already_closed, true);
    assert.equal(s.control.calls.filter(args => args.includes('PATCH')).length, 1);
    assert.equal(s.control.calls.some(args => args.at(-1) === 'graphql'), false);
    assert.equal(readFileSync(recordPath, 'utf8'), original);
    assert.equal(readFileSync(join(s.target, 'keep.tmp'), 'utf8'), 'user file');
    assert.equal(s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']), '');
    assert.equal((await s.command('workspace', ['--resume', '1'])).worktree.state, 'current');
  } finally { s.dispose(); }
});

test('direct-merge closure requires the development tip to be merged and pushed, without releasing it', async () => {
  const s = installation();
  try {
    const workspace = await s.command('workspace', ['2']);
    const head = s.change(workspace.worktree.path);
    await assert.rejects(s.command('close-issue', ['2']), /worktree_not_delivered/);
    await s.command('merge', ['2']);
    await assert.rejects(s.command('close-issue', ['2']), /workflow_target_not_pushed/);
    assert.equal(s.control.calls.some(args => args.includes('PATCH')), false);
    await s.command('push', ['2']);
    assert.equal((await s.command('close-issue', ['2'], workspace.worktree.path)).issue_closed, true);
    assert.equal(s.native(['rev-parse', 'codex/issue-2']), head);
    assert.equal((await s.show(workspace.worktree.path)).worktree.state, 'unreleased');
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
    await assert.rejects(s.command('close-issue', ['7']), /workflow_remote_not_delivered/);
    s.native(['update-ref', 'refs/heads/main', merge, s.initial], s.bare);
    await assert.rejects(s.command('close-issue', ['7']), /workflow_target_not_synced/);
    assert.equal(s.control.calls.some(args => args.at(-1) === 'graphql' || args.includes('PATCH')), false);
    await s.command('target-sync', ['7']);
    const result = await s.command('close-issue', ['7'], workspace.worktree.path);
    assert.equal(result.pr, 42); assert.equal(result.pr_linked, true); assert.equal(result.issue_closed, true);
    assert.equal(result.already_linked, false);
    const repeated = await s.command('close-issue', ['7']);
    assert.equal(repeated.already_linked, true); assert.equal(repeated.already_closed, true);
    assert.equal(s.control.calls.filter(args => args.some(arg => arg.includes('addCloseIssueReferences'))).length, 1);
    assert.equal(s.control.calls.filter(args => args.includes('PATCH')).length, 1);
    assert.equal((await s.show(workspace.worktree.path)).worktree.state, 'unreleased');
    assert.equal(s.native(['rev-parse', 'codex/issue-7'], s.bare), pr.head.sha);
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
      assert.equal(error.workspace.retry, 'workflow.close-issue 7'); return true;
    });
    assert.equal(s.control.issues.get(7).state, 'open');
    assert.equal((await s.show(workspace.worktree.path)).worktree.state, 'unreleased');
    s.control.intercept = null;
    assert.equal((await s.command('close-issue', ['7'])).already_linked, true);
    assert.equal(s.control.calls.filter(args => args.some(arg => arg.includes('addCloseIssueReferences'))).length, 1);
    assert.equal(existsSync(join(s.target, '.agents/skills/gidd/config.toml.lock')), false);
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
        s.control.intercept = null; s.change(workspace.worktree.path, 'concurrent development');
      }
    };
    await assert.rejects(s.command('close-issue', ['7']), /workflow_target_changed/);
    assert.equal(s.control.issues.get(7).state, 'open');
    assert.equal(s.control.calls.some(args => args.includes('PATCH') || args.some(arg => arg.includes('addCloseIssueReferences'))), false);
    assert.equal((await s.show(workspace.worktree.path)).worktree.state, 'unreleased');
  } finally { s.dispose(); }
});
