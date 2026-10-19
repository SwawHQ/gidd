import { readFileSync } from 'node:fs';
import { skillPath } from '../shared/paths.mjs';
import { resolveLanguage } from '../shared/language.mjs';

export function printHelp(requestedLanguage, repository) {
  const language = resolveLanguage(requestedLanguage, 'unsupported_help_language', repository);
  console.log(readFileSync(skillPath('references/gidd.help.' + language + '.md'), 'utf8'));
}
