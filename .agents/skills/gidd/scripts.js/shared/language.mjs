import { configurationPath, parseConfiguration, readConfigurationText } from './storage.mjs';

export function validateUiLanguage(value) {
  if (!['zh', 'en'].includes(value)) throw new Error('config_invalid_ui_language');
}

// Explicit choice > user preference > system locale. Help and doctor must
// remain usable while configuration is missing, unreadable or being repaired.
export function resolveLanguage(explicit, error = 'unsupported_help_language', repository) {
  let configured;
  if (!explicit) {
    try {
      const value = parseConfiguration(readConfigurationText(configurationPath(repository))).ui.language;
      if (value !== undefined) { validateUiLanguage(value); configured = value; }
    } catch { /* Doctor reports configuration problems independently. */ }
  }
  const choice = explicit || configured || Intl.DateTimeFormat().resolvedOptions().locale;
  if (explicit && !/^(zh|en)(?:$|[-_])/.test(choice)) throw new Error(error);
  return /^zh(?:$|[-_])/.test(choice) ? 'zh-CN' : 'en';
}
