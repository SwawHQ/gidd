import { existsSync } from 'node:fs';
import { configurationPath, parseConfiguration, readConfigurationText } from '../../../shared/storage.mjs';
import { check, safeReason } from './result.mjs';

export function inspectConfiguration(root) {
  if (!root) return { result: check('config.toml', 'not_checked', 'target_unavailable'), remote: {} };
  const path = configurationPath(root);
  let settings;
  try {
    if (!existsSync(path)) return { result: check('config.toml', 'missing', 'config_missing', { path }), remote: {} };
    settings = parseConfiguration(readConfigurationText(path));
  } catch (error) {
    return { result: check('config.toml', 'invalid', safeReason(error, 'config_unreadable'), { path }), remote: {} };
  }
  return { remote: settings.repo.remote, git: settings.git, spec: settings.spec, result: check('config.toml', 'ready', undefined, { path }) };
}
