import { test } from 'node:test';
import { readWorkflowIssue } from '../.agents/skills/gidd/scripts.js/shared/issue-workflow.mjs';
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
