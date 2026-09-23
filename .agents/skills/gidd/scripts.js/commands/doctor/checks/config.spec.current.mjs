import { join } from 'node:path';
import { loadSpecCatalog, loadSpec, specRoot } from '../../../shared/specs.mjs';

export const id = 'config.spec.current';
export function run(context) {
  const configuration = context.configuration();
  const mode = configuration.spec?.current;
  const modeCheck = { id, status: 'ready' };
  if (configuration.result.status !== 'ready') {
    Object.assign(modeCheck, { status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' });
    return modeCheck;
  }
  let catalog;
  try { catalog = loadSpecCatalog(); }
  catch (error) {
    Object.assign(modeCheck, { status: 'invalid', reason: error.message });
    return modeCheck;
  }
  const names = catalog.en.map(spec => spec.name);
  if (!names.includes(mode)) {
    Object.assign(modeCheck, { status: mode === undefined ? 'missing' : 'invalid',
      reason: mode === undefined ? 'spec_current_missing' : 'spec_current_unsupported',
      details: { available_names: names } });
    return modeCheck;
  }
  modeCheck.details = { configured: mode };
  try { loadSpec(mode, catalog); }
  catch (error) {
    Object.assign(modeCheck, { status: 'invalid', reason: error.message,
      details: { configured: mode, path: join(specRoot, mode) } });
  }
  return modeCheck;
}
