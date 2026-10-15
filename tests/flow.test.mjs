import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cpSync, realpathSync, renameSync, rmdirSync, symlinkSync } from 'node:fs';
import { readFlowHistory, flowStorage, recordFlowUse } from '../.agents/skills/gidd/scripts.js/shared/flow-history.mjs';
import { run as inspectFlowHistory } from '../.agents/skills/gidd/scripts.js/commands/doctor/checks/folder.gidd.flow.mjs';
import { newTask } from '../.agents/skills/gidd/scripts.js/shared/task-records.mjs';
import { parseIssueTaskArguments } from '../.agents/skills/gidd/scripts.js/commands/issue-task/index.mjs';
import { issueTaskFlowCommand } from '../.agents/skills/gidd/scripts.js/commands/issue-task/flow.mjs';
import { flowCommand, parseFlowArguments, renderFlow } from '../.agents/skills/gidd/scripts.js/commands/flow/index.mjs';
import { discoverDeliveryModes, listDeliveryModes, listAuthorizationPresets, loadFlow, matchesDeliveryMode, flowRoot } from '../.agents/skills/gidd/scripts.js/shared/flows.mjs';
import { authorizationKeys, deliveryModeNames, flowSnapshot } from '../.agents/skills/gidd/scripts.js/shared/flow-definition.mjs';
import { readFlowToml } from '../.agents/skills/gidd/scripts.js/shared/flow-resources.mjs';
import { validateIssueForms } from '../.agents/skills/gidd/scripts.js/shared/flow-data.mjs';
import { stringify } from '../.agents/skills/gidd/scripts.js/vendor/toml.mjs';
import { runRepositoryCommand } from './support/repository.mjs';
import { adapter, assert, copySkill, dirname, fixture, join, json, mkdirSync, ok, bindFixture, findGit, run,
  readFileSync, rmSync, snapshot, write, initializeDataFixture } from './support/helpers.mjs';

const mode = 'direct-commit', directory = '00.' + mode, auto = directory + '/00.auto', ask = directory + '/04.ask-commit';
const historyHeading = '工作流程记录（最新在前，最多200条）：\n';
const configPath = () => join(process.env.USERPROFILE, '.agents/skills.tools/gidd/config.toml');
const options = (route, args = [], lang = 'zh') => /^[0-9]+\.flow$/.test(route)
  ? parseIssueTaskArguments(route, [...args, '--lang', lang]) : parseFlowArguments(route, [...args, '--lang', lang]);
function resources(f) {
  const root = join(f.root, 'resources/flows');
  cpSync(flowRoot, root, { recursive: true });
  cpSync(join(flowRoot, '../references'), join(root, '../references'), { recursive: true });
  return { root, preset: join(root, auto + '.toml'), description: join(root, directory, 'description.toml'),
    stepReference: name => join(root, '../references/steps', name + '.toml'), load: (selector = auto) => loadFlow(selector, root) };
}
function installation(f, config = 'schema_version = 1\n') {
  const skill = join(f.root, "installed 中文 & ' spaces"), target = join(f.root, 'target');
  copySkill(skill); mkdirSync(target, { recursive: true });
  const git = findGit(); ok(run(git, ['init', '--quiet', target]));
  initializeDataFixture(target);
  if (config !== null) write(configPath(target), 'schema_version = 1\n');
  ok(adapter(f.root, { action: 'bootstrap', repositoryRoot: target, responses: {}, downloads: {}, yes: true }, { env: { PATH: dirname(process.execPath) } }));
  bindFixture(f.root, { git });
  const invoke = (args, env = {}) => runRepositoryCommand(target, args, { cwd: target, entry: join(skill, 'gidd.cmd'), env: { PATH: '', ...env } });
  return { skill, target, git, invoke, root: join(skill, 'flows'), diagnose: () => json(invoke(['doctor', '--offline', '--lang', 'en'])) };
}

test('three Issue modes list their own presets, authorizations and incomplete languages', () => {
  const modes = listDeliveryModes();
  assert.deepEqual(modes.map(item => item.name), deliveryModeNames.map((name, index) => '0' + index + '.' + name));
  assert.deepEqual(modes.map(item => item.presets), [16, 1, 1]);
  for (const item of modes) {
    assert.deepEqual(Object.keys(item), ['name', 'description', 'presets']);
    assert.equal(item.description, loadFlow(item.name + '/00.auto').definition['zh-CN'].description);
    assert.ok(item.description && !/[\r\n]/.test(item.description));
    assert.ok(!Object.hasOwn(item, 'title'));
  }
  assert.ok(listDeliveryModes('en').every(item => item.description === ''));
  const presets = listAuthorizationPresets(mode);
  assert.equal(presets.find(item => item.name === '04.ask-commit').authorization.commit, 'ask');
  for (const item of presets) {
    if (item.details?.code) {
      assert.deepEqual(Object.keys(item), ['name', 'details']);
      assert.equal(typeof item.details?.code, 'string');
      continue;
    }
    assert.deepEqual(Object.keys(item), ['name', 'authorization']);
    assert.deepEqual(Object.keys(item.authorization).sort(), [...authorizationKeys].sort());
    for (const key of ['direct_merge', 'direct_merge_error', 'pr_merge', 'pr_merge_error', 'target_sync', 'target_sync_error']) {
      assert.equal(item.authorization[key], 'not_applicable');
    }
  }
  assert.equal(listAuthorizationPresets(deliveryModeNames[2])[0].details?.code, undefined);
  assert.deepEqual(loadFlow(deliveryModeNames[2] + '/00.auto').available_languages, ['zh-CN']);
});

test('fixed mode IDs resolve the same resources and prompts as full mode names', () => {
  const catalog = discoverDeliveryModes();
  assert.deepEqual(catalog.map(({ id, name }) => [id, name]), [
    ['00', 'direct-commit'],
    ['01', 'direct-merge'],
    ['02', 'pr-merge'],
  ]);
  for (const { id, name, directory } of catalog) {
    assert.deepEqual(listAuthorizationPresets(id), listAuthorizationPresets(name));
    assert.deepEqual(listAuthorizationPresets(directory), listAuthorizationPresets(name));
    const short = loadFlow(id + '/00.auto'), full = loadFlow(name + '/00.auto');
    assert.deepEqual(short, full);
    assert.deepEqual(loadFlow(directory + '/00.auto'), full);
    assert.deepEqual(loadFlow(id + '/00'), full);
    assert.deepEqual(loadFlow(name + '/00'), full);
    if (short.available_languages.includes('zh-CN')) assert.equal(renderFlow('target', short, 'zh-CN'), renderFlow('target', full, 'zh-CN'));
  }
});

test('mode IDs come from directory prefixes, not fixed mappings, sort order or TOML fields', () => {
  const f = fixture();
  try {
    const s = resources(f), oldPath = join(s.root, directory), newPath = join(s.root, '27.' + mode);
    assert.ok(oldPath.startsWith(f.root + '\\') && newPath.startsWith(f.root + '\\'));
    renameSync(oldPath, newPath);
    const flow = s.load('27/00');
    assert.equal(flow.selector, '27.' + mode + '/00.auto');
    assert.equal(flow.mode, mode);
    assert.match(renderFlow(f.root, flow, 'zh-CN'), /Refs #NNN/);
    assert.deepEqual(s.load(mode + '/00'), flow);
    assert.ok(listDeliveryModes('zh-CN', s.root).some(item => item.name === '27.' + mode));
    assert.throws(() => s.load('00/00'), /flow_mode_missing/);
    assert.throws(() => s.load(auto), /flow_mode_missing/);
    const path = join(newPath, 'description.toml'), definition = readFlowToml(path);
    definition.id = '00'; write(path, stringify(definition));
    assert.throws(() => s.load('27/00'), /flow_mode_invalid/);
  } finally { f.dispose(); }
});

test('duplicate mode IDs and names fail discovery even for fully named selections', () => {
  const f = fixture();
  try {
    const s = resources(f), conflicting = '00.' + deliveryModeNames[1];
    mkdirSync(join(s.root, conflicting));
    const conflict = error => error.message === 'flow_mode_id_conflict' && error.conflicts[0].id === '00' &&
      error.conflicts[0].directories.includes(directory) && error.conflicts[0].directories.includes(conflicting);
    assert.throws(() => discoverDeliveryModes(s.root), conflict);
    assert.throws(s.load, conflict);
    for (const [route, args] of [['flow.deliveries', []], ['flow.list', ['00']], ['flow', [auto]], ['flow.issue', ['00/00']]]) {
      const result = flowCommand(f.root, options(route, args), s.root);
      assert.equal(result.exitCode, 2); assert.equal(result.report.details?.code, 'flow_mode_id_conflict');
      assert.equal(result.report.details.conflicts[0].id, '00');
    }
    rmdirSync(join(s.root, conflicting));
    mkdirSync(join(s.root, '27.' + mode));
    assert.throws(s.load, /flow_mode_name_conflict/);
    rmdirSync(join(s.root, '27.' + mode));
    mkdirSync(join(s.root, '0.' + mode));
    assert.throws(s.load, /flow_mode_directory_invalid/);
  } finally { f.dispose(); }
});

test('preset numbers match exact filename prefixes and never choose among ambiguous or unavailable presets', () => {
  const f = fixture();
  try {
    const s = resources(f);
    assert.equal(s.load('00/04').selector, ask);
    assert.throws(() => s.load('00/99'), /flow_number_missing/);
    write(join(s.root, directory, '00.draft.toml'), '');
    assert.throws(() => s.load('00/00'), /flow_number_ambiguous/);
    assert.equal(s.load(auto).selector, auto);
    const report = flowCommand(f.root, options('flow.issue', ['00/00']), s.root).report;
    assert.equal(report.details?.code, 'flow_number_ambiguous');
    assert.match(report.hint, /完整授权方案名/);
    write(join(s.root, directory, '99.draft.toml'), '');
    assert.throws(() => s.load('00/99'), /flow_resources_invalid/);
    assert.equal(listAuthorizationPresets('00', s.root).find(item => item.name === '00.auto').details?.code, undefined);
  } finally { f.dispose(); }
});

test('mode flows distinguish local merge before push from PR merge after push', () => {
  for (const name of deliveryModeNames) {
    const flow = loadFlow(name + '/00.auto'), steps = flow.definition.steps;
    assert.ok(steps.indexOf('internal_acceptance') < steps.indexOf('add'));
    assert.ok(steps.indexOf('commit') < steps.indexOf('push'));
    assert.ok(steps.includes('close_issue'));
    assert.ok(!steps.some(step => step.endsWith('_error')));
    assert.equal(steps.at(-1), 'cleanup');
    assert.equal(steps.includes('target_sync'), name === 'pr-merge');
    if (name === 'direct-commit') {
      assert.ok(!steps.includes('direct_merge') && !steps.includes('pr_merge') && !steps.includes('pr_create'));
      assert.deepEqual(flow.definition.errors, ['push_error']);
    } else if (name === 'pr-merge') {
      assert.deepEqual(flow.definition.errors, ['push_error', 'pr_merge_error', 'target_sync_error']);
      assert.ok(steps.indexOf('push') < steps.indexOf('pr_create') && steps.indexOf('pr_create') < steps.indexOf('pr_merge'));
      assert.deepEqual(steps.slice(steps.indexOf('pr_merge')), ['pr_merge', 'target_sync', 'close_issue', 'cleanup']);
      assert.ok(!steps.includes('direct_merge'));
    } else {
      assert.deepEqual(flow.definition.errors, ['direct_merge_error', 'push_error']);
      assert.ok(steps.indexOf('commit') < steps.indexOf('direct_merge') && steps.indexOf('direct_merge') < steps.indexOf('push'));
      assert.ok(!steps.includes('pr_create') && !steps.includes('pr_merge'));
    }
  }
  const issue = renderFlow('target', loadFlow(ask), 'zh-CN');
  assert.match(issue, /\| commit \| ask \|/);
  assert.match(issue, /\| add \| auto \|/);
  assert.match(issue, /Refs #NNN/);
  assert.ok(issue.includes('gidd flow.issue ' + ask + ' --lang zh'));

});

test('rendered error guidance follows its triggering stage and cleanup remains last in both languages', () => {
  for (const mode of deliveryModeNames) {
    const flow = loadFlow(mode + '/00.auto');
    for (const error of flow.definition.errors) flow.authorization[error] = 'ask';
    const delivery = mode === 'direct-commit' ? ['push', 'push_error'] : mode === 'direct-merge'
      ? ['direct_merge', 'direct_merge_error', 'push', 'push_error'] : ['push', 'push_error', 'pr_create', 'pr_merge', 'pr_merge_error'];
    const expected = ['task_definition', 'workspace', 'development', 'internal_acceptance', 'add', 'commit',
      ...delivery, ...(mode === 'pr-merge' ? ['target_sync', 'target_sync_error'] : []),
      'close_issue', 'cleanup'];
    for (const lang of ['zh-CN', 'en']) {
      // Fill only this in-memory fixture; shipped translations remain unfinished.
      flow.definition[lang].description = 'Example mode';
      flow.stepReferences = ['common', ...flow.definition.steps, ...flow.definition.errors]
        .map(step => ({ step, [lang]: { title: step, body: step + ' reference' } }));
      const prompt = renderFlow('target', flow, lang);
      assert.deepEqual([...prompt.matchAll(/^#{3,4} (.+)$/gm)].map(match => match[1]), expected);
      assert.ok(prompt.endsWith('### cleanup\n\ncleanup reference\n'));
      assert.ok(!/## (受阻时的参考经验|Reference guidance when blocked)/.test(prompt));
      for (const error of flow.definition.errors) {
        const trigger = error.slice(0, -'_error'.length);
        const condition = lang === 'zh-CN' ? `仅在 ${trigger} 受阻时适用，授权为 ask。`
          : `Applies only when ${trigger} is blocked; authorization: ask.`;
        assert.ok(prompt.includes(`#### ${trigger}_error\n\n${condition}\n`));
      }
    }
  }
});

test('routes require an explicit selector or Issue number and reject old commands', () => {
  for (const [route, args, action, selector] of [
    ['flow.deliveries', [], 'deliveries', undefined], ['flow.list', [mode], 'list', mode],
    ['flow.list', ['00'], 'list', '00'], ['flow', ['00/00.auto'], 'show', '00/00.auto'],
    ['flow', ['00/00'], 'show', '00/00'], ['flow.issue', ['00/04'], 'issue', '00/04'],
    ['flow.list', ['27'], 'list', '27'], ['flow', ['27/00'], 'show', '27/00'],
    ['flow.list', [directory], 'list', directory], ['flow.issue', ['03/00.auto'], 'issue', '03/00.auto'],
    ['flow', [auto], 'show', auto], ['flow.issue', [auto], 'issue', auto], ['flow.history', [], 'history', undefined],
  ]) assert.deepEqual(options(route, args), { action, selector, lang: 'zh-CN' });
  assert.deepEqual(options('14.flow'), { action: 'flow', issue: 14, lang: 'zh-CN' });
  assert.equal(options('flow.history', ['-v']).verbose, true);
  for (const route of ['flow.current', 'flow.issue.current', 'flow.current.issue', 'flow.all.ask', 'flow.flows', '14.flow',
    'spec', 'spec.modes', 'spec.list', 'spec.issue', 'spec.history', 'flow.modes'])
    assert.throws(() => parseFlowArguments(route, []), /invalid_flow_route/);
  for (const [route, args] of [['14.spec', []], ['14.spec.set', ['00/00']], ['14', ['--spec', '00/00']]])
    assert.throws(() => parseIssueTaskArguments(route, args), /invalid_arguments/);
  for (const [route, args] of [
    ['0.flow', []], ['01.flow', []], ['flow', []], ['flow.issue', []], ['flow.list', []], ['flow.deliveries', [mode]],
    ['flow.history', ['-v', '-v']], ['flow', [auto, '-v']], ['14.flow', ['-v']],
    ['14.flow', [auto]], ['14.flow', ['--issue', '7']], ['9007199254740992.flow', []],
  ]) assert.throws(() => options(route, args), /invalid_arguments/);
  assert.throws(() => options('14.flow', [], 'fr'), /unsupported_help_language/);
});
test('schemas enforce applicability and presets require explicit authorization for every stage', () => {
  const f = fixture();
  try {
    const s = resources(f), original = readFlowToml(s.preset), definition = readFlowToml(s.description);
    for (const change of [data => { delete data.authorization.commit; }, data => { data.authorization.unknown = 'auto'; },
      data => { data.authorization.commit = 'auto|ask'; }, data => { data.authorization.add = true; },
      data => { data.authorization.commit = 'not_applicable'; }, data => { data.authorization.merge = 'auto'; },
      data => { data.authorization.merge_error = 'auto'; }, data => { data.authorization = Object.entries(data.authorization); },
      data => { data.description = {}; }]) {
      const data = structuredClone(original); change(data); write(s.preset, stringify(data));
      assert.throws(s.load, /flow_authorization_invalid/);
    }
    write(s.preset, stringify(original));
    for (const value of [[], ['auto', 'auto'], ['skip'], ['not_applicable'], 'auto|ask']) {
      const data = structuredClone(definition); data.authorization_schema.commit = value;
      write(s.description, stringify(data)); assert.throws(s.load, /flow_schema_invalid/);
    }
    const invalid = structuredClone(definition); invalid.authorization_schema.direct_merge = ['auto', 'ask'];
    write(s.description, stringify(invalid)); assert.throws(s.load, /flow_schema_invalid/);
    definition.authorization_schema.commit = ['ask']; write(s.description, stringify(definition));
    assert.throws(s.load, /flow_authorization_invalid/);
    original.authorization.commit = 'ask'; write(s.preset, stringify(original));
    assert.equal(s.load().authorization.commit, 'ask');
    // Authorization comes from the file, not the conventional preset name.
    assert.equal(listAuthorizationPresets(mode, s.root)[0].authorization.commit, 'ask');
  } finally { f.dispose(); }
});

test('merge authorizations enforce the mode and keep each error grant independent', () => {
  const f = fixture();
  try {
    const s = resources(f);
    for (const { directory, name } of discoverDeliveryModes(s.root)) {
      const selector = directory + '/00.auto', flow = s.load(selector);
      const original = readFlowToml(flow.path), description = flow.definition.path;
      const schema = readFlowToml(description);
      const active = name === 'direct-merge' ? 'direct_merge' : name === 'pr-merge' ? 'pr_merge' : undefined;
      for (const key of ['direct_merge', 'direct_merge_error', 'pr_merge', 'pr_merge_error']) {
        const applies = key === active || key === active + '_error';
        assert.equal(original.authorization[key], applies ? 'auto' : 'not_applicable');
        assert.deepEqual(schema.authorization_schema[key], applies ? ['auto', 'ask'] : ['not_applicable']);
        const invalid = structuredClone(original);
        invalid.authorization[key] = applies ? 'not_applicable' : 'auto';
        write(flow.path, stringify(invalid));
        assert.throws(() => s.load(selector), error => error.message === 'flow_authorization_invalid' && error.field === key);
        delete invalid.authorization[key];
        write(flow.path, stringify(invalid));
        assert.throws(() => s.load(selector), /flow_authorization_invalid/);
        write(flow.path, stringify(original));
        const invalidSchema = structuredClone(schema);
        invalidSchema.authorization_schema[key] = applies ? ['not_applicable'] : ['auto', 'ask'];
        write(description, stringify(invalidSchema));
        assert.throws(() => s.load(selector), error => error.message === 'flow_schema_invalid' && error.field === key);
        write(description, stringify(schema));
      }
      if (active) {
        for (const grant of [{ [active]: 'auto', [active + '_error']: 'ask' }, { [active]: 'ask', [active + '_error']: 'auto' }]) {
          const data = structuredClone(original); Object.assign(data.authorization, grant);
          write(flow.path, stringify(data));
          const loaded = s.load(selector);
          for (const [key, value] of Object.entries(grant)) assert.equal(loaded.authorization[key], value);
        }
        write(flow.path, stringify(original));
      }
    }
  } finally { f.dispose(); }
});

test('target synchronization is PR-only and has independent sync, error and cleanup grants', () => {
  const f = fixture();
  try {
    const s = resources(f);
    for (const { directory, name } of discoverDeliveryModes(s.root)) {
      const selector = directory + '/00.auto', flow = s.load(selector), pr = name === 'pr-merge';
      const original = readFlowToml(flow.path), schema = readFlowToml(flow.definition.path);
      assert.equal(original.authorization.cleanup, 'auto');
      assert.ok(!Object.hasOwn(original.authorization, 'cleanup_sync'));
      for (const key of ['target_sync', 'target_sync_error']) {
        assert.equal(original.authorization[key], pr ? 'auto' : 'not_applicable');
        assert.deepEqual(schema.authorization_schema[key], pr ? ['auto', 'ask'] : ['not_applicable']);
        const invalid = structuredClone(original);
        invalid.authorization[key] = pr ? 'not_applicable' : 'ask';
        write(flow.path, stringify(invalid));
        assert.throws(() => s.load(selector), error => error.message === 'flow_authorization_invalid' && error.field === key);
        delete invalid.authorization[key];
        write(flow.path, stringify(invalid));
        assert.throws(() => s.load(selector), /flow_authorization_invalid/);
        write(flow.path, stringify(original));
        const invalidSchema = structuredClone(schema);
        invalidSchema.authorization_schema[key] = pr ? ['not_applicable'] : ['auto', 'ask'];
        write(flow.definition.path, stringify(invalidSchema));
        assert.throws(() => s.load(selector), error => error.message === 'flow_schema_invalid' && error.field === key);
        write(flow.definition.path, stringify(schema));
      }
      if (pr) for (const sync of ['auto', 'ask']) for (const error of ['auto', 'ask']) for (const cleanup of ['auto', 'ask']) {
        const data = structuredClone(original);
        Object.assign(data.authorization, { target_sync: sync, target_sync_error: error, cleanup });
        write(flow.path, stringify(data));
        assert.deepEqual(s.load(selector).authorization, data.authorization);
      }
      const legacy = structuredClone(original);
      legacy.authorization.cleanup_sync = legacy.authorization.cleanup;
      delete legacy.authorization.cleanup;
      write(flow.path, stringify(legacy));
      assert.throws(() => s.load(selector), /flow_authorization_invalid/);
      write(flow.path, stringify(original));
    }
    assert.equal(s.load('00/08').authorization.cleanup, 'ask');
    assert.equal(s.load('00/08').authorization.target_sync, 'not_applicable');
  } finally { f.dispose(); }
});

test('rendered PR synchronization constraints remain explicit with concise reference prose', () => {
  const flow = loadFlow('02/00');
  flow.stepReferences.push({ step: 'target_sync_error', 'zh-CN': { title: '同步本地目标分支受阻', body: '按实际情况处理。' } });
  for (const step of ['target_sync', 'close_issue', 'cleanup']) {
    flow.stepReferences.find(item => item.step === step)['zh-CN'].body = '按实际情况处理。';
  }
  const prompt = renderFlow('target', flow, 'zh-CN');
  assert.match(prompt, /工具选择不改变授权要求/);
  assert.match(prompt, /历史记录供参考/);
  assert.match(prompt, /#### 同步本地目标分支受阻\n\n仅在 target_sync 受阻时适用，授权为 auto。/);
});

test('missing synchronization guidance does not remove stages or block rendering', () => {
  const f = fixture();
  try {
    const s = resources(f);
    for (const name of ['14.target-sync', '15.target-sync-error']) rmSync(s.stepReference(name), { force: true });
    for (const mode of ['00', '01']) assert.deepEqual(s.load(mode + '/00').available_languages, ['zh-CN']);
    const flow = s.load('02/00');
    assert.deepEqual(flow.available_languages, ['zh-CN']);
    const prompt = renderFlow(f.root, flow, 'zh-CN');
    assert.match(prompt, /target_sync \(auto\)/);
    assert.match(prompt, /\| target_sync_error \| auto \|/);
  } finally { f.dispose(); }
});

test('authorization and schema table order do not change the steps or rendered prompt', () => {
  const f = fixture();
  try {
    const s = resources(f), selector = '02/00', flow = s.load(selector);
    const before = renderFlow(f.root, flow, 'zh-CN');
    for (const [path, field] of [[flow.path, 'authorization'], [flow.definition.path, 'authorization_schema']]) {
      const data = readFlowToml(path);
      data[field] = Object.fromEntries(Object.entries(data[field]).reverse());
      write(path, stringify(data));
    }
    const reordered = s.load(selector);
    assert.deepEqual(reordered.definition.steps, flow.definition.steps);
    assert.deepEqual(reordered.definition.errors, flow.definition.errors);
    assert.equal(renderFlow(f.root, reordered, 'zh-CN'), before);
  } finally { f.dispose(); }
});

test('TOML supports quoted patterns and multiline prose without include or command expansion', () => {
  const f = fixture();
  try {
    const s = resources(f), path = s.stepReference('06.commit');
    write(path, '[zh-CN."*"]\ntitle = "commit"\nbody = \'\'\'\n第一行\n@include ../../outside@\n@gidd flow.issue 00/00@\n\'\'\'\n[en."*"]\ntitle = ""\nbody = ""\n');
    const before = snapshot(f.root), text = renderFlow(f.root, s.load(), 'zh-CN');
    assert.match(text, /第一行\n@include ..\/..\/outside@\n@gidd flow.issue 00\/00@/);
    assert.deepEqual(snapshot(f.root), before);
    for (const invalid of ['x = 1\nx = 2', '[broken', '[a]\nx = 1\n[a]\nx = 2', 'body = "secret invalid', 'body = bare']) {
      write(path, invalid);
      assert.throws(s.load, error => error.message === 'flow_toml_invalid' && error.path === path && !error.message.includes('secret'));
    }
    for (const invalid of [Buffer.from([0xff, 0xfe]), '\0', ' ', 'x'.repeat(65537)]) {
      write(path, invalid); assert.throws(s.load, /flow_resources_invalid/);
    }
  } finally { f.dispose(); }
});

test('pattern matching is anchored, only star is special, and ambiguity is rejected', () => {
  assert.ok(matchesDeliveryMode('direct-*', mode)); assert.ok(!matchesDeliveryMode('direct-*', 'no-' + mode));
  assert.ok(matchesDeliveryMode('*-merge', deliveryModeNames[2])); assert.ok(!matchesDeliveryMode('direct.*', 'directXcommit'));
  assert.ok(matchesDeliveryMode('direct-*', 'direct-a.b')); assert.ok(!matchesDeliveryMode('direct-?', mode));
  const f = fixture();
  try {
    const s = resources(f), path = s.stepReference('06.commit'), original = readFlowToml(path);
    const attempt = (change, reason) => { const data = structuredClone(original); change(data); write(path, stringify(data)); assert.throws(s.load, new RegExp(reason)); };
    attempt(data => { for (const lang of ['en', 'zh-CN']) data[lang]['direct-*'] = data[lang]['*']; }, 'flow_pattern_ambiguous');
    attempt(data => { for (const lang of ['en', 'zh-CN']) { data[lang]['pr-merge'] = data[lang]['*']; delete data[lang]['*']; } }, 'flow_pattern_missing');
    attempt(data => { data.en['direct-*'] = data.en['*']; delete data.en['*']; }, 'flow_pattern_mismatch');
    attempt(data => { data.en['never.*'] = data.en['*']; }, 'flow_pattern_invalid');
    attempt(data => { data.en['direct-?'] = data.en['*']; }, 'flow_pattern_invalid');
    write(path, stringify(original)); assert.deepEqual(s.load().available_languages, ['zh-CN']);
  } finally { f.dispose(); }
});

test('unrelated drafts and inapplicable modules cannot block a selected flow', () => {
  const f = fixture();
  try {
    const s = resources(f);
    write(join(s.root, directory, '99.draft.toml'), '');
    write(join(s.root, directory, '_notes.toml'), 'not toml');
    write(join(s.root, '02.' + deliveryModeNames[2], 'description.toml'), 'not toml');
    for (const name of ['07.direct-merge', '08.direct-merge-error', '12.pr-merge', '13.pr-merge-error',
      '14.target-sync', '15.target-sync-error']) rmSync(s.stepReference(name), { force: true });
    assert.deepEqual(s.load().available_languages, ['zh-CN']);
    const list = listAuthorizationPresets(mode, s.root);
    assert.equal(list.length, listAuthorizationPresets(mode).length + 1); assert.equal(list.find(item => item.name === '99.draft').details?.code, 'flow_resources_invalid');
    assert.equal(listDeliveryModes('zh-CN', s.root)[0].presets, 16);
    assert.equal(listDeliveryModes('zh-CN', s.root)[2].details?.code, 'flow_toml_invalid');
    assert.deepEqual(Object.keys(listDeliveryModes('zh-CN', s.root)[2]), ['name', 'presets', 'details']);
    assert.equal(listDeliveryModes('zh-CN', s.root)[2].name, '02.' + deliveryModeNames[2]);
    rmSync(s.stepReference('06.commit')); assert.deepEqual(s.load().available_languages, ['zh-CN']);
  } finally { f.dispose(); }
});

test('language completeness is checked before any prompt is emitted; Issue templates remain independently usable', () => {
  const f = fixture();
  try {
    const s = resources(f);
    const result = flowCommand(f.root, options('flow', [auto], 'en'), s.root);
    assert.equal(result.exitCode, 2); assert.equal(result.markdown, undefined);
    assert.equal(result.report.details?.code, 'flow_language_unavailable'); assert.equal(result.report.details.path, s.description);
    const description = readFlowToml(s.description);
    description.en = { title: 'Example', body: 'Mode text' };
    write(s.description, stringify(description));
    assert.throws(s.load, /flow_translation_invalid/);
    description.en = { description: 'Mode text' };
    write(s.description, stringify(description));
    assert.equal(flowCommand(f.root, options('flow', [auto], 'en'), s.root).exitCode, 0);
    for (const item of s.load().stepReferences) {
      const data = readFlowToml(item.path);
      for (const value of Object.values(data.en)) Object.assign(value, { title: 'Example', body: 'English reference' });
      write(item.path, stringify(data));
    }
    const prompt = flowCommand(f.root, options('flow', [auto], 'en'), s.root).markdown;
    assert.match(prompt, /English reference/);
    assert.ok(prompt.includes('# ' + auto + '\n\nMode text\n\n## Flow and authorization'));
    for (const lang of ['zh', 'en']) assert.equal(flowCommand(f.root, options('flow.issue', [auto], lang), s.root).exitCode, 0);
    // Model an unfinished reference in the fixture, independent of shipped prose.
    const mergePath = s.stepReference('12.pr-merge'), merge = readFlowToml(mergePath);
    for (const reference of Object.values(merge['zh-CN'])) reference.body = '';
    write(mergePath, stringify(merge));
    const unfinished = flowCommand(f.root, options('flow', [deliveryModeNames[2] + '/00.auto']), s.root);
    assert.equal(unfinished.exitCode, 0);
    assert.ok(unfinished.markdown);
  } finally { f.dispose(); }
});

test('relative templates are confined to installed references, including junctions', () => {
  const f = fixture();
  try {
    const s = resources(f), definition = readFlowToml(s.description), original = definition.issue_template.en;
    for (const ref of ['https://example.test/a.json', 'C:/outside.json', '../../../outside.json', '../00.auto.toml', '../../flows/private.json', '/root.json']) {
      definition.issue_template.en = ref; write(s.description, stringify(definition));
      assert.throws(s.load, /flow_resource_path_invalid/);
    }
    const outside = join(f.root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(s.root, '../references/linked'), 'junction');
    definition.issue_template.en = '../../references/linked/issue.json'; write(s.description, stringify(definition));
    assert.throws(s.load, /flow_resource_path_invalid/);
    definition.issue_template.en = original; write(s.description, stringify(definition));
    assert.ok(s.load().issueForms.en.body.length);
    const selected = join(s.root, directory); assert.ok(selected.startsWith(f.root + '\\')); rmSync(selected, { recursive: true });
    symlinkSync(join(flowRoot, directory), selected, 'junction');
    assert.throws(s.load, /flow_resource_path_invalid/);
  } finally { f.dispose(); }
});

test('flow history is independent of config and rejects invalid choices without mutation', () => {
  const f = fixture();
  try {
    const target = join(f.root, 'target'); mkdirSync(join(target, '.git'), { recursive: true }); initializeDataFixture(target);
    const path = configPath(target); write(path, '# optional preferences\nschema_version = 1\n');
    recordFlowUse(flowStorage(target), flowSnapshot(loadFlow('00/04')));
    const result = flowCommand(target, options('flow', ['00/04']));
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(path, 'utf8'), '# optional preferences\nschema_version = 1\n');
    assert.equal(readFlowHistory(flowStorage(target)).at(-1).selector, ask);
    const before = snapshot(f.root);
    for (const selector of ['00/99', '02.unknown', '00/missing']) {
      assert.notEqual(flowCommand(target, { action: 'show', selector, lang: 'zh' }).exitCode, 0);
      assert.deepEqual(snapshot(f.root), before);
    }
  } finally { f.dispose(); }
});

test('task prompts retain approval points after another selection and preset edits', () => {
  const f = fixture();
  try {
    const s = resources(f), target = join(f.root, 'target');
    mkdirSync(join(target, '.git'), { recursive: true });
    initializeDataFixture(target);
    const flow = flowSnapshot(s.load(ask));
    const task = { ...newTask(14, { mode, remote: { fetch: { repository: 'https://github.com/test/repo', branch: 'main' },
      push: { repository: 'https://github.com/test/repo' } } }, 'main'), flow, github_account: 'tester' };
    write(join(target + '.gidd', '14/state.json'), JSON.stringify(task));
    recordFlowUse(flowStorage(target), flowSnapshot(s.load(ask)));
    const path = join(s.root, ask + '.toml');
    write(path, readFileSync(path, 'utf8').replace(/^commit\s*=\s*"ask"/m, 'commit = "auto"'));
    const result = issueTaskFlowCommand(target, options('14.flow'), s.root);
    assert.equal(result.exitCode, 0);
    assert.match(result.markdown, /\| commit \| ask \|/);
    assert.match(flowCommand(target, options('flow', [ask]), s.root).markdown, /\| commit \| auto \|/);
  } finally { f.dispose(); }
});

test('saved task flows and doctor outlive changed, invalid or deleted authorization presets', async () => {
  const f = fixture();
  try {
    const skill = join(f.root, 'skill'), target = join(f.root, 'target');
    copySkill(skill);
    const root = join(skill, 'flows'), preset = join(root, ask + '.toml');
    const original = readFileSync(preset, 'utf8'), saved = flowSnapshot(loadFlow(ask, root));
    mkdirSync(join(target, '.git'), { recursive: true });
    initializeDataFixture(target);
    const storage = flowStorage(target), state = join(storage.path, '14/state.json');
    write(state, JSON.stringify({ ...newTask(14, { mode, remote: {
      fetch: { repository: 'https://github.com/test/repo', branch: 'main' },
      push: { repository: 'https://github.com/test/repo' },
    } }, 'main'), flow: saved, github_account: 'tester' }));
    const { run: inspectSavedFlow } = await import(pathToFileURL(join(skill,
      'scripts.js/commands/doctor/checks/folder.gidd.flow.mjs')).href);
    const context = { run: async id => {
      assert.equal(id, 'folder.gidd');
      return { status: 'ready', details: { path: storage.path } };
    } };
    const changed = original.replace(/^commit\s*=\s*"ask"/m, 'commit = "auto"');
    for (const [text, reason] of [[changed, undefined], ['[authorization', 'flow_toml_invalid'],
      [null, 'flow_resources_missing']]) {
      if (text === null) rmSync(preset); else write(preset, text);
      const before = snapshot(f.root), result = issueTaskFlowCommand(target, options('14.flow'), root);
      assert.equal(result.exitCode, 0, JSON.stringify(result.report));
      assert.match(result.markdown, /\| commit \| ask \|/);
      assert.equal((await inspectSavedFlow(context)).status, 'ready');
      const current = flowCommand(target, options('flow', [ask]), root);
      if (reason) assert.equal(current.report.details.code, reason);
      else assert.match(current.markdown, /\| commit \| auto \|/);
      assert.deepEqual(snapshot(f.root), before);
    }
    const prompt = issueTaskFlowCommand(target, options('14.flow'), root).markdown;
    assert.ok(prompt.includes(state));
    assert.ok(!prompt.includes('gidd flow.issue'));
    const description = join(root, directory, 'description.toml'), definition = readFlowToml(description);
    definition.authorization_schema.commit = ['auto'];
    write(description, stringify(definition));
    assert.match(issueTaskFlowCommand(target, options('14.flow'), root).markdown, /\| commit \| ask \|/);
    assert.equal((await inspectSavedFlow(context)).status, 'ready');
    write(description, '[');
    assert.equal(issueTaskFlowCommand(target, options('14.flow'), root).report.details.code, 'flow_toml_invalid');
    assert.equal((await inspectSavedFlow(context)).reason, 'flow_toml_invalid');
    write(description, stringify(definition));
    write(join(root, '../references/steps/06.commit.toml'), '[');
    assert.equal(issueTaskFlowCommand(target, options('14.flow'), root).report.details.code, 'flow_toml_invalid');
    assert.equal((await inspectSavedFlow(context)).reason, 'flow_toml_invalid');
    const invalid = JSON.parse(readFileSync(state, 'utf8'));
    invalid.flow.authorization.commit = 'not_applicable';
    write(state, JSON.stringify(invalid));
    assert.equal(issueTaskFlowCommand(target, options('14.flow'), root).report.details.code, 'task_invalid');
    assert.equal((await inspectSavedFlow(context)).reason, 'task_invalid');
  } finally { f.dispose(); }
});

test('repository commands read explicit flows and saved task prompts offline', () => {
  const f = fixture();
  try {
    const s = installation(f, null), before = snapshot(f.root);
    const deliveries = json(ok(s.invoke(['flow.deliveries', '--lang', 'zh'])));
    assert.deepEqual(deliveries.deliveries.map(item => item.name), deliveryModeNames.map((name, index) => '0' + index + '.' + name));
    assert.equal(Object.hasOwn(deliveries, 'modes'), false);
    const presets = json(ok(s.invoke(['flow.list', '00', '--lang', 'zh'])));
    assert.equal(presets.delivery_mode, '00');
    assert.deepEqual(presets.presets, listAuthorizationPresets(mode));
    assert.equal(Object.hasOwn(presets, 'flows'), false);
    assert.equal(Object.hasOwn(presets, 'mode'), false);
    assert.ok(ok(s.invoke(['flow', auto, '--lang', 'zh'])).stdout.includes('gidd flow.issue ' + auto + ' --lang zh'));
    const template = json(ok(s.invoke(['flow.issue', auto, '--lang', 'en'])));
    assert.ok(template.form.body.length);
    assert.equal(template.delivery_mode, mode);
    assert.equal(Object.hasOwn(template, 'mode'), false);
    for (const route of ['flow.current', 'flow.issue.current']) assert.equal(json(s.invoke([route])).details.code, 'invalid_flow_route');
    assert.deepEqual(snapshot(f.root), before);
    initializeDataFixture(s.target);
    const flow = flowSnapshot(loadFlow(ask));
    const task = { ...newTask(14, { mode, remote: { fetch: { repository: 'https://github.com/test/repo', branch: 'main' },
      push: { repository: 'https://github.com/test/repo' } } }, 'main'), flow, github_account: 'tester' };
    write(join(s.target + '.gidd', '14/state.json'), JSON.stringify(task));
    recordFlowUse(flowStorage(s.target), flow);
    ok(s.invoke(['lang.set', 'zh']));
    assert.equal(ok(s.invoke(['flow.history'])).stdout, historyHeading + '00/04\n');
    assert.match(ok(s.invoke(['flow.history', '-v'])).stdout.split(/\r?\n/)[1], /^00\/04 \d{4}-\d{2}-\d{2}T[^\r\n]+Z$/);
    const selected = snapshot(f.root), prompt = ok(s.invoke(['14.flow'])).stdout;
    assert.ok(prompt.startsWith('任务：Issue #14。'));
    assert.match(prompt, /\| commit \| ask \|/);
    assert.equal(realpathSync.native(prompt.match(/^适用范围: `([^`\r\n]+)`/m)[1]), realpathSync.native(s.target));
    assert.deepEqual(json(ok(s.invoke(['flow.issue', '00/04']))).form, json(ok(s.invoke(['flow.issue', ask]))).form);
    assert.equal(json(s.invoke(['14.flow', '--lang', 'en'])).details.code, 'flow_language_unavailable');
    assert.equal(json(s.invoke(['999.flow'])).details.code, 'task_required');
    assert.equal(json(s.invoke(['flow.list'])).details.code, 'invalid_arguments');
    assert.deepEqual(snapshot(f.root), selected);
    ok(run(s.git, ['-C', s.target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']));
    const linked = join(f.root, 'linked');
    ok(run(s.git, ['-C', s.target, 'worktree', 'add', '-b', 'linked', linked]));
    const invokeLinked = args => runRepositoryCommand(linked, args, { entry: join(s.skill, 'gidd.cmd'), env: { PATH: '' } });
    recordFlowUse(flowStorage(s.target), flowSnapshot(loadFlow(auto)));
    const linkedBefore = snapshot(f.root);
    assert.equal(ok(invokeLinked(['14.flow'])).stdout, prompt);
    assert.equal(ok(invokeLinked(['flow.history'])).stdout, historyHeading + '00/00 00/04\n');
    const check = json(invokeLinked(['doctor', '--offline'])).checks.find(item => item.id === 'folder.gidd.flow');
    assert.equal(check.status, 'ready'); assert.equal(check.details.entries, 2); assert.equal(check.details.tasks, 1);
    assert.deepEqual(snapshot(f.root), linkedBefore);
  } finally { f.dispose(); }
});

test('doctor accepts empty history and removed historical flows and diagnoses corrupt history without changing it', async () => {
  const f = fixture();
  try {
    const target = join(f.root, 'target'); mkdirSync(join(target, '.git'), { recursive: true }); initializeDataFixture(target);
    const context = { configRoot: target, run: async () => ({ status: 'ready', details: { path: target + '.gidd' } }) };
    assert.equal((await inspectFlowHistory(context)).details.entries, 0);
    recordFlowUse(flowStorage(target), flowSnapshot(loadFlow('00/04')));
    assert.equal((await inspectFlowHistory(context)).details.entries, 1);
    recordFlowUse(flowStorage(target), { ...flowSnapshot(loadFlow('00/04')), selector: '00.direct-commit/99.removed' });
    assert.equal((await inspectFlowHistory(context)).status, 'ready');
    const history = join(target + '.gidd', 'flow-history.jsonl');
    for (const value of [null, { schema: 'bad', entries: [] }, { at: 'bad', selector: ask },
      { at: new Date().toISOString(), selector: '00/04' }, { at: new Date().toISOString(), selector: ask, authorization: {} }]) {
      write(history, JSON.stringify(value) + '\n');
      const before = snapshot(f.root);
      assert.equal((await inspectFlowHistory(context)).reason, 'flow_history_invalid');
      assert.deepEqual(snapshot(f.root), before);
    }
    assert.equal((await inspectFlowHistory({ ...context, run: async () => ({ status: 'not_checked' }) })).blocked_by, 'folder.gidd');
  } finally { f.dispose(); }
});

test('history appends through 500 records, then retains 200 and prints the latest first', () => {
  const f = fixture();
  try {
    const target = join(f.root, 'target'); mkdirSync(join(target, '.git'), { recursive: true }); initializeDataFixture(target);
    const storage = flowStorage(target), path = join(storage.path, 'flow-history.jsonl');
    const entries = Array.from({ length: 499 }, (_, index) => ({ at: new Date(index * 1000).toISOString(), selector: index % 2 ? auto : ask }));
    const before = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    write(path, before);
    recordFlowUse(storage, flowSnapshot(loadFlow(auto)));
    const appended = readFileSync(path, 'utf8');
    assert.ok(appended.startsWith(before));
    assert.equal(readFlowHistory(storage).length, 500);
    assert.deepEqual(Object.keys(readFlowHistory(storage).at(-1)), ['at', 'selector']);
    const history = flowCommand(target, options('flow.history')).markdown;
    assert.ok(history.startsWith(historyHeading));
    assert.ok(flowCommand(target, options('flow.history', [], 'en')).markdown.startsWith('Workflow records (newest first, up to 200):\n'));
    const output = history.trim().split('\n')[1].split(' ');
    assert.equal(output.length, 200); assert.deepEqual(output.slice(0, 3), ['00/00', '00/04', '00/00']);
    const verbose = flowCommand(target, options('flow.history', ['-v'])).markdown.trim().split('\n').slice(1);
    assert.equal(verbose.length, 200);
    assert.equal(verbose[0], '00/00 ' + readFlowHistory(storage).at(-1).at);
    assert.equal(verbose.at(-1), '00/04 ' + entries[300].at);
    recordFlowUse(storage, flowSnapshot(loadFlow(ask)));
    const retained = readFlowHistory(storage);
    assert.equal(retained.length, 200); assert.deepEqual(retained[0], entries[301]);
    assert.equal(retained.at(-1).selector, ask);
    const stable = readFileSync(path, 'utf8');
    flowCommand(target, options('flow.history', ['-v']));
    assert.equal(readFileSync(path, 'utf8'), stable);
  } finally { f.dispose(); }
});

test('history recovers an interrupted final append and keeps ambiguous or missing names readable', () => {
  const f = fixture();
  try {
    const s = resources(f), target = join(f.root, 'target');
    mkdirSync(join(target, '.git'), { recursive: true }); initializeDataFixture(target);
    const storage = flowStorage(target), path = join(storage.path, 'flow-history.jsonl');
    assert.equal(flowCommand(target, options('flow.history'), s.root).markdown, '暂无工作流程记录。\n');
    assert.equal(flowCommand(target, options('flow.history', [], 'en'), s.root).markdown, 'No workflow records.\n');
    recordFlowUse(flowStorage(target), flowSnapshot(s.load(ask)));
    const complete = readFileSync(path, 'utf8');
    write(path, complete + '{"at":"interrupted');
    const damaged = readFileSync(path, 'utf8');
    assert.equal(readFlowHistory(storage).length, 1);
    assert.equal(readFileSync(path, 'utf8'), damaged);
    recordFlowUse(flowStorage(target), flowSnapshot(s.load(ask)));
    assert.ok(readFileSync(path, 'utf8').startsWith(complete));
    assert.equal(readFlowHistory(storage).length, 2);
    // Bun does not update named builtin imports through syncBuiltinESMExports.
    if (!process.versions.bun) {
      const stable = readFileSync(path, 'utf8'), originalSync = fs.fsyncSync;
      try {
        fs.fsyncSync = () => { throw new Error('injected_sync_failure'); }; syncBuiltinESMExports();
        assert.throws(() => recordFlowUse(storage, flowSnapshot(loadFlow(auto))), /injected_sync_failure/);
      } finally { fs.fsyncSync = originalSync; syncBuiltinESMExports(); }
      assert.equal(readFileSync(path, 'utf8'), stable);
    }
    assert.equal(flowCommand(target, options('flow.history'), s.root).markdown, historyHeading + '00/04 00/04\n');
    cpSync(join(s.root, ask + '.toml'), join(s.root, directory, '04.other.toml'));
    assert.equal(flowCommand(target, options('flow.history'), s.root).markdown, historyHeading + ask + ' ' + ask + '\n');
    rmSync(join(s.root, ask + '.toml'));
    assert.equal(flowCommand(target, options('flow.history'), s.root).markdown, historyHeading + ask + ' ' + ask + '\n');
    for (const invalid of ['not-json\n', '\n', Buffer.from([255, 10]), 'x'.repeat(1024 * 1024 + 1)]) {
      write(path, invalid);
      assert.throws(() => readFlowHistory(storage), /flow_history_invalid/);
      const before = snapshot(f.root);
      assert.throws(() => recordFlowUse(flowStorage(target), flowSnapshot(loadFlow(auto))), /flow_history_invalid/);
      assert.deepEqual(snapshot(f.root), before);
    }
    rmSync(path); symlinkSync(s.preset, path, 'file');
    assert.throws(() => readFlowHistory(storage), /reparse_path/);
    rmSync(path);
  } finally { f.dispose(); }
});

test('forms reject invalid native fields, translation drift and misplaced GIDD checks', () => {
  const flow = loadFlow(auto);
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
    const forms = structuredClone(flow.issueForms); change(forms);
    assert.throws(() => validateIssueForms(forms), /flow_resources_invalid/);
  }
});

test('all delivery modes use ordinary Issue forms without delivery configuration', () => {
  for (const id of ['00', '01', '02']) {
    const forms = loadFlow(id + '/00').issueForms;
    for (const form of Object.values(forms)) {
      assert.deepEqual(form.body.map(field => field.id), ['requirements', 'acceptance', 'completion']);
      assert.ok(!JSON.stringify(form).includes('delivery_mode'));
    }
  }
});

test('native form validation preserves metadata, input and display-only markdown', () => {
  const forms = structuredClone(loadFlow(auto).issueForms);
  for (const form of Object.values(forms)) {
    Object.assign(form, { title: '[Task]: ', labels: ['development'], assignees: ['octocat'], projects: ['owner/1'], type: 'Task' });
    form.body[0].type = 'input'; form.body[0].id = 'Goal_1';
    form.body[0].attributes.value = 'Useful default'; form.body.find(field => field.id === 'acceptance').attributes.render = 'shell';
    form.body.unshift({ type: 'markdown', attributes: { value: '## Visible guidance only' } });
  }
  const before = structuredClone(forms);
  assert.deepEqual(validateIssueForms(forms), before); assert.deepEqual(forms, before);
});
