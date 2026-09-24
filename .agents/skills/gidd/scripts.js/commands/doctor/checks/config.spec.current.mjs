import { discoverModes, loadSpec } from '../../../shared/specs.mjs';

export const id = 'config.spec.current';
export function run(context) {
  const configuration = context.configuration(), selector = configuration.spec?.current;
  if (configuration.result.status !== 'ready') return { id, status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' };
  try {
    const catalog = discoverModes();
    if (selector === undefined) return { id, status: 'missing', reason: 'spec_current_missing' };
    const spec = loadSpec(selector, undefined, catalog);
    if (!spec.available_languages.length) return { id, status: 'invalid', reason: 'spec_language_unavailable', details: { configured: selector, path: spec.path } };
    return { id, status: 'ready', details: { configured: selector, resolved: spec.selector, path: spec.path, available_languages: spec.available_languages } };
  } catch (error) {
    return { id, status: 'invalid', reason: error.message, details: { ...(selector !== undefined ? { configured: selector } : {}),
      ...(error.conflicts ? { conflicts: error.conflicts } : {}),
      ...(error.path ? { path: error.path } : {}), ...(error.field ? { field: error.field } : {}) } };
  }
}
