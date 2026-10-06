const fail = reason => { throw new Error(reason); };
export const issueNumber = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));

export async function readWorkflowIssue(connection, number) {
  const { target } = connection, repository = new URL(target.repository).pathname.slice(1);
  const text = await connection.call('gh', ['api', '--hostname', target.hostname, '--method', 'GET', `repos/${repository}/issues/${number}`]);
  let issue;
  try { issue = JSON.parse(text); } catch { fail('workflow_issue_response_invalid'); }
  if (!issue || issue.number !== number || Object.hasOwn(issue, 'pull_request') || !['open', 'closed'].includes(issue.state) ||
      typeof issue.html_url !== 'string' || issue.html_url.toLowerCase() !== `${target.repository}/issues/${number}`.toLowerCase())
    fail('workflow_issue_response_invalid');
  return { number, state: issue.state };
}
