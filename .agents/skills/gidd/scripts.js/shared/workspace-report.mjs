// Public grouping never changes the Git/registry fields or on-disk records.
const defined = fields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
const present = fields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
const group = (name, fields) => Object.keys(fields).length ? { [name]: fields } : {};

const contextFields = ({ target_repository, target_branch, target_head, path, branch, start_commit,
  state, workflow, issue, head, detached, bare, locked, prunable, release_commit, ...fields }) => ({
  ...fields,
  ...(issue !== undefined ? { issue: { number: issue, ...(workflow ? { url: `${workflow.identity}/issues/${issue}` } : {}) } } : {}),
  ...group('target', defined({ repository: target_repository, branch: target_branch, head: target_head,
    ...(workflow ? { remote: { name: workflow.remote, url: workflow.identity } } : {}) })),
  ...group('worktree', defined({ path, state, delivery_mode: workflow?.mode, development_branch: branch, start_commit,
    head, detached, bare, locked, prunable, release_commit })),
});

// List is a locator and state summary. Omit missing values without guessing.
const listFields = row => ({
  ...(row.issue !== undefined ? { issue: { number: row.issue } } : {}),
  ...group('target', present({ branch: row.target_branch })),
  worktree: present({ path: row.path, state: row.state, delivery_mode: row.workflow?.mode,
    development_branch: row.recorded_branch, checked_out_branch: row.branch }),
  ...(row.reason ? { reason: row.reason } : {}),
});

const checkoutFields = git => git ? {
  head: git.head, checked_out_branch: git.branch ?? null,
  ...Object.fromEntries(['detached', 'bare', 'locked', 'prunable']
    .filter(field => git[field]).map(field => [field, true])),
} : {};

const showFields = ({ worktree, record, git, ...report }) => {
  const { schema, id, ready_head, cleanup, ...context } = record;
  const cleanupDetails = cleanup && (() => {
    const { mode, remote, identity, ...evidence } = cleanup;
    return { ...evidence, mode,
      ...(remote !== undefined ? { remote: { name: remote, url: identity } } : {}) };
  })();
  const grouped = contextFields({ ...report, ...context, state: worktree.state, release_commit: ready_head });
  return {
    ...grouped,
    ...(worktree.reason ? { reason: worktree.reason } : {}),
    ...(cleanupDetails ? { cleanup: cleanupDetails } : {}),
    // Missing directories retain recorded context, but have no actual Git fields.
    worktree: { ...grouped.worktree, ...checkoutFields(git) },
  };
};

export function workspaceReport({ worktree, worktrees, record, git, ...report }) {
  const grouped = worktree !== undefined ? showFields({ worktree, record, git, ...report }) : contextFields(report);
  return {
    ...grouped,
    // Resume forwards the checkout already inspected during context validation.
    ...(worktree === undefined && git !== undefined ? { worktree: { ...grouped.worktree, ...checkoutFields(git) } } : {}),
    status: report.status === 'ready' ? 'success' : report.status,
    ...(worktrees !== undefined ? { worktrees: worktrees.map(listFields) } : {}),
  };
}
