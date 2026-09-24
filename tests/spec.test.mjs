import { test } from 'node:test';
import { cpSync, realpathSync, renameSync, rmdirSync, symlinkSync } from 'node:fs';
import { configure } from '../.agents/skills/gidd/scripts.js/shared/config.mjs';
import { parseConfiguration } from '../.agents/skills/gidd/scripts.js/shared/storage.mjs';
import { specCommand, parseSpecArguments, renderSpec } from '../.agents/skills/gidd/scripts.js/commands/spec/index.mjs';
import { discoverModes, listModes, listSpecs, loadSpec, matchesMode, specRoot } from '../.agents/skills/gidd/scripts.js/shared/specs.mjs';
import { authorizationKeys, modeNames } from '../.agents/skills/gidd/scripts.js/shared/spec-modes.mjs';
import { readSpecToml } from '../.agents/skills/gidd/scripts.js/shared/spec-resources.mjs';
import { validateIssueForms } from '../.agents/skills/gidd/scripts.js/shared/spec-data.mjs';
import { stringify } from '../.agents/skills/gidd/scripts.js/vendor/toml.mjs';
import { publishRepositoryEntry, runRepositoryCommand } from './support/repository.mjs';
import { adapter, assert, copySkill, dirname, fixture, join, json, mkdirSync, ok,
  readFileSync, rmSync, snapshot, write } from './support/helpers.mjs';

const mode = 'issue.current-worktree.direct-commit', directory = '00.' + mode, auto = directory + '/00.auto', ask = directory + '/04.ask-commit';
const configText = selector => 'schema_version = 1\n[spec]\ncurrent = "' + selector + '"\n';
const configPath = root => join(root, '.agents/skills/gidd/config.toml');
const check = report => report.checks.find(item => item.id === 'config.spec.current');
const options = (route, args = [], lang = 'zh') => parseSpecArguments(route, [...args, '--lang', lang]);
function resources(f) {
  const root = join(f.root, 'resources/specs');
  cpSync(specRoot, root, { recursive: true });
  cpSync(join(specRoot, '../references'), join(root, '../references'), { recursive: true });
  return { root, preset: join(root, auto + '.toml'), description: join(root, directory, 'description.toml'),
    experience: name => join(root, '../references/workflow', name + '.toml'), load: (selector = auto) => loadSpec(selector, root) };
}
function installation(f, config = configText(ask)) {
  const skill = join(f.root, "installed 中文 & ' spaces"), target = join(f.root, 'target');
  copySkill(skill); mkdirSync(join(target, '.git'), { recursive: true });
  if (config !== null) write(configPath(target), config);
  ok(adapter(f.root, { action: 'bootstrap', repositoryRoot: target, responses: {}, downloads: {}, yes: true }, { env: { PATH: dirname(process.execPath) } }));
  publishRepositoryEntry(target, join(skill, 'scripts.js/gidd.mjs'));
  const invoke = (args, env = {}) => runRepositoryCommand(target, args, { cwd: f.root, env: { PATH: '', GIDD_LANG: 'zh', ...env } });
  return { skill, target, invoke, root: join(skill, 'specs'), diagnose: () => json(invoke(['doctor', '--offline', '--lang', 'en'])) };
}

test('six modes list their own presets, authorizations and incomplete languages', () => {
  const modes = listModes();
  assert.deepEqual(modes.map(item => item.name), modeNames.map((name, index) => '0' + index + '.' + name));
  assert.deepEqual(modes.map(item => item.specs), [16, 1, 1, 1, 1, 0]);
  for (const item of modes) {
    assert.deepEqual(Object.keys(item), ['name', 'description', 'specs']);
    assert.equal(item.description, loadSpec(item.name + '/00.auto').definition['zh-CN'].description);
    assert.ok(item.description && !/[\r\n]/.test(item.description));
    assert.ok(!Object.hasOwn(item, 'title'));
  }
  assert.ok(listModes('en').every(item => item.description === ''));
  const specs = listSpecs(mode);
  assert.equal(specs.find(item => item.name === '04.ask-commit').authorization.commit, 'ask');
  for (const item of specs) {
    assert.deepEqual(Object.keys(item), ['name', 'authorization']);
    assert.deepEqual(Object.keys(item.authorization).sort(), [...authorizationKeys].sort());
    assert.equal(item.authorization.merge, 'not_applicable');
  }
  assert.equal(listSpecs(modeNames[5])[0].error, 'spec_language_unavailable');
});

test('fixed mode IDs resolve the same resources and prompts as full mode names', () => {
  const catalog = discoverModes();
  assert.deepEqual(catalog.map(({ id, name }) => [id, name]), [
    ['00', 'issue.current-worktree.direct-commit'],
    ['01', 'issue.dedicated-worktree.direct-merge'],
    ['02', 'issue.dedicated-worktree.pr-merge'],
    ['03', 'no-issue.current-worktree.direct-commit'],
    ['04', 'no-issue.dedicated-worktree.direct-merge'],
    ['05', 'no-issue.dedicated-worktree.pr-merge'],
  ]);
  for (const { id, name, directory } of catalog) {
    assert.deepEqual(listSpecs(id), listSpecs(name));
    assert.deepEqual(listSpecs(directory), listSpecs(name));
    const short = loadSpec(id + '/00.auto'), full = loadSpec(name + '/00.auto');
    assert.deepEqual(short, full);
    assert.deepEqual(loadSpec(directory + '/00.auto'), full);
    assert.deepEqual(loadSpec(id + '/00'), full);
    assert.deepEqual(loadSpec(name + '/00'), full);
    if (short.available_languages.includes('zh-CN')) assert.equal(renderSpec('target', short, 'zh-CN'), renderSpec('target', full, 'zh-CN'));
  }
});

test('mode IDs come from directory prefixes, not fixed mappings, sort order or TOML fields', () => {
  const f = fixture();
  try {
    const s = resources(f), oldPath = join(s.root, directory), newPath = join(s.root, '27.' + mode);
    assert.ok(oldPath.startsWith(f.root + '\\') && newPath.startsWith(f.root + '\\'));
    renameSync(oldPath, newPath);
    const spec = s.load('27/00');
    assert.equal(spec.selector, '27.' + mode + '/00.auto');
    assert.equal(spec.mode, mode);
    assert.match(renderSpec(f.root, spec, 'zh-CN'), /Refs #NNN/);
    assert.deepEqual(s.load(mode + '/00'), spec);
    assert.ok(listModes('zh-CN', s.root).some(item => item.name === '27.' + mode));
    assert.throws(() => s.load('00/00'), /spec_mode_missing/);
    assert.throws(() => s.load(auto), /spec_mode_missing/);
    const path = join(newPath, 'description.toml'), definition = readSpecToml(path);
    definition.id = '00'; write(path, stringify(definition));
    assert.throws(() => s.load('27/00'), /spec_mode_invalid/);
  } finally { f.dispose(); }
});

test('duplicate mode IDs and names fail discovery even for fully named selections', () => {
  const f = fixture();
  try {
    const s = resources(f), conflicting = '00.' + modeNames[1];
    mkdirSync(join(s.root, conflicting));
    const conflict = error => error.message === 'spec_mode_id_conflict' && error.conflicts[0].id === '00' &&
      error.conflicts[0].directories.includes(directory) && error.conflicts[0].directories.includes(conflicting);
    assert.throws(() => discoverModes(s.root), conflict);
    assert.throws(s.load, conflict);
    for (const [route, args] of [['spec.modes', []], ['spec.list', ['00']], ['spec', [auto]], ['spec.issue', ['00/00']]]) {
      const result = specCommand(f.root, options(route, args), s.root);
      assert.equal(result.exitCode, 2); assert.equal(result.report.error, 'spec_mode_id_conflict');
      assert.equal(result.report.conflicts[0].id, '00');
    }
    rmdirSync(join(s.root, conflicting));
    mkdirSync(join(s.root, '27.' + mode));
    assert.throws(s.load, /spec_mode_name_conflict/);
    rmdirSync(join(s.root, '27.' + mode));
    mkdirSync(join(s.root, '0.' + mode));
    assert.throws(s.load, /spec_mode_directory_invalid/);
  } finally { f.dispose(); }
});

test('preset numbers match exact filename prefixes and never choose among ambiguous or unavailable presets', () => {
  const f = fixture();
  try {
    const s = resources(f);
    assert.equal(s.load('00/04').selector, ask);
    assert.throws(() => s.load('00/99'), /spec_number_missing/);
    write(join(s.root, directory, '00.draft.toml'), '');
    assert.throws(() => s.load('00/00'), /spec_number_ambiguous/);
    assert.equal(s.load(auto).selector, auto);
    const report = specCommand(f.root, options('spec.issue', ['00/00']), s.root).report;
    assert.equal(report.error, 'spec_number_ambiguous');
    assert.match(report.hint, /完整规范名/);
    write(join(s.root, directory, '99.draft.toml'), '');
    assert.throws(() => s.load('00/99'), /spec_resources_invalid/);
    assert.equal(listSpecs('00', s.root).find(item => item.name === '00.auto').error, undefined);
  } finally { f.dispose(); }
});

test('mode flows distinguish local merge before push from PR merge after push', () => {
  for (const name of modeNames) {
    const spec = loadSpec(name + '/00.auto'), flow = spec.definition.flow;
    assert.ok(flow.indexOf('internal_acceptance') < flow.indexOf('add'));
    assert.ok(flow.indexOf('commit') < flow.indexOf('push'));
    assert.equal(flow.includes('close_issue'), name.startsWith('issue.'));
    assert.ok(!flow.includes('push_error') && !flow.includes('merge_error'));
    assert.equal(flow.at(-1), 'cleanup_sync');
    if (name.endsWith('.direct-commit')) {
      assert.ok(!flow.includes('merge') && !flow.includes('pr'));
      assert.deepEqual(spec.definition.errors, ['push_error']);
    } else {
      assert.deepEqual(spec.definition.errors, ['push_error', 'merge_error']);
      if (name.endsWith('.pr-merge')) assert.ok(flow.indexOf('push') < flow.indexOf('pr') && flow.indexOf('pr') < flow.indexOf('merge'));
      else assert.ok(flow.indexOf('merge') < flow.indexOf('push') && !flow.includes('pr'));
    }
  }
  const issue = renderSpec('target', loadSpec(ask), 'zh-CN');
  assert.match(issue, /\| commit \| ask \|/);
  assert.match(issue, /\| add \| auto \|/);
  assert.match(issue, /Refs #NNN/);
  assert.ok(issue.includes('gidd.link spec.issue ' + ask + ' --lang zh'));
  const task = renderSpec('target', loadSpec(modeNames[3] + '/00.auto'), 'zh-CN');
  assert.ok(!task.includes('Refs #NNN') && !task.includes('gidd.link spec.issue'));
  assert.ok(!task.includes('### merge') && !task.includes('### close-issue'));
});

test('routes require a mode or complete selector and reject old or unsafe syntax', () => {
  for (const [route, args, action, current, selector] of [
    ['spec.modes', [], 'modes', false, undefined], ['spec.list', [mode], 'list', false, mode],
    ['spec.list', ['00'], 'list', false, '00'], ['spec', ['00/00.auto'], 'show', false, '00/00.auto'],
    ['spec', ['00/00'], 'show', false, '00/00'], ['spec.issue', ['00/04'], 'issue', false, '00/04'],
    ['spec.list', ['27'], 'list', false, '27'], ['spec', ['27/00'], 'show', false, '27/00'],
    ['spec.list', [directory], 'list', false, directory],
    ['spec.issue', ['03/00.auto'], 'issue', false, '03/00.auto'],
    ['spec', [auto], 'show', false, auto], ['spec.issue', [auto], 'issue', false, auto],
    ['spec.current', [], 'show', true, undefined], ['spec.issue.current', [], 'issue', true, undefined],
  ]) assert.deepEqual(options(route, args), { action, current, selector, lang: 'zh-CN' });
  for (const route of ['spec.current.issue', 'spec.all.ask', 'spec.specs']) assert.throws(() => options(route), /invalid_spec_route/);
  for (const [route, args] of [['spec', []], ['spec.issue', []], ['spec.list', []], ['spec.list', [auto]],
    ['spec.modes', [mode]], ['spec.current', [auto]], ['spec.issue.current', [auto]],
    ...['1', '001', '-1', '../01'].flatMap(id => [['spec.list', [id]], ['spec', [id + '/00.auto']]]),
    ...['02.issue', mode, mode + '/description', mode + '/00.auto.toml', mode + '/../00.auto', mode + '\\00.auto',
      mode + '/a/b', mode + '/_helper', mode + '/a..b', '00/0', '00/000', '00/00.', '00/-1'].map(value => ['spec', [value]]),
    ['spec', [auto, '--lang', 'en']], ['spec', [auto, '--json']]]) assert.throws(() => options(route, args), /invalid_arguments/);
  assert.throws(() => options('spec.current', [], 'fr'), /unsupported_help_language/);
});

test('schemas enforce applicability and presets require explicit authorization for every stage', () => {
  const f = fixture();
  try {
    const s = resources(f), original = readSpecToml(s.preset), definition = readSpecToml(s.description);
    for (const change of [data => { delete data.authorization.commit; }, data => { data.authorization.unknown = 'auto'; },
      data => { data.authorization.commit = 'auto|ask'; }, data => { data.authorization.add = true; },
      data => { data.authorization.commit = 'not_applicable'; }, data => { data.authorization.merge = 'auto'; },
      data => { data.description = {}; }]) {
      const data = structuredClone(original); change(data); write(s.preset, stringify(data));
      assert.throws(s.load, /spec_authorization_invalid/);
    }
    write(s.preset, stringify(original));
    for (const value of [[], ['auto', 'auto'], ['skip'], ['not_applicable'], 'auto|ask']) {
      const data = structuredClone(definition); data.authorization_schema.commit = value;
      write(s.description, stringify(data)); assert.throws(s.load, /spec_schema_invalid/);
    }
    const invalid = structuredClone(definition); invalid.authorization_schema.merge = ['auto', 'ask'];
    write(s.description, stringify(invalid)); assert.throws(s.load, /spec_schema_invalid/);
    definition.authorization_schema.commit = ['ask']; write(s.description, stringify(definition));
    assert.throws(s.load, /spec_authorization_invalid/);
    original.authorization.commit = 'ask'; write(s.preset, stringify(original));
    assert.equal(s.load().authorization.commit, 'ask');
    // Authorization comes from the file, not the conventional preset name.
    assert.equal(listSpecs(mode, s.root)[0].authorization.commit, 'ask');
  } finally { f.dispose(); }
});

test('TOML supports quoted patterns and multiline prose without include or command expansion', () => {
  const f = fixture();
  try {
    const s = resources(f), path = s.experience('06.commit');
    write(path, '[zh-CN."issue.*"]\ntitle = "commit"\nbody = \'\'\'\n第一行\n@include ../../outside@\n@gidd.link spec.issue.current@\n\'\'\'\n[en."issue.*"]\ntitle = ""\nbody = ""\n');
    const before = snapshot(f.root), text = renderSpec(f.root, s.load(), 'zh-CN');
    assert.match(text, /第一行\n@include ..\/..\/outside@\n@gidd.link spec.issue.current@/);
    assert.deepEqual(snapshot(f.root), before);
    for (const invalid of ['x = 1\nx = 2', '[broken', '[a]\nx = 1\n[a]\nx = 2', 'body = "secret invalid', 'body = bare']) {
      write(path, invalid);
      assert.throws(s.load, error => error.message === 'spec_toml_invalid' && error.path === path && !error.message.includes('secret'));
    }
    for (const invalid of [Buffer.from([0xff, 0xfe]), '\0', ' ', 'x'.repeat(65537)]) {
      write(path, invalid); assert.throws(s.load, /spec_resources_invalid/);
    }
  } finally { f.dispose(); }
});

test('pattern matching is anchored, only star is special, and ambiguity is rejected', () => {
  assert.ok(matchesMode('issue.*', mode)); assert.ok(!matchesMode('issue.*', 'no-' + mode));
  assert.ok(matchesMode('*.pr-merge', modeNames[2])); assert.ok(!matchesMode('issue.*', 'issueXcurrent'));
  const f = fixture();
  try {
    const s = resources(f), path = s.experience('06.commit'), original = readSpecToml(path);
    const attempt = (change, reason) => { const data = structuredClone(original); change(data); write(path, stringify(data)); assert.throws(s.load, new RegExp(reason)); };
    attempt(data => { for (const lang of ['en', 'zh-CN']) data[lang]['*'] = data[lang]['issue.*']; }, 'spec_pattern_ambiguous');
    attempt(data => { for (const lang of ['en', 'zh-CN']) delete data[lang]['issue.*']; }, 'spec_pattern_missing');
    attempt(data => { delete data.en['no-issue.*']; }, 'spec_pattern_mismatch');
    attempt(data => { data.en['never.*'] = data.en['issue.*']; }, 'spec_pattern_invalid');
    attempt(data => { data.en['issue.?'] = data.en['issue.*']; }, 'spec_pattern_invalid');
    write(path, stringify(original)); assert.deepEqual(s.load().available_languages, ['zh-CN']);
  } finally { f.dispose(); }
});

test('unrelated drafts and inapplicable modules cannot block a selected spec', () => {
  const f = fixture();
  try {
    const s = resources(f);
    write(join(s.root, directory, '99.draft.toml'), '');
    write(join(s.root, directory, '_notes.toml'), 'not toml');
    write(join(s.root, '02.' + modeNames[2], 'description.toml'), 'not toml');
    rmSync(s.experience('10.merge'));
    assert.deepEqual(s.load().available_languages, ['zh-CN']);
    const list = listSpecs(mode, s.root);
    assert.equal(list.length, 17); assert.equal(list.find(item => item.name === '99.draft').error, 'spec_resources_invalid');
    assert.equal(listModes('zh-CN', s.root)[0].specs, 16);
    assert.equal(listModes('zh-CN', s.root)[2].error, 'spec_toml_invalid');
    assert.deepEqual(Object.keys(listModes('zh-CN', s.root)[2]), ['name', 'specs', 'error']);
    assert.equal(listModes('zh-CN', s.root)[2].name, '02.' + modeNames[2]);
    assert.equal(listModes('zh-CN', s.root)[3].name, '03.' + modeNames[3]);
    rmSync(s.experience('06.commit')); assert.throws(s.load, /spec_resources_missing/);
  } finally { f.dispose(); }
});

test('language completeness is checked before any prompt is emitted; Issue templates remain independently usable', () => {
  const f = fixture();
  try {
    const s = resources(f);
    const result = specCommand(f.root, options('spec', [auto], 'en'), s.root);
    assert.equal(result.exitCode, 2); assert.equal(result.markdown, undefined);
    assert.equal(result.report.error, 'spec_language_unavailable'); assert.equal(result.report.path, s.description);
    const description = readSpecToml(s.description);
    description.en = { title: 'Example', body: 'Mode text' };
    write(s.description, stringify(description));
    assert.throws(s.load, /spec_translation_invalid/);
    description.en = { description: 'Mode text' };
    write(s.description, stringify(description));
    assert.equal(specCommand(f.root, options('spec', [auto], 'en'), s.root).report.path, s.experience('00.common'));
    for (const item of s.load().experiences) {
      const data = readSpecToml(item.path);
      for (const value of Object.values(data.en)) Object.assign(value, { title: 'Example', body: 'English reference' });
      write(item.path, stringify(data));
    }
    const prompt = specCommand(f.root, options('spec', [auto], 'en'), s.root).markdown;
    assert.match(prompt, /English reference/);
    assert.ok(prompt.includes('# ' + auto + '\n\nMode text\n\n## Flow and authorization'));
    for (const lang of ['zh', 'en']) assert.equal(specCommand(f.root, options('spec.issue', [auto], lang), s.root).exitCode, 0);
    const noIssue = specCommand(f.root, options('spec.issue', [modeNames[3] + '/00.auto']), s.root);
    assert.equal(noIssue.report.error, 'spec_issue_template_missing');
    const unfinished = specCommand(f.root, options('spec', [modeNames[5] + '/00.auto']), s.root);
    assert.equal(unfinished.report.path, s.experience('10.merge'));
  } finally { f.dispose(); }
});

test('relative templates are confined to installed references, including junctions', () => {
  const f = fixture();
  try {
    const s = resources(f), definition = readSpecToml(s.description), original = definition.issue_template.en;
    for (const ref of ['https://example.test/a.json', 'C:/outside.json', '../../../outside.json', '../00.auto.toml', '../../specs/private.json', '/root.json']) {
      definition.issue_template.en = ref; write(s.description, stringify(definition));
      assert.throws(s.load, /spec_resource_path_invalid/);
    }
    const outside = join(f.root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(s.root, '../references/linked'), 'junction');
    definition.issue_template.en = '../../references/linked/issue.json'; write(s.description, stringify(definition));
    assert.throws(s.load, /spec_resource_path_invalid/);
    definition.issue_template.en = original; write(s.description, stringify(definition));
    assert.ok(s.load().issueForms.en.body.length);
    const selected = join(s.root, directory); assert.ok(selected.startsWith(f.root + '\\')); rmSync(selected, { recursive: true });
    symlinkSync(join(specRoot, directory), selected, 'junction');
    assert.throws(s.load, /spec_resource_path_invalid/);
  } finally { f.dispose(); }
});

test('selection preserves config comments and newline style, and rejects invalid selectors without mutation', () => {
  const f = fixture();
  try {
    const path = configPath(f.root);
    for (const newline of ['\n', '\r\n']) {
      const original = '\uFEFF# preserved' + newline + configText(auto).replaceAll('\n', newline);
      write(path, original); configure(f.root, 'set', 'spec.current', ask);
      assert.equal(readFileSync(path, 'utf8'), original.replace(auto, ask));
      assert.equal(parseConfiguration(readFileSync(path, 'utf8')).spec.current, ask);
    }
    const before = snapshot(f.root);
    for (const selector of ['02.issue', '00.all.auto', '07/00.auto', '1/00.auto', mode + '/description', mode + '/missing', modeNames[5] + '/00.auto', '05/00.auto', '05/00', '00/99']) {
      assert.throws(() => configure(f.root, 'set', 'spec.current', selector), /spec_/);
      assert.deepEqual(snapshot(f.root), before);
    }
  } finally { f.dispose(); }
});

test('repository commands support discovery, selection, current prompts and template binding offline', () => {
  const f = fixture();
  try {
    const s = installation(f, null), before = snapshot(f.root);
    assert.deepEqual(json(ok(s.invoke(['spec.modes']))).modes.map(item => item.name), modeNames.map((name, index) => '0' + index + '.' + name));
    assert.equal(json(ok(s.invoke(['spec.list', mode]))).specs.length, 16);
    assert.deepEqual(json(ok(s.invoke(['spec.list', '00']))).specs, json(ok(s.invoke(['spec.list', mode]))).specs);
    assert.equal(json(s.invoke(['spec.current'])).error, 'spec_current_missing');
    assert.ok(ok(s.invoke(['spec', auto])).stdout.includes('gidd.link spec.issue ' + auto + ' --lang zh'));
    assert.ok(json(ok(s.invoke(['spec.issue', auto, '--lang', 'en']))).form.body.length);
    assert.deepEqual(snapshot(f.root), before);
    ok(s.invoke(['set', 'spec.current', '00/04']));
    assert.equal(parseConfiguration(readFileSync(configPath(s.target), 'utf8')).spec.current, '00/04');
    const selected = snapshot(f.root), current = ok(s.invoke(['spec.current'])).stdout;
    assert.equal(current, ok(s.invoke(['spec', ask])).stdout);
    assert.equal(current, ok(s.invoke(['spec', '00/04.ask-commit'])).stdout);
    assert.equal(current, ok(s.invoke(['spec', '00/04'])).stdout);
    const source = current.match(/^提示来源: `([^`\r\n]+)`/m)[1], scope = current.match(/^适用范围: `([^`\r\n]+)`/m)[1];
    assert.equal(realpathSync.native(source), realpathSync.native(join(s.root, ask + '.toml')));
    assert.equal(realpathSync.native(scope), realpathSync.native(s.target));
    assert.ok(ok(s.invoke(['spec', auto])).stdout.includes('gidd.link spec.issue ' + auto + ' --lang zh'));
    assert.deepEqual(json(ok(s.invoke(['spec.issue.current']))), json(ok(s.invoke(['spec.issue', '00/04']))));
    assert.deepEqual(json(ok(s.invoke(['spec.issue.current']))).form, json(ok(s.invoke(['spec.issue', ask]))).form);
    assert.equal(json(s.invoke(['spec.current', '--lang', 'en'])).error, 'spec_language_unavailable');
    assert.equal(json(s.invoke(['spec.list'])).error, 'invalid_arguments');
    assert.equal(json(s.invoke(['spec.current.issue'])).error, 'invalid_spec_route');
    assert.equal(json(s.invoke(['spec.issue', modeNames[3] + '/00.auto'])).error, 'spec_issue_template_missing');
    assert.deepEqual(snapshot(f.root), selected);
  } finally { f.dispose(); }
});

test('doctor validates only the selected dependencies, supports partial translations, and guides old selections', () => {
  const f = fixture();
  try {
    const s = installation(f, configText('00/04'));
    assert.equal(check(s.diagnose()).status, 'ready');
    assert.equal(check(s.diagnose()).details.resolved, ask);
    assert.deepEqual(check(s.diagnose()).details.available_languages, ['zh-CN']);
    write(join(s.root, directory, '99.draft.toml'), '');
    assert.equal(check(s.diagnose()).status, 'ready');
    const path = join(s.root, ask + '.toml'), saved = readFileSync(path, 'utf8');
    write(path, saved.replace('commit              = "ask"', 'commit              = "invalid"'));
    const invalid = check(s.diagnose());
    assert.equal(invalid.reason, 'spec_authorization_invalid'); assert.equal(invalid.details.field, 'commit');
    write(path, saved);
    write(configPath(s.target), configText('02.issue'));
    const before = snapshot(f.root), old = check(s.diagnose());
    assert.equal(old.reason, 'spec_current_unsupported');
    assert.deepEqual(old.commands.map(command => command.args), [['spec.modes'], ['spec.list', '<mode-id>'], ['spec', '<mode-id>/<name>'], ['set', 'spec.current', '<mode-id>/<name>']]);
    assert.deepEqual(snapshot(f.root), before);
    write(configPath(s.target), 'schema_version = 1\n');
    assert.equal(check(s.diagnose()).reason, 'spec_current_missing');
    write(configPath(s.target), configText(modeNames[5] + '/00.auto'));
    assert.equal(check(s.diagnose()).reason, 'spec_language_unavailable');
    mkdirSync(join(s.root, '00.' + modeNames[1]));
    const collisionSnapshot = snapshot(f.root), collision = check(s.diagnose());
    assert.equal(collision.reason, 'spec_mode_id_conflict');
    assert.equal(collision.details.conflicts[0].id, '00');
    assert.ok(collision.hint.includes('directory'));
    assert.equal(json(s.invoke(['spec.modes'])).error, 'spec_mode_id_conflict');
    assert.equal(json(s.invoke(['set', 'spec.current', '00/04'])).reason, 'spec_mode_id_conflict');
    assert.deepEqual(snapshot(f.root), collisionSnapshot);
    write(configPath(s.target), 'schema_version = 1\n');
    assert.equal(check(s.diagnose()).reason, 'spec_mode_id_conflict');
    const catalog = join(s.skill, 'references/doctor.toml');
    write(catalog, readFileSync(catalog, 'utf8').replace('[checks."config.spec.current"]\nenabled = true', '[checks."config.spec.current"]\nenabled = false'));
    const disabled = check(s.diagnose()); assert.equal(disabled.reason, 'disabled');
  } finally { f.dispose(); }
});

test('forms reject invalid native fields, translation drift and misplaced GIDD checks', () => {
  const spec = loadSpec(auto);
  for (const change of [f => { delete f.en; }, f => { f.fr = f.en; },
    f => { f.en.body[0].attributes.label = ''; }, f => { f.en.body[0].attributes.label = 'Goal\nInjected'; },
    f => { f.en.body[0].attributes.placeholders = ['typo']; }, f => { f.en.body[0].attributes.value = false; },
    f => { f.en.body[0].type = 'unknown'; }, f => { f.en.body[0].type = 'input'; },
    f => { f.en.body[0].validations.required = false; }, f => { f.en.body[0].id = 'bad id'; },
    f => { f.en.body[0].min_task_items = 1; }, f => { f.en.body[0].validations = null; },
    f => { f.en.body[0].id = f.en.body[1].id; }, f => { f.en.body.reverse(); },
    f => { f.en.body.pop(); }, f => { f.en.body = []; }, f => { f.en.name = 'x'; },
    f => { f.en.name = f['zh-CN'].name; }, f => { f.en.description = ''; },
    f => { f.en.schema = 'gidd.issue-definition/v1'; }, f => { f.en.labels = false; }]) {
    const forms = structuredClone(spec.issueForms); change(forms);
    assert.throws(() => validateIssueForms(forms), /spec_resources_invalid/);
  }
});

test('native form validation preserves metadata, input and display-only markdown', () => {
  const forms = structuredClone(loadSpec(auto).issueForms);
  for (const form of Object.values(forms)) {
    Object.assign(form, { title: '[Task]: ', labels: ['development'], assignees: ['octocat'], projects: ['owner/1'], type: 'Task' });
    form.body[0].type = 'input'; form.body[0].id = 'Goal_1';
    form.body[0].attributes.value = 'Useful default'; form.body[3].attributes.render = 'shell';
    form.body.unshift({ type: 'markdown', attributes: { value: '## Visible guidance only' } });
  }
  const before = structuredClone(forms);
  assert.deepEqual(validateIssueForms(forms), before); assert.deepEqual(forms, before);
});
