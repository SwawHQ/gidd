const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const fail = reason => { throw new Error(reason); };

export function validLocalMerge(value) {
  if (!value || !oid(value.head)) return false;
  if (value.commit !== undefined) return Object.keys(value).length === 2 && oid(value.commit);
  return Object.keys(value).length === 4 && oid(value.before) && oid(value.tree) &&
    typeof value.message === 'string' && !!value.message.trim() && !/[\x00-\x1f\x7f]/.test(value.message);
}

export async function localMergeCommit(merge, target, git) {
  if (merge.commit) return merge.commit;
  if (target === merge.before) return null;
  if (await git(['merge-base', merge.before, target]) !== merge.before) fail('delivery_merge_changed');
  // Recover only the direct child with the planned parent and complete tree.
  const commits = await git(['rev-list', '--first-parent', '--reverse', merge.before + '..' + target]);
  const commit = commits.split('\n')[0];
  if (!oid(commit) || await git(['show', '--no-patch', '--format=%P%n%T', commit]) !== merge.before + '\n' + merge.tree)
    fail('delivery_merge_changed');
  return commit;
}

export async function localDeliveryCommit(record, head, target, git) {
  if (await git(['merge-base', head, target]) === head) return head;
  if (record.local_merge?.head !== head) fail('worktree_not_delivered');
  const commit = await localMergeCommit(record.local_merge, target, git);
  if (!commit || await git(['merge-base', commit, target]) !== commit) fail('worktree_not_delivered');
  return commit;
}
