export const workingBranch = record => record.delivery?.mode === 'direct-commit' ? record.target_branch : record.branch;

export const branchDetails = (expected, actual) => ({ expected_branch: expected ?? null, actual_branch: actual ?? null });

export function requireWorkingBranch(record, checkout) {
  const expected = workingBranch(record);
  if (checkout?.branch === expected) return;
  throw Object.assign(new Error('workspace_branch_changed'), {
    workspace: { issue: record.issue, path: record.path, branch: record.branch,
      target_branch: record.target_branch, start_commit: record.start_commit, delivery: record.delivery,
      state: 'needs_check', ...(checkout ? { git: checkout } : {}) },
    details: { path: record.path, ...branchDetails(expected, checkout?.branch) },
  });
}
