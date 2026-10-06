import { test } from 'node:test';
import { readIssueWorkflow, readWorkflowIssue, verifyIssueContext } from '../.agents/skills/gidd/scripts.js/shared/issue-workflow.mjs';
import { assert } from './support/helpers.mjs';

const metadata = { schema: 'gidd.issue/v1', delivery_mode: 'pr-merge', target_branch: 'main', development_branch: 'codex/feature' };
const body = value => '# Requirements\nHuman text stays independent.\n\n```gidd\n' + JSON.stringify(value, null, 2) + '\n```\n';

test('Issue metadata is explicit, unambiguous and does not accept paths or executable fields', () => {
  assert.deepEqual(readIssueWorkflow(body(metadata)), metadata);
  assert.deepEqual(readIssueWorkflow(body(metadata).replaceAll('\n', '\r\n')), metadata);
  assert.throws(() => readIssueWorkflow('No GIDD block'), /workflow_issue_metadata_missing/);
  assert.throws(() => readIssueWorkflow(body(metadata) + body(metadata)), /workflow_issue_metadata_ambiguous/);
  assert.throws(() => readIssueWorkflow(body(metadata) + '\n```gidd\n{}'), /workflow_issue_metadata_ambiguous/);
  assert.throws(() => readIssueWorkflow('```gidd\n{}'), /workflow_issue_metadata_invalid/);
  for (const value of [{ ...metadata, command: 'git reset --hard' }, { ...metadata, delivery_mode: 'unknown' },
    { ...metadata, development_branch: 'main' }, { ...metadata, target_branch: '-main' },
    { ...metadata, development_branch: 'D:\\another\\repo' }, { ...metadata, delivery_mode: 'direct-commit' }])
    assert.throws(() => readIssueWorkflow(body(value)), /workflow_issue_metadata_invalid/);
  assert.equal(readIssueWorkflow(body({ ...metadata, delivery_mode: 'direct-commit', development_branch: null })).development_branch, null);
});

test('Issue lookup rejects a PR, a transferred Issue and changed task metadata', async () => {
  const target = { repository: 'https://github.com/test/repo', hostname: 'github.com' };
  let response = { number: 7, state: 'open', html_url: target.repository + '/issues/7', body: body(metadata) };
  const connection = { target, call: async (tool, args) => {
    assert.equal(tool, 'gh'); assert.equal(args.at(-1), 'repos/test/repo/issues/7'); return JSON.stringify(response);
  } };
  const issue = await readWorkflowIssue(connection, 7);
  const record = { issue: 7, workflow: { mode: 'pr-merge' }, target_branch: 'main', branch: 'codex/feature' };
  verifyIssueContext(issue, record);
  for (const changed of [{ ...issue, number: 8 }, { ...issue, delivery_mode: 'direct-merge' },
    { ...issue, target_branch: 'other' }, { ...issue, development_branch: 'codex/other' }])
    assert.throws(() => verifyIssueContext(changed, record), /workflow_issue_changed/);
  response = { ...response, pull_request: {} };
  await assert.rejects(readWorkflowIssue(connection, 7), /workflow_issue_response_invalid/);
  delete response.pull_request; response.html_url = 'https://github.com/other/repo/issues/7';
  await assert.rejects(readWorkflowIssue(connection, 7), /workflow_issue_response_invalid/);
});
