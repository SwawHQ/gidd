import { remoteAddress } from '../../shared/config.mjs';
import { prConnection } from '../../shared/pull-requests.mjs';

const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const fail = reason => { throw new Error(reason); };
export function validCleanupRecord(value) {
  return value && oid(value.head) && ['direct-merge', 'pr-merge'].includes(value.mode) &&
    Object.keys(value).every(name => ['head', 'mode', 'pr', 'remote', 'identity'].includes(name)) &&
    (value.mode === 'direct-merge' ? Object.keys(value).length === 2 :
      Number.isSafeInteger(value.pr) && value.pr > 0 && typeof value.remote === 'string' &&
      typeof value.identity === 'string' && remoteAddress(value.identity)?.identity === value.identity);
}

export async function cleanupWorktree({ repository, record, git, rows, inspect, key, report, save, execute, signal }) {
  const mode = record.workflow.mode;
  if (!record.branch || !record.target_branch || !record.start_commit || record.branch === record.target_branch) fail('worktree_delivery_metadata_missing');
  if (record.cleanup && record.cleanup.mode !== mode) fail('worktree_cleanup_mode_mismatch');
  const branchRef = 'refs/heads/' + record.branch, targetRef = 'refs/heads/' + record.target_branch;
  for (const ref of [branchRef, targetRef]) await git(repository, ['check-ref-format', ref]);
  const localHead = async () => {
    // for-each-ref also matches descendants, so filter the complete ref name.
    const refs = await git(repository, ['for-each-ref', '--format=%(refname) %(objectname)', branchRef]);
    return refs.split('\n').find(line => line.startsWith(branchRef + ' '))?.slice(branchRef.length + 1) ?? null;
  };
  const original = (await rows()).find(item => key(item.path) === key(record.path));
  const reason = await inspect(original);
  if (reason) fail(reason);
  const head = record.cleanup?.head ?? original.head;
  if (!oid(head) || original.head !== head || (original.branch !== record.branch &&
      !(record.cleanup && original.detached))) fail('worktree_branch_mismatch');
  const branchHead = await localHead();
  if (branchHead !== head && !(record.cleanup && branchHead === null)) fail('worktree_branch_changed');
  if ((await rows()).some(row => row.branch === record.branch && key(row.path) !== key(record.path))) fail('worktree_branch_checked_out_elsewhere');
  const ancestor = async (from, to) => {
    const base = await git(repository, ['merge-base', from, to]);
    if (base !== from) fail('worktree_not_delivered');
  };
  await ancestor(record.start_commit, head);
  const target = await git(repository, ['rev-parse', '--verify', targetRef + '^{commit}']);
  let connection, proof;
  if (mode === 'direct-merge') await ancestor(head, target);
  else {
    connection = await prConnection(repository, execute, signal);
    if (record.cleanup && (record.cleanup.identity !== connection.target.repository || record.cleanup.remote !== connection.target.remote)) fail('worktree_cleanup_remote_changed');
    proof = await connection.proof(record, head, record.cleanup?.pr);
    await ancestor(proof.merge, target); // includes squash/rebase result in local target
    const remote = await connection.remoteHead(record.branch);
    if (remote.head !== null && remote.head !== head) fail('worktree_remote_branch_changed');
  }
  // Persist only resource cleanup evidence. On interruption retain the source
  // commit, chosen PR and mode; the same command can resume after ref deletion.
  record.cleanup = { head, mode, ...(proof ? { pr: proof.number,
    remote: connection.target.remote, identity: connection.target.repository } : {}) };
  delete record.ready_head;
  save();
  const progress = { detached: !!original.detached, local_branch_deleted: branchHead === null, remote_branch_deleted: null };
  try {
    const before = (await rows()).find(item => key(item.path) === key(record.path));
    if (!before || before.head !== head || (before.branch !== record.branch && !before.detached)) fail('worktree_state_changed');
    const changed = await inspect(before);
    if (changed) fail(changed);
    if (!before.detached) await git(record.path, ['checkout', '--detach', '--no-overwrite-ignore', '--no-recurse-submodules', head, '--']);
    progress.detached = true;
    if (connection) { await connection.removeRemote(record.branch, head); progress.remote_branch_deleted = true; }
    const current = await rows(), detached = current.find(item => key(item.path) === key(record.path));
    if (!detached?.detached || detached.head !== head || current.some(row => row.branch === record.branch)) fail('worktree_state_changed');
    const after = await inspect(detached);
    if (after) fail(after);
    const tip = await localHead();
    if (tip !== null) {
      if (tip !== head) fail('worktree_branch_changed');
      // branch -d checks upstream/HEAD instead of the recorded target, and -D
      // lacks an expected-old-OID argument. Delete only our verified ref value.
      await git(repository, ['update-ref', '-d', branchRef, head]);
    }
    progress.local_branch_deleted = true;
    const config = await git(repository, ['config', '--local', '--list', '--name-only']);
    if (config.split('\n').some(name => name.startsWith('branch.' + record.branch + '.')))
      await git(repository, ['config', '--local', '--remove-section', 'branch.' + record.branch]);
    record.ready_head = head;
    save(); // publish only after all selected cleanup operations succeed
    return report({ id: record.id, path: record.path, branch: record.branch, head, state: 'available',
      ...(proof ? { pr: proof.number } : {}), ...progress });
  } catch (error) {
    return { ...report({ id: record.id, path: record.path, branch: record.branch, state: 'needs_check', ...progress }),
      status: 'error', reason: /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'operation_failed',
      retry: `workflow.cleanup ${record.issue}` };
  }
}
