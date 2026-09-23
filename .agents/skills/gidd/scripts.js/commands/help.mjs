import { readFileSync } from 'node:fs';
import { skillPath } from '../shared/paths.mjs';
import { resolveLanguage } from '../shared/language.mjs';

export function printHelp(requestedLanguage) {
  const language = resolveLanguage(requestedLanguage);
  console.log(readFileSync(skillPath('references/gidd.link.help.' + language + '.md'), 'utf8'));
}
