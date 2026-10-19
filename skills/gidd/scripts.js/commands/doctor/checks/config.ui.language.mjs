import { validateUiLanguage } from '../../../shared/language.mjs';

export const id = 'config.ui.language';
export function run(context) {
  if (context.configuration().result.status !== 'ready')
    return { id, status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' };
  const language = context.configuration().ui?.language;
  if (language === undefined) return { id, status: 'ready', details: { source: 'system' } };
  try {
    validateUiLanguage(language);
    return { id, status: 'ready', details: { configured: language } };
  } catch (error) { return { id, status: 'invalid', reason: error.message }; }
}
