import { readFileSync } from 'node:fs';
import { skillPath } from '../shared/paths.mjs';

export function printHelp(requestedLanguage) {
  const choice = requestedLanguage || process.env.GIDD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  if ((requestedLanguage || process.env.GIDD_LANG) && !/^(zh|en)(?:$|[-_])/.test(choice)) throw new Error('unsupported_help_language');
  const language = /^zh(?:$|[-_])/.test(choice) ? 'zh-CN' : 'en';
  console.log(readFileSync(skillPath('references/gidd.link.help.' + language + '.md'), 'utf8'));
}
