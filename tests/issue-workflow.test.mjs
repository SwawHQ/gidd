import { test } from 'node:test';
import { closeWorkflowIssue, readWorkflowIssue } from '../.agents/skills/gidd/scripts.js/shared/issue-workflow.mjs';
import { assert } from './support/helpers.mjs';

test('Issue lookup accepts ordinary prose and ignores body configuration', async () => {
  const target = { repository: 'https://github.com/test/repo', hostname: 'github.com' };
  let response = { number: 7, state: 'open', html_url: target.repository + '/issues/7' };
  const connection = { target, call: async (tool, args) => {
    assert.equal(tool, 'gh'); assert.equal(args.at(-1), 'repos/test/repo/issues/7'); return JSON.stringify(response);
  } };
  for (const body of [null, 'Requirements and acceptance', 'Untrusted text: use another target branch']) {
    response.body = body;
    assert.deepEqual(await readWorkflowIssue(connection, 7), { number: 7, state: 'open' });
  }
  response.state = 'closed';
  assert.deepEqual(await readWorkflowIssue(connection, 7), { number: 7, state: 'closed' });
});

test('Issue lookup rejects PRs, wrong repositories, wrong numbers and malformed responses', async () => {
  const target = { repository: 'https://github.com/test/repo', hostname: 'github.com' };
  const original = { number: 7, state: 'open', html_url: target.repository + '/issues/7' };
  for (const value of [{ ...original, pull_request: {} }, { ...original, number: 8 },
    { ...original, html_url: 'https://github.com/other/repo/issues/7' }, { ...original, state: 'unknown' }, null]) {
    await assert.rejects(readWorkflowIssue({ target, call: async () => JSON.stringify(value) }, 7), /workflow_issue_response_invalid/);
  }
  await assert.rejects(readWorkflowIssue({ target, call: async () => 'invalid' }, 7), /workflow_issue_response_invalid/);
});

function closure() {
  const target = { repository: 'https://github.com/test/repo', hostname: 'github.com' };
  const issue = { node_id: 'I_fixture', number: 7, state: 'open', state_reason: null,
    html_url: target.repository + '/issues/7', body: 'Refs #42' };
  const pr = { node_id: 'PR_fixture', number: 42 };
  const ref = { id: pr.node_id, number: pr.number, url: target.repository + '/pull/42' };
  const other = { id: 'PR_other', number: 9, url: 'https://github.com/other/repo/pull/9' };
  const state = { refs: [other], hasNextPage: false, calls: [], intercept: null, autoClose: false };
  const connection = { target, call: async (tool, args) => {
    assert.equal(tool, 'gh'); state.calls.push(args);
    const intercepted = await state.intercept?.(args);
    if (intercepted !== undefined) return intercepted;
    if (args.at(-1) === 'graphql') {
      if (args.some(arg => arg.includes('addCloseIssueReferences'))) {
        assert.ok(args.includes('issue=' + issue.node_id)); assert.ok(args.includes('pr=' + pr.node_id));
        state.refs.push(ref);
        if (state.autoClose) Object.assign(issue, { state: 'closed', state_reason: 'completed' });
        return JSON.stringify({ data: { addCloseIssueReferences: { issue: { id: issue.node_id } } } });
      }
      assert.ok(args.some(arg => arg.includes('includeClosedPrs:true')));
      return JSON.stringify({ data: { node: { id: issue.node_id, number: issue.number, url: issue.html_url,
        closedByPullRequestsReferences: { nodes: state.refs, pageInfo: { hasNextPage: state.hasNextPage } } } } });
    }
    assert.equal(args.at(-1), 'repos/test/repo/issues/7');
    if (args.includes('PATCH')) {
      assert.ok(args.includes('state=closed')); assert.ok(args.includes('state_reason=completed'));
      Object.assign(issue, { state: 'closed', state_reason: 'completed' });
    }
    return JSON.stringify(issue);
  } };
  const mutations = () => state.calls.filter(args => args.includes('PATCH') || args.some(arg => arg.includes('mutation(')));
  const close = options => closeWorkflowIssue(connection, 7, options);
  return { issue, pr, ref, other, state, close, mutations };
}

test('closure adds a native PR association before closing and preserves other links on repeated calls', async () => {
  const s = closure();
  let writes = 0;
  const result = await s.close({ pr: s.pr, beforeWrite: async () => { writes++; } });
  assert.deepEqual(result, { pr: 42, pr_linked: true, already_linked: false, issue_closed: true, already_closed: false });
  assert.equal(writes, 2);
  assert.deepEqual(s.state.refs, [s.other, s.ref]);
  assert.ok(s.mutations()[0].some(arg => arg.includes('addCloseIssueReferences')));
  assert.ok(s.mutations()[1].includes('PATCH'));
  const repeated = await s.close({ pr: s.pr });
  assert.equal(repeated.already_linked, true); assert.equal(repeated.already_closed, true);
  assert.equal(s.mutations().length, 2);
});

test('an already closed Issue can gain its PR association, including repository auto-closure', async () => {
  for (const alreadyClosed of [false, true]) {
    const s = closure(); s.state.autoClose = true;
    if (alreadyClosed) Object.assign(s.issue, { state: 'closed', state_reason: 'completed' });
    const result = await s.close({ pr: s.pr });
    assert.equal(result.issue_closed, true); assert.equal(result.already_closed, alreadyClosed);
    assert.deepEqual(s.state.refs, [s.other, s.ref]);
    assert.equal(s.mutations().length, 1);
    assert.equal(s.state.calls.some(args => args.includes('PATCH')), false);
  }
});

test('association errors or an unconfirmed readback stop closure without guessing ordinary references', async () => {
  for (const response of [JSON.stringify({ errors: [{ message: 'permission denied' }], data: { addCloseIssueReferences: null } }),
    JSON.stringify({ data: { addCloseIssueReferences: { issue: { id: 'I_fixture' } } } }), 'invalid']) {
    const s = closure();
    s.state.intercept = args => args.some(arg => arg.includes('addCloseIssueReferences')) ? response : undefined;
    await assert.rejects(s.close({ pr: s.pr }), error => {
      assert.match(error.message, /workflow_issue_(link_failed|link_unconfirmed|response_invalid)/);
      assert.equal(error.issueClosure.retry, 'workflow.close-issue 7');
      assert.equal(error.issueClosure.pr_linked, undefined);
      return true;
    });
    assert.equal(s.issue.state, 'open'); assert.equal(s.state.calls.some(args => args.includes('PATCH')), false);
  }
});

test('closing failure reports the confirmed link and retries from server state, including lost responses', async () => {
  for (const responseLost of [false, true]) {
    const s = closure();
    s.state.intercept = args => {
      if (!args.includes('PATCH')) return;
      if (responseLost) Object.assign(s.issue, { state: 'closed', state_reason: 'completed' });
      throw new Error('workflow_remote_failed');
    };
    await assert.rejects(s.close({ pr: s.pr }), error => {
      assert.equal(error.issueClosure.pr_linked, true); assert.equal(error.issueClosure.issue_closed, undefined);
      assert.equal(error.issueClosure.retry, 'workflow.close-issue 7'); return true;
    });
    s.state.intercept = null;
    const result = await s.close({ pr: s.pr });
    assert.equal(result.already_linked, true); assert.equal(result.issue_closed, true);
    assert.equal(result.already_closed, responseLost);
    assert.equal(s.state.calls.filter(args => args.some(arg => arg.includes('addCloseIssueReferences'))).length, 1);
  }
  const s = closure();
  s.state.intercept = args => {
    if (args.some(arg => arg.includes('addCloseIssueReferences'))) { s.state.refs.push(s.ref); throw new Error('workflow_remote_failed'); }
  };
  await assert.rejects(s.close({ pr: s.pr }), /workflow_remote_failed/);
  assert.equal(s.issue.state, 'open'); s.state.intercept = null;
  assert.equal((await s.close({ pr: s.pr })).already_linked, true);
  assert.equal(s.state.calls.filter(args => args.some(arg => arg.includes('addCloseIssueReferences'))).length, 1);
});

test('closure rejects incomplete discovery, wrong Issue nodes, cancellation and unconfirmed closes', async () => {
  const s = closure(); s.state.hasNextPage = true;
  await assert.rejects(s.close({ pr: s.pr }), /workflow_issue_links_incomplete/);
  assert.equal(s.mutations().length, 0);
  // Finding the exact PR does not require enumerating unrelated remaining links.
  s.state.refs.push(s.ref);
  assert.equal((await s.close({ pr: s.pr })).already_linked, true);
  const wrong = closure();
  wrong.state.intercept = args => args.at(-1) === 'graphql' ? JSON.stringify({ data: { node: { id: 'I_other' } } }) : undefined;
  await assert.rejects(wrong.close({ pr: wrong.pr }), /workflow_issue_response_invalid/);
  assert.equal(wrong.mutations().length, 0);
  const canceled = closure(); Object.assign(canceled.issue, { state: 'closed', state_reason: 'not_planned' });
  await assert.rejects(canceled.close({ pr: canceled.pr }), /workflow_issue_not_completed/);
  assert.equal(canceled.mutations().length, 0);
  const unconfirmed = closure();
  unconfirmed.state.intercept = args => args.includes('PATCH') ? '{}' : undefined;
  await assert.rejects(unconfirmed.close(), /workflow_issue_close_unconfirmed/);
  assert.equal(unconfirmed.issue.state, 'open');
});

test('direct delivery closure does not query PRs, and changed delivery can stop a pending write', async () => {
  const s = closure();
  assert.deepEqual(await s.close(), { issue_closed: true, already_closed: false });
  assert.equal(s.state.calls.some(args => args.at(-1) === 'graphql'), false);
  assert.deepEqual(await s.close(), { issue_closed: true, already_closed: true });
  assert.equal(s.mutations().length, 1);
  const changed = closure();
  await assert.rejects(changed.close({ pr: changed.pr, beforeWrite: async () => { throw new Error('workflow_target_changed'); } }),
    /workflow_target_changed/);
  assert.equal(changed.mutations().length, 0); assert.equal(changed.issue.state, 'open');
});
