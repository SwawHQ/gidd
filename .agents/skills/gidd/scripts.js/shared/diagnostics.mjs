// Public diagnostics keep one code with the facts that explain it.
export const diagnostic = (code, facts) => ({ ...facts, code });

// Observations may use reason internally; only the public report changes.
export function diagnosticReport({ reason, details, ...fields }) {
  return { ...fields, ...(reason ? { details: diagnostic(reason, details) } :
    details !== undefined ? { details } : {}) };
}
