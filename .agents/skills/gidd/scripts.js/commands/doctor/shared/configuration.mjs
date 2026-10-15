import { existsSync } from 'node:fs';
import { configurationPath, parseConfiguration, readConfigurationText } from '../../../shared/storage.mjs';
import { check, safeReason } from './result.mjs';

export function inspectConfiguration(root) {
  const path = configurationPath(root);
  let settings;
  try {
    if (!existsSync(path)) return { result: check('config.toml', 'ready', undefined, { path, configured: false }), ui: {} };
    settings = parseConfiguration(readConfigurationText(path));
  } catch (error) {
    return { result: check('config.toml', 'invalid', safeReason(error, 'config_unreadable'), { path }) };
  }
  return { ui: settings.ui, result: check('config.toml', 'ready', undefined, { path }) };
}
