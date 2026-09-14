// Deliberately limited to the Markdown sections used by Issue body templates.
// Code, comments and quoted examples cannot create sections or acceptance tasks.
const visibleText = text => text.replace(/!?\[([^\[\]]*)\]\([^()]*\)/g, '$1').replace(/<[^<>]*>/g, '')
  .replace(/&(?:nbsp|#160|#x0*a0);/gi, ' ').replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '');
const normalize = text => visibleText(text).replace(/[*_`]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
const meaningful = text => /[\p{L}\p{N}]/u.test(visibleText(text));

function markdownNodes(body) {
  const nodes = [];
  let fence, comment = false, html;
  for (const [index, original] of body.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).entries()) {
    const line = index + 1;
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(original);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = undefined;
      else nodes.push({ type: 'code', text: original, line });
      continue;
    }
    let text = '', rest = original;
    while (rest) {
      if (comment) {
        const end = rest.indexOf('-->');
        if (end < 0) break;
        comment = false; rest = rest.slice(end + 3);
      } else {
        const start = rest.indexOf('<!--');
        if (start < 0) { text += rest; break; }
        text += rest.slice(0, start); rest = rest.slice(start + 4); comment = true;
      }
    }
    if (html) {
      if (html === 'block' ? !text.trim() : new RegExp(`</${html}\\s*>`, 'i').test(text)) html = undefined;
      continue;
    }
    const htmlStart = /^ {0,3}<(pre|script|style|textarea)(?:\s|>)/i.exec(text);
    if (htmlStart) {
      if (!new RegExp(`</${htmlStart[1]}\\s*>`, 'i').test(text)) html = htmlStart[1];
      continue;
    }
    if (/^ {0,3}<\/?[a-z][a-z0-9-]*(?:\s[^<>]*?)?\/?>(?:\s*<\/[^>]+>)?\s*$/i.test(text)) { html = 'block'; continue; }
    if (/^ {0,3}>/.test(text)) continue;
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) { fence = opening[1]; continue; }
    if (/^(?: {4}|\t)/.test(text)) { nodes.push({ type: 'code', text, line }); continue; }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(text);
    if (heading) {
      nodes.push({ type: 'heading', level: heading[1].length, text: (heading[2] || '').replace(/[ \t]#+[ \t]*$/, ''), line });
      continue;
    }
    const previous = nodes.at(-1);
    if (/^ {0,3}(?:=+|-+)\s*$/.test(text) && previous?.type === 'text' && previous.line === line - 1 &&
        previous.text.trim() && !previous.task && !/^\s*[-+*]\s/.test(previous.text)) {
      previous.type = 'heading'; previous.level = text.trim()[0] === '=' ? 1 : 2;
      continue;
    }
    const task = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+\[[ \txX]\][ \t]+(.*)$/.exec(text);
    nodes.push({ type: 'text', text: task ? task[1] : text, task: !!task, line });
  }
  return nodes;
}

function sectionsIn(body) {
  const sections = [];
  let section;
  for (const node of markdownNodes(body)) {
    if (node.type === 'heading' && node.level <= 2) {
      section = { name: normalize(node.text), line: node.line, nodes: [] }; sections.push(section);
    } else if (section && node.type !== 'heading') section.nodes.push(node);
  }
  return sections;
}

export function validateIssueRules(rules) {
  const invalid = () => { throw new Error('spec_resources_invalid'); };
  if (rules?.schema !== 'gidd.issue-rules/v1' || rules.scope !== 'issue_body' ||
      Object.keys(rules).some(key => !['schema', 'scope', 'sections'].includes(key)) ||
      !Array.isArray(rules.sections) || !rules.sections.length || rules.sections.length > 32) invalid();
  const ids = new Set(), headings = new Set();
  for (const section of rules.sections) {
    if (!/^[a-z][a-z0-9-]*$/.test(section?.id || '') || ids.has(section.id) ||
        Object.keys(section).some(key => !['id', 'headings', 'required', 'placeholders', 'min_task_items'].includes(key)) ||
        typeof section.required !== 'boolean' || !Array.isArray(section.placeholders) ||
        section.placeholders.some(value => typeof value !== 'string' || !value.trim()) ||
        (section.min_task_items !== undefined && (!Number.isInteger(section.min_task_items) || section.min_task_items < 1 || section.min_task_items > 100))) invalid();
    ids.add(section.id);
    if (!section.headings || Object.keys(section.headings).some(key => !['zh-CN', 'en'].includes(key))) invalid();
    for (const lang of ['zh-CN', 'en']) {
      const title = section.headings?.[lang];
      if (typeof title !== 'string' || !normalize(title) || /[\r\n]/.test(title) || headings.has(normalize(title))) invalid();
      headings.add(normalize(title));
    }
  }
  return rules;
}

export function validateIssueTemplate(body, rules, lang) {
  const sections = sectionsIn(body);
  for (const rule of rules.sections) {
    const matches = sections.filter(section => section.name === normalize(rule.headings[lang]));
    if (matches.length > 1 || (rule.required && matches.length !== 1)) throw new Error('spec_resources_invalid');
  }
}

export function checkIssueMarkdown(body, rules, lang = 'en') {
  const sections = sectionsIn(body), zh = lang === 'zh-CN';
  return rules.sections.map(rule => {
    const names = Object.values(rule.headings).map(normalize);
    const matches = sections.filter(section => names.includes(section.name));
    const section = matches[0], title = rule.headings[lang];
    const check = { id: 'issue.' + rule.id, section: rule.id, status: 'passed' };
    const fail = (reason, line, hint) => ({ ...check, status: 'failed', reason, ...(line ? { line } : {}), hint });
    if (matches.length > 1) return fail('section_duplicate', matches[1].line,
      zh ? `合并重复的“${title}”章节。` : `Combine duplicate ${title} sections.`);
    if (!section) return rule.required ? fail('section_missing', undefined,
      zh ? `添加“## ${title}”并填写内容。` : `Add ## ${title} and complete its contents.`) : check;
    const placeholder = node => {
      const value = normalize(node.text);
      return rule.placeholders.some(sample => value === normalize(sample) || (sample.length > 8 && value.includes(normalize(sample))));
    };
    if (rule.required && !section.nodes.some(node => meaningful(node.text))) return fail('section_empty', section.line,
      zh ? `填写“${title}”的实际内容。` : `Complete ${title} with actual content.`);
    const sample = section.nodes.find(node => node.type === 'text' && placeholder(node));
    if (sample) return fail('placeholder_remaining', sample.line,
      zh ? `替换“${title}”中的模板占位内容。` : `Replace template placeholders in ${title}.`);
    if (rule.min_task_items && section.nodes.filter(node => node.type === 'text' && node.task && meaningful(node.text) && !placeholder(node)).length < rule.min_task_items) {
      return fail('acceptance_items_missing', section.line,
        zh ? `在“${title}”中填写至少 ${rule.min_task_items} 项有效勾选条目；允许未勾选。` :
          `Add at least ${rule.min_task_items} meaningful checkbox item(s) to ${title}; unchecked items are allowed.`);
    }
    return check;
  });
}
