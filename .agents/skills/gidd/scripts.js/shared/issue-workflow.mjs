const fail = reason => { throw new Error(reason); };
export const issueNumber = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));

async function readIssue(connection, number) {
  const { target } = connection, repository = new URL(target.repository).pathname.slice(1);
  const text = await connection.call('gh', ['api', '--hostname', target.hostname, '--method', 'GET', `repos/${repository}/issues/${number}`]);
  let issue;
  try { issue = JSON.parse(text); } catch { fail('workflow_issue_response_invalid'); }
  if (!issue || issue.number !== number || Object.hasOwn(issue, 'pull_request') || !['open', 'closed'].includes(issue.state) ||
      typeof issue.html_url !== 'string' || issue.html_url.toLowerCase() !== `${target.repository}/issues/${number}`.toLowerCase())
    fail('workflow_issue_response_invalid');
  return issue;
}

export async function readWorkflowIssue(connection, number) {
  const issue = await readIssue(connection, number);
  return { number, state: issue.state };
}

const nodeId = value => typeof value === 'string' && !!value && value.length <= 512;
const linksQuery = `query($issue:ID!) {
  node(id:$issue) { ... on Issue { id number url
    closedByPullRequestsReferences(first:100,includeClosedPrs:true) {
      nodes { id number url } pageInfo { hasNextPage }
    }
  } }
}`;
const linkMutation = `mutation($issue:ID!,$pr:ID!) {
  addCloseIssueReferences(input:{issueId:$issue,pullRequestIds:[$pr]}) { issue { id } }
}`;

// Acceptance and permission belong to the caller. The PR proof comes from
// exact repository/branch/commit matching, not Issue prose or ordinary Refs.
// Read server state on every call: no local closure journal or rollback of a
// successful association is needed when closing fails or a response is lost.
export async function closeWorkflowIssue(connection, number, { pr, beforeWrite = async () => {} } = {}) {
  const { target } = connection, repository = new URL(target.repository).pathname.slice(1);
  const progress = {};
  const graphql = async (query, variables) => {
    const args = ['api', '--hostname', target.hostname, '--method', 'POST', '--raw-field', 'query=' + query];
    for (const [key, value] of Object.entries(variables)) args.push('--raw-field', key + '=' + value);
    const text = await connection.call('gh', [...args, 'graphql']);
    let result;
    try { result = JSON.parse(text); } catch { fail('workflow_issue_response_invalid'); }
    if (result?.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length)) fail('workflow_issue_link_failed');
    if (!result?.data) fail('workflow_issue_response_invalid');
    return result.data;
  };
  try {
    const issue = await readIssue(connection, number);
    if (!nodeId(issue.node_id)) fail('workflow_issue_response_invalid');
    // A canceled Issue needs an explicit decision, not silent reclassification.
    if (issue.state === 'closed' && issue.state_reason === 'not_planned') fail('workflow_issue_not_completed');
    if (pr) {
      if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || !nodeId(pr.node_id)) fail('worktree_pr_response_invalid');
      progress.pr = pr.number;
      const linked = async () => {
        const node = (await graphql(linksQuery, { issue: issue.node_id })).node;
        const refs = node?.closedByPullRequestsReferences;
        if (node?.id !== issue.node_id || node.number !== number || typeof node.url !== 'string' || node.url.toLowerCase() !== issue.html_url.toLowerCase() ||
            !Array.isArray(refs?.nodes) || typeof refs.pageInfo?.hasNextPage !== 'boolean') fail('workflow_issue_response_invalid');
        const found = refs.nodes.some(ref => ref?.id === pr.node_id && ref.number === pr.number && typeof ref.url === 'string' &&
          ref.url.toLowerCase() === `${target.repository}/pull/${pr.number}`.toLowerCase());
        if (!found && refs.pageInfo.hasNextPage) fail('workflow_issue_links_incomplete');
        return found;
      };
      const alreadyLinked = await linked();
      if (!alreadyLinked) {
        await beforeWrite();
        const result = await graphql(linkMutation, { issue: issue.node_id, pr: pr.node_id });
        if (result.addCloseIssueReferences?.issue?.id !== issue.node_id) fail('workflow_issue_response_invalid');
        if (!await linked()) fail('workflow_issue_link_unconfirmed');
      }
      progress.pr_linked = true;
      progress.already_linked = alreadyLinked;
    }
    // Linking a merged PR may itself close the Issue under repository settings.
    // Refresh before PATCH; an already closed Issue is never reopened.
    const beforeClose = pr ? await readIssue(connection, number) : issue;
    if (beforeClose.node_id !== issue.node_id) fail('workflow_issue_response_invalid');
    if (beforeClose.state === 'closed' && beforeClose.state_reason === 'not_planned') fail('workflow_issue_not_completed');
    let confirmed = beforeClose;
    if (beforeClose.state !== 'closed') {
      await beforeWrite();
      await connection.call('gh', ['api', '--hostname', target.hostname, '--method', 'PATCH',
        '--raw-field', 'state=closed', '--raw-field', 'state_reason=completed', `repos/${repository}/issues/${number}`]);
      confirmed = await readIssue(connection, number);
    }
    if (confirmed.node_id !== issue.node_id || confirmed.state !== 'closed' || confirmed.state_reason === 'not_planned')
      fail('workflow_issue_close_unconfirmed');
    return { ...progress, issue_closed: true, already_closed: issue.state === 'closed' };
  } catch (error) {
    error.issueClosure = { ...progress, retry: 'workflow.close-issue ' + number };
    throw error;
  }
}
