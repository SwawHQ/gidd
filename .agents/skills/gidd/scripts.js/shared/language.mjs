// One precedence rule for help, spec and doctor. Explicit choices are validated;
// other system locales fall back to English, as the existing help/spec did.
export function resolveLanguage(explicit, error = 'unsupported_help_language') {
  const choice = explicit || process.env.GIDD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  if ((explicit || process.env.GIDD_LANG) && !/^(zh|en)(?:$|[-_])/.test(choice)) throw new Error(error);
  return /^zh(?:$|[-_])/.test(choice) ? 'zh-CN' : 'en';
}
