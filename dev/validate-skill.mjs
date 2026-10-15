import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadYaml, lexMarkdown, walkTokens } from './vendor/skill-parsers.mjs';

const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateFrontmatter(markdown, folderName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error('SKILL.md must begin with YAML frontmatter between --- lines.');
  const metadata = loadYaml(match[1]);
  if (!isMapping(metadata)) throw new Error('Frontmatter must be a YAML mapping.');
  const { name, description } = metadata;
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('name must contain 1-64 lowercase letters, digits or single hyphens between words.');
  }
  if (name !== folderName) throw new Error(`name must match the skill folder: ${folderName}`);
  if (typeof description !== 'string' || !description.trim() || description.length > 1024 || /[<>]/.test(description)) {
    throw new Error('description must be nonempty text, at most 1024 characters, without angle brackets.');
  }
  if (/\[TODO:[\s\S]*?\]/i.test(description)) throw new Error('description contains an unfinished TODO placeholder.');
  const allowed = new Set(['name', 'description', 'license', 'compatibility', 'allowed-tools', 'metadata']);
  for (const key of Object.keys(metadata)) {
    if (!allowed.has(key)) throw new Error(`Unknown frontmatter field: ${key}`);
  }
  const body = markdown.slice(match[0].length);
  walkTokens(lexMarkdown(body), token => {
    if (token.type === 'text' && /\[TODO:[\s\S]*?\]/i.test(token.text)) {
      throw new Error('SKILL.md contains an unfinished TODO placeholder.');
    }
  });
  return { metadata, body };
}

// Check file destinations only. Remote resources and heading anchors are not
// fetched or validated. Markdown parsing keeps code examples out of this check.
export function validateLocalLinks(markdown, file) {
  const errors = [];
  walkTokens(lexMarkdown(markdown), token => {
    if (!['link', 'image'].includes(token.type)) return;
    const href = token.href;
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return;
    try {
      const path = decodeURIComponent(href.split(/[?#]/, 1)[0]);
      if (path && !existsSync(resolve(dirname(file), path))) errors.push(`Missing local link: ${href}`);
    } catch {
      errors.push(`Invalid local link: ${href}`);
    }
  });
  return errors;
}

export function validateSkill(directory) {
  const errors = [];
  const skillFile = join(directory, 'SKILL.md');
  let skillBody;
  try {
    skillBody = validateFrontmatter(readFileSync(skillFile, 'utf8'), basename(resolve(directory))).body;
  } catch (error) {
    errors.push(`${skillFile}: ${error.message}`);
  }
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const markdown = file === skillFile ? skillBody : readFileSync(file, 'utf8');
        if (markdown !== undefined) {
          for (const error of validateLocalLinks(markdown, file)) errors.push(`${file}: ${error}`);
        }
      }
    }
  }
  visit(directory);
  return errors;
}
