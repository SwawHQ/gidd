export const safeReason = (error, fallback) => /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : fallback;

// Success describes the useful result; failures expose stable reasons, never raw output.
export const check = (id, status, reason, details = {}) => ({ id, status,
  ...(status === 'ready' ? {} : { reason }), ...(Object.keys(details).length ? { details } : {}) });

// Keep independently known errors even when observation of another fact is blocked.
export const blockCheck = (item, by) => item.status !== 'ready' ? item :
  { ...item, status: 'not_checked', reason: 'dependency_unavailable', blocked_by: by };
