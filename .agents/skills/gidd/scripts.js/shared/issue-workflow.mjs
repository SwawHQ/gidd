const fail = reason => { throw new Error(reason); };
export const issueNumber = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const branch = value => typeof value === 'string' && !!value && !/^[-/.]|[\x00-\x20\x7f\\:]/.test(value) && !value.startsWith('refs/');

// The Issue is the portable task definition. Local paths and Git progress stay
// in the local resource registry. This block is data, never executable guidance.
export function readIssueWorkflow(body) {
  if (typeof body !== 'string') fail('workflow_issue_metadata_missing');
  const starts = [...body.matchAll(/^```gidd[ \t]*\r?$/gm)].length;
  if (starts > 1) fail('workflow_issue_metadata_ambiguous');
  const blocks = [...body.matchAll(/^```gidd[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (!blocks.length) fail(starts ? 'workflow_issue_metadata_invalid' : 'workflow_issue_metadata_missing');
  let value;
  try { value = JSON.parse(blocks[0][1]); } catch { fail('workflow_issue_metadata_invalid'); }
  if (!value || value.schema !== 'gidd.issue/v1' ||
      Object.keys(value).some(key => !['schema', 'delivery_mode', 'target_branch', 'development_branch'].includes(key)) ||
      !['direct-commit', 'direct-merge', 'pr-merge'].includes(value.delivery_mode) || !branch(value.target_branch) ||
      (value.delivery_mode === 'direct-commit' ? value.development_branch !== null :
        !branch(value.development_branch) || value.development_branch.toLowerCase() === value.target_branch.toLowerCase()))
    fail('workflow_issue_metadata_invalid');
  return value;
}

export async function readWorkflowIssue(connection, number) {
  const { target } = connection, repository = new URL(target.repository).pathname.slice(1);
  const text = await connection.call('gh', ['api', '--hostname', target.hostname, '--method', 'GET', `repos/${repository}/issues/${number}`]);
  let issue;
  try { issue = JSON.parse(text); } catch { fail('workflow_issue_response_invalid'); }
  if (!issue || issue.number !== number || Object.hasOwn(issue, 'pull_request') || !['open', 'closed'].includes(issue.state) ||
      typeof issue.html_url !== 'string' || issue.html_url.toLowerCase() !== `${target.repository}/issues/${number}`.toLowerCase())
    fail('workflow_issue_response_invalid');
  return { number, state: issue.state, ...readIssueWorkflow(issue.body) };
}

export function verifyIssueContext(issue, record) {
  if (record.issue !== issue.number || record.workflow.mode !== issue.delivery_mode ||
      record.target_branch !== issue.target_branch || (record.branch ?? null) !== issue.development_branch)
    fail('workflow_issue_changed');
}
