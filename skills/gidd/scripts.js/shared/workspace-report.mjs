// Public grouping never changes the Git/registry fields or on-disk records.
import { workingBranch } from './workspace-branch.mjs';
import { diagnostic } from './diagnostics.mjs';

const defined = fields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
const present = fields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
const group = (name, fields) => Object.keys(fields).length ? { [name]: fields } : {};
const workspaceDetails = (state, reason, facts) => state === 'needs_check' && reason ? diagnostic(reason, facts) : undefined;

const contextFields = ({ target_repository, target_branch, target_head, path, branch, start_commit,
  state, delivery, issue, head, detached, bare, locked, prunable, release_commit, reason, details, ...fields }) => ({
  ...fields,
  // A failed command reports its primary problem once, at the result root.
  ...(fields.status === 'error' && reason ? { details: diagnostic(reason, details) } : {}),
  ...(issue !== undefined ? { issue: { number: issue, ...(delivery ? { url: `${delivery.remote.push.repository}/issues/${issue}` } : {}) } } : {}),
  ...group('target', defined({ path: target_repository, branch: target_branch, head: target_head,
    ...(delivery ? { remote: delivery.remote } : {}) })),
  ...(!path && !state ? (delivery ? { delivery_mode: delivery.mode } : {}) : group('workspace', defined({ path, state, delivery_mode: delivery?.mode,
    branch: workingBranch({ delivery, branch, target_branch }), start_commit,
    head, detached, bare, locked, prunable, release_commit,
    details: fields.status === 'error' ? undefined : workspaceDetails(state, reason, details) }))),
});

// List is a locator and state summary. Omit missing values without guessing.
const listFields = row => ({
  ...(row.issue !== undefined ? { issue: { number: row.issue } } : {}),
  ...group('target', present({ branch: row.target_branch })),
  workspace: present({ path: row.path, state: row.state, delivery_mode: row.delivery?.mode,
    branch: workingBranch({ delivery: row.delivery, branch: row.recorded_branch, target_branch: row.target_branch }),
    details: workspaceDetails(row.state, row.reason, row.details) }),
});

const checkoutFields = git => git ? {
  head: git.head,
  ...Object.fromEntries(['detached', 'bare', 'locked', 'prunable']
    .filter(field => git[field]).map(field => [field, true])),
} : {};

const showFields = ({ worktree, record, git, ...report }) => {
  const { schema, id, ready_head, cleanup, preparation, ...context } = record;
  const cleanupDetails = cleanup && (() => {
    const { mode, identity, ...evidence } = cleanup;
    return { ...evidence, mode, ...(identity !== undefined ? { repository: identity } : {}) };
  })();
  const grouped = contextFields({ ...report, ...context, state: worktree.state, release_commit: ready_head,
    reason: worktree.reason, details: worktree.details });
  return {
    ...grouped,
    ...(preparation ? { preparation: { branch: preparation.branch, target_branch: preparation.target_branch,
      start_commit: preparation.start_commit, reused: !!preparation.previous } } : {}),
    ...(cleanupDetails ? { cleanup: cleanupDetails } : {}),
    // Missing directories retain recorded context, but have no actual Git fields.
    workspace: { ...grouped.workspace, ...checkoutFields(git) },
  };
};

export function workspaceReport({ worktree, worktrees, record, git, ...report }) {
  const grouped = worktree !== undefined ? showFields({ worktree, record, git, ...report }) : contextFields(report);
  return {
    ...grouped,
    // Resume forwards the checkout already inspected during context validation.
    ...(worktree === undefined && git !== undefined ? { workspace: { ...grouped.workspace, ...checkoutFields(git) } } : {}),
    status: report.status === 'ready' ? 'success' : report.status,
    ...(worktrees !== undefined ? { worktrees: worktrees.map(listFields) } : {}),
  };
}
