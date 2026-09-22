import { join } from 'node:path';
import { loadSpecCatalog, loadSpec, specRoot, specCatalogHint, specSelectionHint } from '../../../shared/specs.mjs';

export const id = 'config.spec.current';
export function run(context) {
  const configuration = context.configuration();
  const mode = configuration.spec?.current, repository = context.configRoot || context.target;
  const modeCheck = { id, status: 'ready' };
  if (configuration.result.status !== 'ready') {
    Object.assign(modeCheck, { status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' });
    return modeCheck;
  }
  let catalog;
  try { catalog = loadSpecCatalog(); }
  catch (error) {
    Object.assign(modeCheck, { status: 'invalid', reason: error.message, hint: specCatalogHint });
    return modeCheck;
  }
  const names = catalog.en.map(spec => spec.name);
  if (!names.includes(mode)) {
    Object.assign(modeCheck, { status: mode === undefined ? 'missing' : 'invalid',
      reason: mode === undefined ? 'spec_current_missing' : 'spec_current_unsupported',
      details: { available_names: names }, hint: specSelectionHint,
      commands: [
        { executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'), args: ['spec.list'] },
        { executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'), args: ['spec', '<name>'], required_inputs: ['spec.current'] },
        { executable: join(repository, '.agents/skills/gidd/gidd.link.cmd'), args: ['set', 'spec.current', '<name>'], required_inputs: ['spec.current'] },
      ] });
    return modeCheck;
  }
  modeCheck.details = { configured: mode };
  try { loadSpec(mode, catalog); }
  catch (error) {
    Object.assign(modeCheck, { status: 'invalid', reason: error.message,
      hint: 'Repair specs/' + mode + '/ and its referenced Markdown and Issue templates, then rerun doctor.',
      details: { configured: mode, path: join(specRoot, mode) } });
  }
  return modeCheck;
}
