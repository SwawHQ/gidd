import { parseIssueTaskArguments, issueTaskCommand } from '../../.agents/skills/gidd/scripts.js/commands/issue-task/index.mjs';
import { parseIssueArguments, issueCommand } from '../../.agents/skills/gidd/scripts.js/commands/issue/index.mjs';
import { worktreeCommand } from '../../.agents/skills/gidd/scripts.js/commands/worktree/index.mjs';
import { runCommand } from '../../.agents/skills/gidd/scripts.js/shared/process.mjs';
import { workspaceReport } from '../../.agents/skills/gidd/scripts.js/shared/workspace-report.mjs';
import { readTasks } from '../../.agents/skills/gidd/scripts.js/shared/task-records.mjs';
import { assert, bindFixture, existsSync, findGit, fixture, initializeDataFixture, join, mkdirSync, ok, readFileSync, run, write } from './helpers.mjs';

export function installation(t) {
  const f = fixture(), git = findGit(), target = join(f.root, 'repo with spaces'), bare = join(f.root, 'remote.git');
  const cancellation = new AbortController(), pending = new Set(), dispose = f.dispose;
  const signal = t.signal ? AbortSignal.any([t.signal, cancellation.signal]) : cancellation.signal;
  const track = operation => {
    pending.add(operation);
    operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  f.dispose = async () => {
    f.closed = true;
    cancellation.abort();
    await Promise.allSettled([...pending]);
    dispose();
  };
  signal.throwIfAborted();
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
  const execute = (exe, args, options) => track(executeCommand(exe, args, { ...options, signal }));
  const executeCommand = async (exe, args, options) => {
    signal.throwIfAborted();
    control.calls.push(args);
    const intercepted = await control.intercept?.(exe, args, options);
    signal.throwIfAborted();
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
    signal.throwIfAborted();
    args = [...args];
    if (action === 'issue' && selected && !args.includes('--policy')) args.push('--policy', selected);
    const number = action === 'issue' ? null : args.shift();
    if (action === 'workspace' && !args.includes('--policy')) {
      const task = readTasks({ path: target + '.gidd' }).find(task => task.issue === Number(number));
      if (task) args.push('--policy', task.policy.selector);
    }
    const route = action === 'issue' ? action : number + (['status', 'workspace'].includes(action) ? '' : '.' + action);
    const command = route === 'issue' ? issueCommand : issueTaskCommand;
    const parsed = route === 'issue' ? parseIssueArguments(route, args) : parseIssueTaskArguments(route, args);
    return track(command(target, parsed, { execute, cwd, signal }).then(workspaceReport));
  };
  const command = (action, args = [], cwd = target) => {
    if (action === 'workspace' && !args.includes('--policy') && !readTasks({ path: target + '.gidd' }).some(task => task.issue === Number(args[0]))) {
      select(plans.get(Number(args[0])) ?? 'direct-commit');
      args = [...args, '--policy', selected];
    }
    return invoke(action, args, cwd);
  };
  const create = async (number, policy = selected) => {
    const draft = join(f.root, 'create-' + number + '.md'), previous = control.nextIssue;
    const issue = control.issues.get(Number(number));
    write(draft, '# ' + (issue?.title ?? 'Fixture') + '\n\n' + (issue?.body ?? 'Acceptance'));
    control.nextIssue = Number(number);
    try { return await invoke('issue', ['--file', draft, '--policy', policy]); }
    finally { control.nextIssue = previous; }
  };
  const register = async (number, policy = selected) => {
    const previous = control.fetchFailure; control.fetchFailure = true;
    try { await assert.rejects(invoke('workspace', [number, '--policy', policy]), /delivery_remote_failed/); }
    finally { control.fetchFailure = previous; }
    await invoke('cleanup', [number]);
    return invoke('status', [number]);
  };
  const show = path => track(worktreeCommand(target, { action: 'show', path }, { execute, signal }));
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
  return { ...f, git, target, bare, initial, native, config, configuration, control, select, invoke, execute, binding, command, create, register, show, change, advanceRemote, delivery, signal, track };
}

export async function noPreparedResources(s, head) {
  assert.equal(s.native(['rev-parse', 'main']), head);
  assert.equal(s.native(['branch', '--list', 'gidd-issue-*']), '');
  assert.equal((await s.track(worktreeCommand(s.target, { action: 'list' }, { execute: s.execute, signal: s.signal }))).worktrees.length, 0);
  assert.ok(readTasks({ path: s.target + '.gidd' }).every(task => !task.workspace));
  const references = readTasks({ path: s.target + '.gidd' }).flatMap(task => task.preparation?.reference ? [task.preparation.reference] : []);
  const actual = s.native(['for-each-ref', '--format=%(refname)', 'refs/gidd/']);
  assert.ok((actual ? actual.split('\n') : []).every(reference => references.includes(reference)));
  assert.equal(existsSync(join(s.target + '.gidd', '.lock')), false);
}
