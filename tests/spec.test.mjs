import { test } from 'node:test';
import { symlinkSync } from 'node:fs';
import { configure } from '../.agents/skills/gidd/scripts.js/config.mjs';
import { parseConfiguration } from '../.agents/skills/gidd/scripts.js/storage.mjs';
import { specCommand, parseSpecArguments } from '../.agents/skills/gidd/scripts.js/spec.mjs';
import { loadSpec, loadSpecCatalog, specRoot } from '../.agents/skills/gidd/scripts.js/specs.mjs';
import { readSpecPrompt } from '../.agents/skills/gidd/scripts.js/spec-resources.mjs';
import { parseSpecYaml, validateIssueForms } from '../.agents/skills/gidd/scripts.js/spec-data.mjs';
import { publishRepositoryEntry, runRepositoryCommand } from './support/repository.mjs';
import { adapter, assert, bindFixture, compile, copySkill, dirname, findGit, fixture, join, json, mkdirSync, ok,
  readFileSync, readdirSync, rmSync, run, snapshot, stub, toolsRoot, write } from './support/helpers.mjs';

const names = [
  "00.all.auto",
  "01.all.ask",
  "02.issue",
  "03.issue.ask-close",
  "04.issue.ask-commit",
  "05.issue.ask-commit.ask-close",
  "06.issue.pr",
  "07.issue.pr.ask-close",
  "08.issue.pr.ask-commit",
  "09.issue.pr.ask-commit.ask-close",
  "10.issue.pr.ask-merge",
  "11.issue.pr.ask-merge.ask-close",
  "12.issue.pr.ask-commit.ask-merge",
  "13.issue.pr.ask-commit.ask-merge.ask-close"
];
const chosen = 'schema_version = 1\n[spec]\ncurrent = "04.issue.ask-commit"\n';
const configPath = root => join(root, '.agents/skills/gidd/config.toml');
const description = [{ issue: 'required' }, { branch_pr: 'optional' }, { stage_commit_push: 'ask' },
  { merge_and_related_failures: 'auto' }, { close_issue: 'auto' }, { other_steps: 'auto' }];
const meta = (body, template, summary = description) => '---\ndescription: ' + JSON.stringify(summary) + '\n' +
  (template ? 'issue_template: ' + template + '\n' : '') + '---\n' + body;
const check = report => report.checks.find(item => item.id === 'config.spec.current');
function installation(f, config = chosen) {
  const skill = join(f.root, "installed 中文 & ' spaces"), target = join(f.root, 'target');
  copySkill(skill); mkdirSync(join(target, '.git'), { recursive: true });
  if (config !== null) write(configPath(target), config);
  ok(adapter(f.root, { action: 'bootstrap', repositoryRoot: target, responses: {}, downloads: {}, yes: true }, { env: { PATH: dirname(process.execPath) } }));
  publishRepositoryEntry(target, join(skill, 'scripts.js/gidd.mjs'));
  const invoke = (args, env = {}) => runRepositoryCommand(target, args, { cwd: f.root, env: { PATH: '', GIDD_LANG: 'en', ...env } });
  return { skill, target, invoke, root: join(skill, 'specs'), diagnose: () => json(invoke(['doctor', '--offline'])) };
}
function resourceFixture(f) {
  const root = join(f.root, 'specs'), prompt = join(root, 'sample/prompt.en.md');
  const save = (body, template) => {
    for (const lang of ['en', 'zh-CN']) write(join(root, 'sample/prompt.' + lang + '.md'), meta(body, template));
  };
  save('# Sample\n');
  return { root, prompt, save, load: () => loadSpec('sample', loadSpecCatalog(root), root) };
}

test('fourteen presets expose bilingual summaries, expanded guidance and shared forms', () => {
  const catalog = loadSpecCatalog();
  for (const lang of ['en', 'zh-CN']) assert.deepEqual(catalog[lang].map(item => item.name), names);
  const policies = [
    Array(6).fill('agent_decides'), Array(6).fill('user_decides'),
    ['required', 'optional', 'auto', 'auto', 'auto', 'auto'],
    ['required', 'optional', 'auto', 'auto', 'ask', 'auto'],
    ['required', 'optional', 'ask', 'auto', 'auto', 'auto'],
    ['required', 'optional', 'ask', 'auto', 'ask', 'auto'],
    ['required', 'required', 'auto', 'auto', 'auto', 'auto'],
    ['required', 'required', 'auto', 'auto', 'ask', 'auto'],
    ['required', 'required', 'ask', 'auto', 'auto', 'auto'],
    ['required', 'required', 'ask', 'auto', 'ask', 'auto'],
    ['required', 'required', 'auto', 'ask', 'auto', 'auto'],
    ['required', 'required', 'auto', 'ask', 'ask', 'auto'],
    ['required', 'required', 'ask', 'ask', 'auto', 'auto'],
    ['required', 'required', 'ask', 'ask', 'ask', 'auto'],
  ];
  for (const lang of ['en', 'zh-CN']) catalog[lang].forEach((item, index) => {
    assert.deepEqual(item.description.map(entry => Object.keys(entry)[0]), description.map(entry => Object.keys(entry)[0]));
    assert.deepEqual(item.description.map(entry => Object.values(entry)[0]), policies[index]);
  });
  for (const name of names) {
    const spec = loadSpec(name, catalog);
    assert.deepEqual(readdirSync(join(specRoot, name)).sort(), ['prompt.en.md', 'prompt.zh-CN.md']);
    for (const lang of ['en', 'zh-CN']) {
      const text = spec.prompts[lang].content;
      assert.ok(text.includes('# ' + name)); assert.doesNotMatch(text, /^@include|^description:|^issue_template:/m);
      assert.ok(text.includes('gidd.link spec.issue.current'));
      assert.ok(spec.issueForms[lang].body.length);
      const rendered = specCommand(specRoot, parseSpecArguments('spec', [name, '--lang', lang])).markdown;
      assert.ok(rendered.includes('gidd.link spec.issue ' + name + ' --lang ' + (lang === 'en' ? 'en' : 'zh')));
      assert.ok(!rendered.includes('@gidd.link spec.issue.current@'));
    }
  }
});

test('routes separate names from operations and reject retired syntax', () => {
  for (const [route, args, action, current, selector] of [
    ['spec.list', [], 'list', false, undefined], ['spec.current', [], 'show', true, undefined],
    ['spec.issue.current', [], 'issue', true, undefined], ['spec', ['07.issue.pr.ask-close'], 'show', false, '07.issue.pr.ask-close'],
    ['spec.issue', ['00.all.auto'], 'issue', false, '00.all.auto'], ['spec', ['current'], 'show', false, 'current'],
  ]) assert.deepEqual(parseSpecArguments(route, [...args, '--lang', 'zh']), { action, current, selector, lang: 'zh-CN' });
  for (const route of ['spec.current.issue', 'spec.issue-direct', 'spec.all.ask', 'spec.list.issue']) assert.throws(() => parseSpecArguments(route, []), /invalid_spec_route/);
  for (const [route, args] of [['spec', []], ['spec.issue', []], ['spec', ['../outside']], ['spec', ['a..b']],
    ['spec', ['_share']], ['spec.current', ['issue']], ['spec.list', ['issue']], ['spec.issue.current', ['current']],
    ['spec', ['issue', '--lang', 'en', '--lang', 'zh']], ['spec', ['issue', '--json']]]) assert.throws(() => parseSpecArguments(route, args), /invalid_arguments/);
  assert.throws(() => parseSpecArguments('spec.current', ['--lang', 'fr']), /unsupported_help_language/);
});

test('numbered names select exact resources without numeric or unnumbered aliases', () => {
  const f = fixture();
  try {
    for (const route of ['spec', 'spec.issue']) {
      assert.equal(specCommand(f.root, parseSpecArguments(route, ['00.all.auto'])).exitCode, 0);
      assert.equal(specCommand(f.root, parseSpecArguments(route, ['all.auto'])).report.error, 'spec_current_unsupported');
      for (const name of ['00', '0.all.auto', '000.all.auto', '00..all.auto']) assert.throws(() => parseSpecArguments(route, [name]), /invalid_arguments/);
    }
    configure(f.root, 'set', 'spec.current', '13.issue.pr.ask-commit.ask-merge.ask-close');
    assert.equal(parseConfiguration(readFileSync(configPath(f.root), 'utf8')).spec.current, '13.issue.pr.ask-commit.ask-merge.ask-close');
    const before = snapshot(f.root);
    for (const name of ['13', 'issue.pr.ask-commit.ask-merge.ask-close']) assert.throws(() => configure(f.root, 'set', 'spec.current', name), /spec_current_unsupported/);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.dispose(); }
});

test('discovery skips helpers and placeholders but validates bilingual metadata', () => {
  const f = fixture();
  try {
    const s = resourceFixture(f);
    write(join(s.root, '_lib/broken/prompt.en.md'), 'not a spec'); write(join(s.root, 'placeholder/.gitkeep'), '');
    write(join(s.root, 'AGENTS.md'), '# Authoring instructions, not a selectable spec');
    assert.deepEqual(loadSpecCatalog(s.root).en.map(item => item.name), ['sample']);
    for(const lang of ['en','zh-CN']) write(join(s.root,'current/prompt.'+lang+'.md'), meta('# named current'));
    assert.deepEqual(loadSpecCatalog(s.root).en.map(item => item.name), ['current', 'sample']);
    rmSync(join(s.root, 'sample/prompt.zh-CN.md')); assert.throws(() => loadSpecCatalog(s.root), /spec_resources_missing/);
    s.save('# restored');
    for (const invalid of ['# no front matter', '---\ndescription: ""\n---\n# body', '---\ndescription: x\ndescription: y\n---\n# body',
      '---\ndescription: [x]\n---\n# body', meta('# body').replace('\n---\n# body', '\nextra: no\n---\n# body'),
      meta('# body', '5'), meta('')]) {
      write(s.prompt, invalid); assert.throws(() => loadSpecCatalog(s.root), /spec_(metadata|resources)_invalid/);
    }
    s.save('# restored'); write(s.prompt, meta('# only English template', '../_share/issue.en.json'));
    assert.throws(() => loadSpecCatalog(s.root), /spec_metadata_mismatch/);
    s.save('# restored'); symlinkSync(join(s.root, 'sample'), join(s.root, 'linked'), 'junction');
    assert.throws(() => loadSpecCatalog(s.root), /spec_directory_invalid/);
  } finally { f.dispose(); }
});

test('descriptions require six unique single-key entries with field-specific values', () => {
  const f = fixture();
  try {
    const s = resourceFixture(f);
    const invalid = [null, false, 1, 'legacy summary', {}, [], Object.assign({}, ...description),
      description.slice(1), [...description, { issue: 'required' }],
      ...[null, [], 'issue', 1, {}, { issue: 'required', branch_pr: 'optional' },
        { unknown: 'required' }, { Issue: 'required' }, { branch_pr: 'optional' },
        { issue: 'ask' }, { issue: true }, { issue: ['required'] }, { issue: 'Required' },
        { issue: 'required\n' }].map(item => [item, ...description.slice(1)]),
      [...description.slice(0, 2), { stage_commit_push: 'required' }, ...description.slice(3)],
      [...description.slice(0, 5), { other_steps: 'optional' }],
    ];
    for (const value of invalid) {
      write(s.prompt, meta('# body', undefined, value));
      assert.throws(() => readSpecPrompt(s.prompt), /spec_metadata_invalid/, JSON.stringify(value));
    }
    for (const choice of ['agent_decides', 'user_decides']) {
      const value = description.map(item => ({ [Object.keys(item)[0]]: choice }));
      write(s.prompt, meta('# body', undefined, value));
      assert.deepEqual(readSpecPrompt(s.prompt).metadata.description, value);
    }
    const value = [...description.slice(0, 5), { other_steps: 'ask' }];
    write(s.prompt, meta('# body', undefined, value));
    assert.deepEqual(readSpecPrompt(s.prompt).metadata.description, value);
  } finally { f.dispose(); }
});

test('description order follows the source and bilingual values and order must match', () => {
  const f = fixture();
  try {
    const s = resourceFixture(f), reordered = [...description].reverse();
    const translated = join(s.root, 'sample/prompt.zh-CN.md');
    for (const path of [s.prompt, translated]) write(path, meta('# body', undefined, reordered));
    const before = snapshot(f.root), catalog = loadSpecCatalog(s.root);
    for (const lang of ['en', 'zh-CN']) assert.deepEqual(catalog[lang][0].description, reordered);
    assert.deepEqual(snapshot(f.root), before);
    for (const mismatch of [description, [...reordered.slice(0, 5), { issue: 'optional' }]]) {
      write(translated, meta('# body', undefined, mismatch));
      assert.throws(() => loadSpecCatalog(s.root), /spec_metadata_mismatch/);
    }
  } finally { f.dispose(); }
});

test('includes resolve per source, allow repeated fragments and preserve code examples', () => {
  const f = fixture();
  try {
    const s = resourceFixture(f), ticks = String.fromCharCode(96).repeat(3);
    write(join(s.root, '_share/a.md'), 'A\n@include nested/b.md@\n'); write(join(s.root, '_share/nested/b.md'), '中文 B');
    const code = '\n~~~md\n@include missing.md@\n~~~\n' + ticks + 'text\n@include missing.md@\n' + ticks + '\n    @include indented.md@\n';
    s.save('@include ../_share/a.md@\n@include ../_share/a.md@\n' + code);
    const before = snapshot(f.root);
    assert.equal(s.load().prompts.en.content, 'A\n中文 B\nA\n中文 B\n' + code);
    assert.deepEqual(snapshot(f.root), before);
    write(join(s.root, '_share/rule.md'), '---\nA thematic break, not metadata.\n');
    s.save('@include ../_share/rule.md@\n');
    assert.equal(s.load().prompts.en.content, '---\nA thematic break, not metadata.\n');
    for (const newline of ['\n', '\r\n']) {
      write(s.prompt, '\uFEFF' + meta('# custom\n').replace(/\n/g, newline)); assert.ok(readSpecPrompt(s.prompt).content.includes('# custom'));
    }
  } finally { f.dispose(); }
});

test('include failures reject missing, cyclic, escaping, nonplain and excessive resources', () => {
  const f = fixture();
  try {
    const s = resourceFixture(f), shared = join(s.root, '_share');
    write(join(shared, 'a.md'), '@include b.md@\n'); write(join(shared, 'b.md'), '@include a.md@\n');
    for (const [body, reason] of [
      ['@include ../_share/missing.md@\n', 'spec_resources_missing'], ['@include ../_share/a.md@\n', 'spec_include_cycle'],
      ['@include ../../outside.md@\n', 'spec_resource_path_invalid'], ['@include C:/outside.md@\n', 'spec_resource_path_invalid'],
      ['@include https://example.test/a.md@\n', 'spec_resource_path_invalid'], ['@include ../_share/a.md', 'spec_include_invalid'],
      ['@include ../_share/form.json@\n', 'spec_include_invalid'],
    ]) { s.save(body); assert.throws(s.load, new RegExp(reason)); }
    write(join(shared, 'front.md'), meta('# fragment')); s.save('@include ../_share/front.md@\n'); assert.throws(s.load, /spec_include_metadata/);
    for (const value of [Buffer.from([255]), 'text\0hidden', ' ', 'x'.repeat(65537)]) {
      write(join(shared, 'bad.md'), value); s.save('@include ../_share/bad.md@\n'); assert.throws(s.load, /spec_resources_invalid/);
    }
    const outside = join(f.root, 'outside'); write(join(outside, 'secret.md'), 'outside');
    symlinkSync(outside, join(shared, 'linked'), 'junction'); s.save('@include ../_share/linked/secret.md@\n'); assert.throws(s.load, /spec_resource_path_invalid/);
    write(join(shared, 'large.md'), 'x'.repeat(60000)); s.save(('@include ../_share/large.md@\n').repeat(5)); assert.throws(s.load, /spec_include_limit/);
    for (let i = 0; i < 18; i++) write(join(shared, i + '.md'), i === 17 ? 'end' : '@include ' + (i+1) + '.md@\n');
    s.save('@include ../_share/0.md@\n'); assert.throws(s.load, /spec_include_limit/);
  } finally { f.dispose(); }
});

test('templates follow explicit local or shared JSON paths without fallback', () => {
  const f = fixture();
  try {
    const s = resourceFixture(f), forms = loadSpec('02.issue').issueForms;
    const setForms = directory => {
      for (const lang of ['en', 'zh-CN']) {
        write(join(s.root, directory, 'issue.' + lang + '.json'), JSON.stringify(forms[lang]));
        write(join(s.root, 'sample/prompt.' + lang + '.md'), meta('# template', (directory === 'sample' ? './' : '../' + directory + '/') + 'issue.' + lang + '.json'));
      }
    };
    setForms('_share'); assert.deepEqual(s.load().issueForms, forms);
    for (const lang of ['en', 'zh-CN']) write(join(s.root, 'sample/issue.' + lang + '.json'), '{}');
    assert.deepEqual(s.load().issueForms, forms);
    rmSync(join(s.root, '_share/issue.en.json')); assert.throws(s.load, /spec_resources_missing/);
    setForms('sample'); assert.deepEqual(s.load().issueForms, forms);
    for (const text of ['{bad', '{}', JSON.stringify({ ...forms.en, body: [...forms.en.body].reverse() })]) {
      write(join(s.root, 'sample/issue.en.json'), text); assert.throws(s.load, /spec_resources_invalid/);
    }
    setForms('sample'); s.save('# without template'); assert.equal(s.load().issueForms, undefined);
    s.save('# escape', '../../outside.json'); assert.throws(s.load, /spec_resource_path_invalid/);
  } finally { f.dispose(); }
});

test('configuration edits preserve text and dotted choices, and reject retired fields', () => {
  const f = fixture();
  try {
    const path = configPath(f.root);
    for (const newline of ['\n', '\r\n']) {
      const text = '\uFEFF' + ['# 用户注释', 'schema_version = 1', '[spec]', "current = 'unknown' # keep", ''].join(newline);
      write(path, text); configure(f.root, 'set', 'spec.current', '09.issue.pr.ask-commit.ask-close');
      assert.equal(readFileSync(path, 'utf8'), text.replace("'unknown'", '"09.issue.pr.ask-commit.ask-close"'));
      configure(f.root, 'clear', 'spec.current'); assert.equal(parseConfiguration(readFileSync(path, 'utf8')).spec.current, undefined);
    }
    assert.throws(() => configure(f.root, 'set', 'spec.current', 'missing'), /spec_current_unsupported/);
    assert.throws(() => configure(f.root, 'set', 'spec.mode', 'issue'), /config_unknown_key/);
    assert.throws(() => parseConfiguration('schema_version = 1\n[spec]\nmode = "issue"\n'), /config_unsupported_syntax_or_field/);
  } finally { f.dispose(); }
});

test('CLI lists without config and prints named/current bilingual instructions and templates without writes', () => {
  const f = fixture();
  try {
    const s = installation(f, null);
    assert.deepEqual(json(ok(s.invoke(['spec.list']))).specs.map(item => item.name), names);
    const reordered = [...description].reverse();
    for (const lang of ['en', 'zh-CN']) {
      const path = join(s.root, '04.issue.ask-commit/prompt.' + lang + '.md'), prompt = readSpecPrompt(path);
      write(path, meta(prompt.content, prompt.metadata.issue_template, reordered));
    }
    for (const lang of ['en', 'zh']) {
      const output = ok(s.invoke(['spec.list', '--lang', lang])), listed = json(output).specs;
      const lines = output.stdout.trimEnd().split(/\r?\n/);
      assert.equal(lines.length, names.length + 5);
      assert.deepEqual(lines.slice(3, -2).map(line => JSON.parse(line.replace(/,$/, ''))), listed);
      assert.deepEqual(listed.find(item => item.name === '04.issue.ask-commit').description, reordered);
    }
    for (const content of [null, 'schema_version = 1\n', 'schema_version = 1\n[spec]\ncurrent = "missing"\n', 'broken TOML']) {
      if (content !== null) write(configPath(s.target), content);
      const before = snapshot(f.root), result = s.invoke(['spec.current']);
      assert.equal(result.status, 1); assert.ok(['spec_current_missing', 'spec_current_unsupported', 'spec_configuration_unreadable'].includes(json(result).error));
      ok(s.invoke(['spec', '00.all.auto'])); ok(s.invoke(['spec.issue', '00.all.auto'])); assert.deepEqual(snapshot(f.root), before);
    }
    write(configPath(s.target), chosen);
    for (const lang of ['en', 'zh']) {
      const before = snapshot(f.root), current = ok(s.invoke(['spec.current', '--lang', lang])).stdout;
      assert.equal(current, ok(s.invoke(['spec', '04.issue.ask-commit', '--lang', lang])).stdout);
      assert.match(current, lang === 'en' ? /Prompt source:/ : /提示来源/); assert.doesNotMatch(current, /^@include|^description:/m);
      assert.deepEqual(json(ok(s.invoke(['spec.issue.current', '--lang', lang]))), json(ok(s.invoke(['spec.issue', '04.issue.ask-commit', '--lang', lang]))));
      assert.deepEqual(snapshot(f.root), before);
    }
    assert.match(ok(s.invoke(['spec.current'], { GIDD_LANG: 'zh' })).stdout, /提示来源/);
    assert.equal(json(s.invoke(['spec.current.issue'])).error, 'invalid_spec_route');
    assert.equal(json(s.invoke(['spec', 'missing'])).error, 'spec_current_unsupported');
    assert.equal(json(s.invoke(['spec.current', '--repository', f.root])).reason, 'repository_override_forbidden');
    for (const lang of ['en', 'zh-CN']) write(join(s.root, 'no-template/prompt.' + lang + '.md'), meta('# No template'));
    const noTemplate = json(s.invoke(['spec.issue', 'no-template']));
    assert.equal(noTemplate.error, 'spec_issue_template_missing');
    assert.match(noTemplate.hint, /does not declare issue_template/);
  } finally { f.dispose(); }
});

test('doctor and spec readers validate both languages and complete dependencies before output', () => {
  const f = fixture();
  try {
    const s = installation(f, chosen + '[git]\nuser.mode = "inherit"\ncredential.mode = "inherit"\n[repo]\nremote.name = "origin"\nremote.account = "Octocat"\nremote.url = "https://github.com/owner/repo"\n');
    const git = findGit(), gh = join(f.root, 'bin/gh.exe'); stub(compile(f.root), gh); bindFixture(f.root, { git, gh });
    for (const args of [['init', '--quiet'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.test'],
      ['remote', 'add', 'origin', 'https://github.com/owner/repo']]) ok(run(git, ['-C', s.target, ...args]));
    assert.equal(check(json(ok(s.invoke(['doctor', '--offline'])))).status, 'ready');
    const path = join(s.root, '_share/common.en.md'), saved = readFileSync(path);
    rmSync(path);
    assert.equal(check(json(ok(s.invoke(['doctor', '--offline'])))).status, 'ready');
    const promptPath = join(s.root, '04.issue.ask-commit/prompt.en.md');
    write(promptPath, readFileSync(promptPath, 'utf8') + '\n@include ../_share/common.en.md@\n');
    write(path, '@include missing.md@\n');
    const before = snapshot(f.root);
    assert.equal(check(s.diagnose()).reason, 'spec_resources_missing');
    const failed = s.invoke(['spec.current', '--lang', 'zh']);
    assert.equal(failed.status, 1); assert.equal(failed.stderr, ''); assert.equal(json(failed).error, 'spec_resources_missing');
    assert.deepEqual(snapshot(f.root), before); write(path, saved); assert.equal(check(s.diagnose()).status, 'ready');
    const translationPath = join(s.root, '04.issue.ask-commit/prompt.zh-CN.md');
    const translation = readFileSync(translationPath, 'utf8'), translated = readSpecPrompt(translationPath);
    write(translationPath, meta(translated.content, translated.metadata.issue_template,
      [{ issue: 'optional' }, ...description.slice(1)]));
    const mismatched = snapshot(f.root);
    assert.equal(check(s.diagnose()).reason, 'spec_metadata_mismatch');
    for (const args of [['spec.list'], ['spec.current'], ['spec.issue.current'], ['set', 'spec.current', '02.issue']]) {
      const result = s.invoke(args);
      assert.notEqual(result.status, 0);
      if (args[0] === 'set') assert.match(result.stderr, /^Repair specs\//);
      else assert.equal(result.stderr, '');
      const report = json(result);
      assert.equal(report.error ?? report.reason, 'spec_metadata_mismatch');
    }
    assert.deepEqual(snapshot(f.root), mismatched);
    write(translationPath, translation);
    write(configPath(s.target), 'schema_version = 1\n');
    const missing = check(s.diagnose());
    assert.deepEqual(missing.commands.map(c => c.args), [['spec.list'], ['spec', '<name>'], ['set', 'spec.current', '<name>']]);
    assert.deepEqual(missing.details.available_names, names);
  } finally { f.dispose(); }
});

test('printed template commands bind the selected name and language after includes without execution', () => {
  const f = fixture();
  try {
    const s = installation(f), marker = '@gidd.link spec.issue.current@';
    const ticks = String.fromCharCode(96).repeat(3);
    for (const lang of ['en', 'zh-CN']) {
      const body = '# Rendered\nInline: ' + marker + '\n@include ../_share/render.md@\n';
      write(join(s.root, '02.issue/prompt.' + lang + '.md'), meta(body, '../_share/issue.' + lang + '.json'));
    }
    write(join(s.root, '_share/render.md'), ticks + '\n' + marker + '\n' + ticks + '\n@gidd.link .gh issue create@\n');
    for (const lang of ['en', 'zh']) {
      const before = snapshot(f.root), text = ok(s.invoke(['spec', '02.issue', '--lang', lang])).stdout;
      const command = 'gidd.link spec.issue 02.issue --lang ' + lang;
      assert.equal(text.split(command).length - 1, 2);
      assert.ok(!text.includes(marker)); assert.ok(!text.includes('spec.issue 04.issue.ask-commit'));
      assert.ok(text.includes('@gidd.link .gh issue create@'));
      assert.deepEqual(snapshot(f.root), before);
      write(configPath(s.target), 'schema_version = 1\n[spec]\ncurrent = "00.all.auto"\n');
      assert.equal(ok(s.invoke(['spec', '02.issue', '--lang', lang])).stdout, text);
      write(configPath(s.target), chosen);
      assert.ok(ok(s.invoke(['spec.current', '--lang', lang])).stdout.includes('gidd.link spec.issue 04.issue.ask-commit --lang ' + lang));
    }
    assert.ok(ok(s.invoke(['spec', '02.issue'], { GIDD_LANG: 'zh' })).stdout.includes('gidd.link spec.issue 02.issue --lang zh'));
    const templatePath = join(s.root, '_share/issue.en.json'), form = JSON.parse(readFileSync(templatePath, 'utf8'));
    form.body[0].attributes.placeholder = marker;
    write(templatePath, JSON.stringify(form));
    assert.equal(json(ok(s.invoke(['spec.issue', '02.issue', '--lang', 'en']))).form.body[0].attributes.placeholder, marker);
  } finally { f.dispose(); }
});

test('spec guidance requires neither tools nor remote probes', () => {
  const f = fixture();
  try {
    write(configPath(f.root), chosen); write(join(toolsRoot(f.root), 'tool-bindings.json'), 'broken bindings');
    const before = snapshot(f.root);
    for (const [route, args] of [['spec.current', []], ['spec.issue.current', []], ['spec', ['02.issue']], ['spec.issue', ['02.issue']]]) assert.equal(specCommand(f.root, parseSpecArguments(route, args)).exitCode, 0);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.dispose(); }
});

test('front matter YAML rejects duplicate keys, aliases, tags and multiple documents', () => {
  for (const text of ['key: one\nkey: two', 'text: [unclosed', '---\none: 1\n---\ntwo: 2', 'text: !unknown value',
    'first: &shared text\nsecond: *shared', '%YAML 1.1\n---\nvalue: true', '? [one, two]\n: value', 'section:\n\tkey: value']) assert.throws(() => parseSpecYaml(text));
});
test('forms reject invalid native fields, translation drift and misplaced GIDD checks', () => {
  const spec = loadSpec('02.issue');
  for (const change of [f => { delete f.en; }, f => { f.fr = f.en; },
    f => { f.en.body[0].attributes.label = ''; }, f => { f.en.body[0].attributes.label = 'Goal\nInjected'; },
    f => { f.en.body[0].attributes.placeholders = ['typo']; }, f => { f.en.body[0].attributes.value = false; },
    f => { f.en.body[0].type = 'unknown'; }, f => { f.en.body[0].type = 'input'; },
    f => { f.en.body[0].validations.required = false; }, f => { f.en.body[0].id = 'bad id'; },
    f => { f.en.body[0].min_task_items = 1; }, f => { f.en.body[0].validations = null; },
    f => { f.en.body[0].id = f.en.body[1].id; },
    f => { f.en.body.reverse(); }, f => { f.en.body.pop(); }, f => { f.en.body = []; },
    f => { f.en.name = 'x'; }, f => { f.en.name = f['zh-CN'].name; }, f => { f.en.description = ''; },
    f => { f.en.schema = 'gidd.issue-definition/v1'; }, f => { f.en.labels = false; }]) {
    const forms = structuredClone(spec.issueForms); change(forms);
    assert.throws(() => validateIssueForms(forms), /spec_resources_invalid/);
  }
});

test('native form validation preserves metadata, input and display-only markdown', () => {
  const spec = loadSpec('02.issue'), forms = structuredClone(spec.issueForms);
  for (const form of Object.values(forms)) {
    Object.assign(form, { title: '[Task]: ', labels: ['development'], assignees: ['octocat'], projects: ['owner/1'], type: 'Task' });
    form.body[0].type = 'input'; form.body[0].id = 'Goal_1';
    form.body[0].attributes.value = 'Useful default';
    form.body[3].attributes.render = 'shell';
    form.body.unshift({ type: 'markdown', attributes: { value: '## Visible guidance only' } });
  }
  const before = structuredClone(forms);
  assert.deepEqual(validateIssueForms(forms), before);
  assert.deepEqual(forms, before);
});
