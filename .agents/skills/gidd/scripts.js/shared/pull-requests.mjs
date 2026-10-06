import { repositoryConnection } from './repository-remote.mjs';

const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const fail = reason => { throw new Error(reason); };

// Merge, sync and cleanup share repository/branch/commit matching. No PR number
// is persisted as task identity; cleanup alone retains its verified evidence.
export async function prConnection(repository, execute, signal) {
  const connection = await repositoryConnection(repository, { execute, signal, github: true, prefix: 'worktree' });
  const { target, call, verifyRemote: address } = connection;
  const api = async (path, method = 'GET', fields = {}) => {
    const args = ['api', '--hostname', target.hostname, '--method', method];
    for (const [key, value] of Object.entries(fields)) args.push('--raw-field', key + '=' + value);
    const text = await call('gh', [...args, path]);
    try { return JSON.parse(text); } catch { fail('worktree_pr_response_invalid'); }
  };
  const repo = new URL(target.repository).pathname.slice(1);
  const endpoint = `repos/${repo}/pulls`;
  const branchesMatch = (pr, record) => Number.isSafeInteger(pr?.number) && pr.number > 0 &&
    pr.head?.ref === record.branch && pr.base?.ref === record.target_branch &&
    pr.head?.repo?.full_name?.toLowerCase() === repo && pr.base?.repo?.full_name?.toLowerCase() === repo;
  const delivered = (pr, record, head) => branchesMatch(pr, record) && pr.state === 'closed' &&
    !!pr.merged_at && pr.head.sha === head && oid(pr.merge_commit_sha);
  async function discover(record, state, matches) {
    const candidates = [];
    for (let page = 1; ; page++) {
      if (page > 20) fail('worktree_pr_discovery_incomplete');
      const query = new URLSearchParams({ state, head: repo.split('/')[0] + ':' + record.branch,
        base: record.target_branch, per_page: '100', page: String(page) });
      const list = await api(endpoint + '?' + query);
      if (!Array.isArray(list)) fail('worktree_pr_response_invalid');
      candidates.push(...list.filter(matches));
      if (list.length < 100) return candidates;
    }
  }
  async function proof(record, head, number) {
    if (!number) {
      const candidates = await discover(record, 'closed', pr => delivered(pr, record, head));
      if (!candidates.length) fail('worktree_pr_not_found');
      if (candidates.length !== 1) fail('worktree_pr_ambiguous');
      number = candidates[0].number;
    }
    const pr = await api(endpoint + '/' + number);
    if (pr?.number !== number || pr.merged !== true || !delivered(pr, record, head)) fail('worktree_pr_not_delivered');
    return { number, merge: pr.merge_commit_sha };
  }
  async function merge(record, head, { method = 'merge', message } = {}) {
    const candidates = await discover(record, 'open', pr => branchesMatch(pr, record) && pr.state === 'open');
    if (!candidates.length) return { ...await proof(record, head), already_merged: true };
    if (candidates.length !== 1) fail('worktree_pr_ambiguous');
    const number = candidates[0].number, pr = await api(endpoint + '/' + number);
    if (!branchesMatch(pr, record) || pr.number !== number || pr.state !== 'open') fail('workflow_pr_changed');
    if (pr.head.sha !== head) fail('workflow_pr_head_changed');
    if (pr.draft) fail('workflow_pr_draft');
    // GitHub atomically rejects a moved PR head via sha. Server branch rules
    // remain authoritative; no admin bypass, auto-merge or queue polling.
    const result = await api(endpoint + '/' + number + '/merge', 'PUT', {
      sha: head, merge_method: method, ...(message ? { commit_title: message } : {}),
    });
    if (result?.merged !== true || !oid(result.sha)) fail('workflow_pr_merge_pending');
    const confirmed = await proof(record, head, number);
    if (confirmed.merge !== result.sha) fail('workflow_pr_merge_unconfirmed');
    return { ...confirmed, already_merged: false };
  }
  async function remoteHead(branch) {
    await address();
    const ref = 'refs/heads/' + branch;
    const text = await call('git', ['-C', repository, '-c', 'core.hooksPath=NUL', 'ls-remote', '--refs', target.remote, ref]);
    if (!text) return { ref, head: null };
    const lines = text.split('\n'), fields = lines[0].split('\t');
    if (lines.length !== 1 || fields[1] !== ref || !oid(fields[0])) fail('worktree_remote_response_invalid');
    return { ref, head: fields[0] };
  }
  return { ...connection, proof, merge, remoteHead, async removeRemote(branch, expected) {
    const remote = await remoteHead(branch);
    if (remote.head === null) return;
    if (remote.head !== expected) fail('worktree_remote_branch_changed');
    await call('git', ['-C', repository, '-c', 'core.hooksPath=NUL', '-c', `remote.${target.remote}.mirror=false`,
      'push', '--no-follow-tags', `--force-with-lease=${remote.ref}:${expected}`, target.remote, ':' + remote.ref]);
  } };
}
