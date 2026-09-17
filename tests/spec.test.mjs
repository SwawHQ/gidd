import { test } from 'node:test';
import { realpathSync, renameSync } from 'node:fs';
import { configure } from '../.agents/skills/gidd/scripts.js/config.mjs';
import { parseConfiguration } from '../.agents/skills/gidd/scripts.js/storage.mjs';
import { specCommand, parseSpecArguments } from '../.agents/skills/gidd/scripts.js/spec.mjs';
import { publishRepositoryEntry, runRepositoryCommand } from './support/repository.mjs';
import { loadSpec } from '../.agents/skills/gidd/scripts.js/specs.mjs';
import { parseSpecYaml, validateIssueForms } from '../.agents/skills/gidd/scripts.js/spec-data.mjs';
import { stringify as stringifyYaml } from '../.agents/skills/gidd/scripts.js/vendor/yaml.mjs';
import { adapter, assert, bindFixture, compile, copySkill, dirname, existsSync, findGit, fixture, join, json, mkdirSync, ok,
  readFileSync, readdirSync, repo, rmSync, run, snapshot, stub, toolsRoot, write } from './support/helpers.mjs';

const chosen = 'schema_version = 1\n[spec]\nmode = "issue-direct"\n';
const github = '[repo]\nremote.url = "https://github.com/owner/repo"\nremote.name = "origin"\n';
const configPath = root => join(root, '.agents/skills/gidd/config.toml');
function installation(f, config = chosen) {
  const skill = join(f.root, "installed skill 中文 & ' spaces");
  const target = join(f.root, 'target'), elsewhere = join(f.root, 'elsewhere');
  copySkill(skill); mkdirSync(join(target, '.git'), { recursive: true }); mkdirSync(elsewhere);
  if (config !== null) write(configPath(target), config);
  ok(adapter(f.root,{action:'bootstrap',repositoryRoot:target,responses:{},downloads:{},yes:true},{env:{PATH:dirname(process.execPath)}}));
  publishRepositoryEntry(target,join(skill,'scripts.js/gidd.mjs'));
  const invoke = (args, options = {}) => runRepositoryCommand(target, args,
    { cwd: elsewhere, ...options, env: { PATH: '', GIDD_LANG: 'en', ...options.env } });
  const current = (...args) => invoke(['spec.current', ...args]);
  const diagnose = () => json(invoke(['doctor', '--offline']));
  return { skill, target, invoke, current, diagnose };
}
const check = (report, id) => report.checks.find(item => item.id === id);

test('spec mode editing preserves text while preparation ignores business configuration', () => {
  const f = fixture();
  try {
    const path = configPath(f.root);
    assert.throws(() => configure(f.root, 'set', 'spec.mode', 'issue-pr'), /spec_mode_unsupported/);
    assert.equal(existsSync(path), false);
    for (const newline of ['\n', '\r\n']) {
      const text = '\uFEFF' + ['# 用户注释', 'schema_version = 1', '[git]', 'user.mode = "inherit"', 'credential.mode = "inherit"', '[spec] # choice',
        "  mode = 'unknown-mode' # preserve", '[repo]', 'remote.account = "bad account"', ''].join(newline);
      write(path, text);
      ok(adapter(f.root, { action: 'configuration', repositoryRoot: f.root }, { env: { PATH: '' } }));
      assert.equal(parseConfiguration(text).spec.mode, 'unknown-mode');
      configure(f.root, 'set', 'spec.mode', 'issue-direct');
      assert.equal(readFileSync(path, 'utf8'), text.replace("'unknown-mode'", '"issue-direct"'));
      configure(f.root, 'set', 'repo.remote.account', 'Octocat');
      assert.equal(parseConfiguration(configure(f.root, 'show').content).spec.mode, 'issue-direct');
      ok(adapter(f.root, { action: 'configuration', repositoryRoot: f.root }, { env: { PATH: '' } }));
    }
    for (const text of ['schema_version = 1\n', 'schema_version = 1\n[spec]\n# select here\n']) {
      write(path, text); configure(f.root, 'set', 'spec.mode', 'issue-direct');
      assert.equal(parseConfiguration(readFileSync(path, 'utf8')).spec.mode, 'issue-direct');
    }
    for (const tail of ['mode = true\n', 'mode = "a"\nmode = "b"\n', 'unknown = "x"\n', '[spec]\n']) {
      const text = 'schema_version = 1\n[spec]\n' + tail;
      write(path, text);
      assert.throws(() => parseConfiguration(text), /config_/);
      ok(adapter(f.root, { action: 'configuration', repositoryRoot: f.root }, { env: { PATH: '' } }));
    }
    assert.equal(existsSync(toolsRoot(f.root)), false, 'Configuration must not prepare tools');
  } finally { f.dispose(); }
});

test('doctor and current agree on absent, missing and unsupported modes and never select one silently', () => {
  const f = fixture();
  try {
    const s = installation(f, null);
    for (const text of [null, 'schema_version = 1\n', 'schema_version = 1\n[spec]\nmode = "issue-pr"\n']) {
      if (text !== null) write(configPath(s.target), text);
      const before = snapshot(f.root), result = s.current(), report = json(result);
      assert.equal(result.status, 1);
      assert.equal(report.scope, s.target);
      assert.equal(report.mode, text?.includes('issue-pr') ? 'issue-pr' : undefined);
      assert.equal(report.checks, undefined);
      assert.equal(report.error, text?.includes('issue-pr') ? 'spec_mode_unsupported' : 'spec_mode_missing');
      assert.match(report.hint, /doctor/);
      const diagnosis = s.diagnose();
      if (text !== null) {
        const mode = check(diagnosis, 'config.spec.mode');
        assert.equal(mode.reason, report.error);
        assert.deepEqual(mode.details.available_modes, ['issue-direct']);
        assert.deepEqual(mode.commands[0].args, ['set', 'spec.mode', 'issue-direct']);
      }
      else assert.equal(check(diagnosis, 'config.spec.mode').blocked_by, 'config.toml');
      assert.deepEqual(snapshot(f.root), before);
    }
    configure(s.target, 'set', 'spec.mode', 'issue-direct');
    assert.equal(check(s.diagnose(), 'config.spec.mode').status, 'ready');
    assert.deepEqual(check(s.diagnose(), 'config.spec.mode').details, { configured: 'issue-direct' });
    assert.match(ok(s.current()).stdout, /Prompt source: ` .+prompt\.en\.md `/);
  } finally { f.dispose(); }
});

test('successful offline doctor guarantees current spec and localized templates are readable', () => {
  const f = fixture();
  try {
    const s = installation(f, chosen + github + 'remote.account = "Octocat"\n[git]\nuser.mode = "inherit"\ncredential.mode = "inherit"\n');
    const git = findGit(), gh = join(f.root, 'bin/gh.exe');
    stub(compile(f.root), gh);
    bindFixture(f.root, { git, gh });
    ok(run(git, ['-C', s.target, 'init', '--quiet']));
    ok(run(git, ['-C', s.target, 'config', 'user.name', 'Test Author']));
    ok(run(git, ['-C', s.target, 'config', 'user.email', 'author@example.test']));
    ok(run(git, ['-C', s.target, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git']));
    const verify = () => {
      const before = snapshot(f.root);
      const diagnosis = json(ok(s.invoke(['doctor', '--offline'])));
      assert.equal(diagnosis.status, 'local_ready');
      assert.equal(check(diagnosis, 'config.spec.mode').status, 'ready');
      for (const lang of ['en', 'zh']) {
        const result = ok(s.current('--lang', lang));
        assert.match(result.stdout, /issue-direct/);
        assert.match(result.stdout, /## 1\./);
        assert.ok(json(ok(s.invoke(['spec.current.issue', '--lang', lang]))).form.body.length);
      }
      assert.deepEqual(snapshot(f.root), before);
    };
    verify();
    // Even an unused language must be checked before doctor can report success.
    const prompt = join(s.skill, 'spec.issue-direct/prompt.en.md'), saved = readFileSync(prompt, 'utf8');
    write(prompt, '');
    const failed = s.invoke(['doctor', '--offline']);
    assert.equal(failed.status, 1);
    assert.equal(check(json(failed), 'config.spec.mode').reason, 'spec_resources_invalid');
    assert.equal(s.current('--lang', 'zh').status, 1);
    write(prompt, saved);
    verify();
  } finally { f.dispose(); }
});

test('spec readers emit scoped Markdown guidance and preserve native form JSON', () => {
  const f = fixture();
  try {
    const s = installation(f), before = snapshot(f.root);
    for (const [lang, locale] of [['zh', 'zh-CN'], ['en', 'en']]) {
      assert.deepEqual(json(ok(s.invoke(['spec.list', '--lang', lang]))), { scope: s.target, names: ['issue-direct'] });
      const prompt = readFileSync(join(s.skill, `spec.issue-direct/prompt.${locale}.md`), 'utf8');
      const form = parseSpecYaml(readFileSync(join(s.skill, `spec.issue-direct/issue.${locale}.yaml`), 'utf8'));
      for (const route of ['spec.current', 'spec.issue-direct']) {
        const result = ok(s.invoke([route, '--lang', lang]));
        const header = (lang === 'zh' ? '适用范围' : 'Scope') + ': ` ' + s.target + ' `  \n' +
          (lang === 'zh' ? '提示来源' : 'Prompt source') + ': ` ' + realpathSync.native(join(s.skill, `spec.issue-direct/prompt.${locale}.md`)) + ' `\n\n';
        assert.equal(result.stdout, header + prompt);
        assert.equal(result.stderr, '');
      }
      for (const route of ['spec.current.issue', 'spec.issue-direct.issue']) {
        const result = ok(s.invoke([route, '--lang', lang])), report = json(result);
        assert.deepEqual(report, { scope: s.target, mode: 'issue-direct', form });
        assert.equal(result.stdout.trim(), JSON.stringify(report, null, 2));
        assert.equal(result.stderr, '');
      }
    }
    assert.deepEqual(json(ok(s.invoke(['spec.list']))), { scope: s.target, names: ['issue-direct'] });
    assert.match(ok(s.invoke(['spec.current'], { env: { GIDD_LANG: 'zh-CN' } })).stdout, /关联的 Issue/);
    assert.deepEqual(snapshot(f.root), before);
    for (const text of ['', 'schema_version = 1\n', 'schema_version = 1\n[spec]\nmode = "unavailable"\n']) {
      write(configPath(s.target), text);
      const saved = snapshot(f.root);
      assert.deepEqual(json(ok(s.invoke(['spec.list']))).names, ['issue-direct']);
      assert.match(ok(s.invoke(['spec.issue-direct'])).stdout, /Prompt source: ` .+prompt\.en\.md `/);
      assert.equal(json(ok(s.invoke(['spec.issue-direct.issue']))).form.body[2].attributes.label, 'Acceptance criteria');
      assert.deepEqual(snapshot(f.root), saved);
    }
  } finally { f.dispose(); }
});

test('unknown arguments and retired names are rejected without changing files', () => {
  const f = fixture();
  try {
    const s = installation(f), before = snapshot(f.root);
    for (const route of ['spec.list', 'spec.current', 'spec.issue-direct', 'spec.current.issue',
      'spec.issue-direct.issue']) {
      const args = ['--json'];
      const result = s.invoke([route, ...args]);
      assert.equal(result.status, 2);
      assert.deepEqual(Object.keys(json(result)), ['scope', 'error', 'hint']);
      assert.equal(json(result).scope, s.target);
      assert.equal(json(result).error, 'invalid_arguments');
      assert.equal(result.stdout.trim(), JSON.stringify(json(result), null, 2));
    }
    for (const args of [['unknown'], ['current', 'extra'], ['current'], ['current', '--lang'],
      ['--json'], ['--lang'], ['--lang', 'fr'], ['--unknown'], ['--json', 'current'],
      ['current', '--lang', 'fr'], ['current', '--lang', 'en', '--lang', 'zh'], ['template'], ['template', '../secret']]) {
      const result = s.invoke(['spec.list', ...args]);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.equal(json(result).scope, s.target);
      assert.ok(json(result).error);
    }
    for (const [args, reason] of [
      [['spec'], 'invalid_spec_route'],
      [['spec', '--lang', 'en'], 'invalid_spec_route'],
      [['spec.list.issue'], 'invalid_spec_route'],
      [['workflow', 'current'], 'unknown_command'],
      [['set', 'workflow.mode', 'issue-direct'], 'config_unknown_key'],
      [['spec.current.issue.check'], 'invalid_spec_route'],
      [['spec.unknown'], 'spec_mode_unsupported'],
      [['spec.current.issue.check.extra'], 'invalid_spec_route'],
      [['spec..issue'], 'invalid_spec_route'],
      [['spec.current.pr'], 'invalid_spec_route'],
      [['spec.current', '--lang', 'fr'], 'unsupported_help_language'],
      [['spec.current.issue.check', 'a.md', 'b.md'], 'invalid_spec_route'],
      [['spec.issue-direct.issue.check', '123'], 'invalid_spec_route'],
    ]) {
      const result = s.invoke(args);
      assert.equal(result.status, 2);
      assert.equal(json(result).error ?? json(result).reason, reason);
    }
    assert.throws(() => parseConfiguration('schema_version = 1\n[workflow]\nmode = "issue-direct"\n'), /config_unsupported_syntax_or_field/);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.dispose(); }
});

test('resource failures require repair and cannot silently fall back to another spec', () => {
  const f = fixture();
  try {
    const s = installation(f), root = join(s.skill, 'spec.issue-direct');
    const path = join(root, 'prompt.en.md'), saved = readFileSync(path, 'utf8');
    for (const name of ['issue.en.yaml', 'issue.zh-CN.yaml', 'prompt.en.md', 'prompt.zh-CN.md']) {
      const resourcePath = join(root, name), content = readFileSync(resourcePath);
      rmSync(resourcePath);
      assert.equal(check(s.diagnose(), 'config.spec.mode').reason, 'spec_resources_missing', name);
      assert.equal(json(s.current()).error, 'spec_resources_missing', name);
      write(resourcePath, content);
    }
    const resourcePath = join(root, 'issue.zh-CN.yaml'), original = readFileSync(resourcePath, 'utf8');
    for (const change of [form => { form.name = ''; }, form => { form.body = []; },
      form => { form.description = []; }, form => { form.body[1].id = form.body[0].id; }]) {
      const form = parseSpecYaml(original); change(form); write(resourcePath, stringifyYaml(form));
      const before = snapshot(f.root), result = s.current();
      assert.equal(result.status, 1);
      const resource = check(s.diagnose(), 'config.spec.mode');
      assert.equal(json(result).checks, undefined);
      assert.equal(json(result).error, resource.reason);
      assert.equal(resource.status, 'invalid');
      assert.equal(resource.details.configured, 'issue-direct');
      assert.equal(realpathSync.native(resource.details.path), realpathSync.native(root));
      assert.equal(resource.reason, 'spec_resources_invalid'); assert.equal(resource.commands, undefined);
      assert.match(resource.hint, /Restore or reinstall/);
      assert.equal(check(s.diagnose(), 'config.spec.mode').reason, resource.reason);
      assert.deepEqual(snapshot(f.root), before);
    }
    write(resourcePath, original); write(path, '');
    assert.equal(json(s.current()).error, 'spec_resources_invalid');
    write(path, saved);
    assert.match(ok(s.current()).stdout, /Prompt source: ` .+prompt\.en\.md `/);
    // Tool repair understands the configuration even if spec assets are absent.
    renameSync(root, root + '.saved');
    ok(adapter(f.root, { action: 'configuration', repositoryRoot: s.target }, { env: { PATH: '' } }));
  } finally { f.dispose(); }
});

test('spec guidance reads resources without probing tools or the remote default branch', async () => {
  const f = fixture();
  try {
    const s = installation(f, chosen + github), git = findGit();
    write(join(toolsRoot(f.root), 'tool-bindings.json'), JSON.stringify({ schema: 'gidd.tool-bindings/v1', platform: 'windows-x64',
      tools: { git: { path: git, source: 'path', version: '2.49.0' } } }));
    const before = snapshot(f.root);
    for (const route of ['spec.current', 'spec.issue-direct', 'spec.current.issue', 'spec.issue-direct.issue']) {
      const result = specCommand(s.target, parseSpecArguments(route, ['--lang', 'zh']));
      assert.equal(result.exitCode, 0);
      if (route.endsWith('.issue')) {
        assert.equal(result.report.scope, s.target);
        assert.equal(Object.hasOwn(result.report, 'checks'), false);
      } else {
        assert.ok(result.markdown.includes(s.target));
        assert.ok(result.markdown.includes('## 1.'));
      }
    }
    assert.deepEqual(snapshot(f.root), before);
    write(join(toolsRoot(f.root), 'tool-bindings.json'), 'broken bindings');
    const result = await specCommand(s.target, parseSpecArguments('spec.current', []));
    assert.equal(result.exitCode, 0, 'Broken tools must not hide resource-only guidance');
    assert.match(result.markdown, /## 1\./);
  } finally { f.dispose(); }
});

test('generated repository link dispatches spec and template commands from any cwd', () => {
  const f = fixture();
  try {
    const s = installation(f);
    const entry = publishRepositoryEntry(s.target, join(s.skill, 'scripts.js/gidd.mjs')).path;
    const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
    const invoke = args => run(cmd, ['/d', '/s', '/c', `""${entry}" ${args}"`], {
      windowsVerbatimArguments: true, cwd: f.root, env: { PATH: '', GIDD_LANG: 'en', GIT_DIR: join(f.root, 'unrelated.git') },
    });
    const before = snapshot(f.root), result = ok(invoke('spec.current'));
    assert.deepEqual(json(ok(invoke('spec.list'))).names, ['issue-direct']);
    const scope = /^Scope: ` (.+) ` {2}\r?$/m.exec(result.stdout)?.[1];
    assert.ok(scope, result.stdout);
    assert.equal(realpathSync.native(scope), realpathSync.native(s.target));
    assert.match(result.stdout, /Prompt source: ` .+prompt\.en\.md `/);
    assert.match(result.stdout, /## 1\./);
    assert.equal(json(ok(invoke('spec.current.issue'))).form.body[2].attributes.label, 'Acceptance criteria');
    assert.equal(json(ok(invoke('spec.issue-direct.issue'))).form.body[2].attributes.label, 'Acceptance criteria');
    assert.equal(json(invoke('spec.current --repository elsewhere')).reason, 'repository_override_forbidden');
    assert.equal(json(invoke('spec.list --repository elsewhere')).reason, 'repository_override_forbidden');
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.dispose(); }
});

test('doctor validates both native forms and follows edited labels and placeholders', () => {
  const f = fixture();
  try {
    const s = installation(f), root = join(s.skill, 'spec.issue-direct');
    const path = join(root, 'issue.en.yaml'), original = readFileSync(path, 'utf8');
    rmSync(path);
    assert.equal(check(s.diagnose(), 'config.spec.mode').reason, 'spec_resources_missing');
    for (const change of [form => { form.body[0].validations.required = 'yes'; },
      form => { form.body[1].id = form.body[0].id; }, form => { form.body[0].attributes.label = 'Scope'; },
      form => { form.body[2].min_task_items = -1; }, form => { form.body[0].validations.requiredd = true; },
      form => { form.body.reverse(); }]) {
      const form = parseSpecYaml(original); change(form); write(path, stringifyYaml(form));
      assert.equal(check(s.diagnose(), 'config.spec.mode').reason, 'spec_resources_invalid');
    }
    const updated = parseSpecYaml(original);
    updated.body[0].attributes.label = 'Expected outcome';
    updated.body[0].attributes.placeholder = 'Describe the new expected outcome.';
    write(path, stringifyYaml(updated));
    assert.equal(check(s.diagnose(), 'config.spec.mode').status, 'ready');
    const form = json(ok(s.invoke(['spec.current.issue', '--lang', 'en']))).form;
    assert.deepEqual(form, updated);
  } finally { f.dispose(); }
});

test('native YAML forms and localized workflow instructions preserve their structure', () => {
  const root = join(repo, '.agents/skills/gidd/spec.issue-direct');
  assert.deepEqual(readdirSync(root).sort(), ['issue.en.yaml', 'issue.zh-CN.yaml', 'prompt.en.md', 'prompt.zh-CN.md']);
  const spec = loadSpec('issue-direct'), { issueForms } = spec;
  assert.deepEqual(issueForms.en.body.map(field => field.id), ['goal', 'scope', 'acceptance', 'validation', 'delivery']);
  for (const lang of ['en', 'zh-CN']) {
    const form = issueForms[lang];
    assert.deepEqual(form, parseSpecYaml(readFileSync(join(root, 'issue.' + lang + '.yaml'), 'utf8')));
    assert.equal(form.body.length, 5);
    assert.equal(form.body[2].type, 'textarea');
    assert.ok(form.body[0].attributes.placeholder);
    assert.ok(form.body.at(-1).attributes.description);
    assert.equal(form.body[2].attributes.value.split('\n').length, 2);
    const prompt = readFileSync(join(root, 'prompt.' + lang + '.md'), 'utf8');
    assert.equal(spec.prompts[lang].content, prompt);
    assert.equal(realpathSync.native(spec.prompts[lang].path), realpathSync.native(join(root, 'prompt.' + lang + '.md')));
    assert.match(prompt, /^# /);
    assert.match(prompt, /gidd\.link spec\.issue-direct\.issue/);
  }
  const yaml = '# comment\nurl: https://example.test/a#b\ntext: |-\n  First: # literal\n  Second line\nitems: [one, two]\n';
  assert.deepEqual(parseSpecYaml(yaml), { url: 'https://example.test/a#b', text: 'First: # literal\nSecond line', items: ['one', 'two'] });
  for (const text of ['key: one\nkey: two', 'text: [unclosed', '---\none: 1\n---\ntwo: 2',
    'text: !unknown value', 'first: &shared text\nsecond: *shared', '%YAML 1.1\n---\nvalue: true',
    '? [one, two]\n: value', 'section:\n\tkey: value']) assert.throws(() => parseSpecYaml(text), undefined, text);
});

test('forms reject invalid native fields, translation drift and misplaced GIDD checks', () => {
  const spec = loadSpec('issue-direct');
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
  const spec = loadSpec('issue-direct'), forms = structuredClone(spec.issueForms);
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

test('doctor and spec readers reject broken Markdown files and malformed form YAML', () => {
  const f = fixture();
  try {
    const s = installation(f), root = join(s.skill, 'spec.issue-direct');
    for (const [name, failures] of [
      ['prompt.en.md', ['', '  \n\t', 'text\0hidden', Buffer.from([0xff]), Buffer.alloc(65537, 0x61)]],
      ['issue.en.yaml', ['name: one\nname: duplicate', 'body: [unclosed', '---\none: 1\n---\ntwo: 2', 'name: !unknown value']],
    ]) {
      const path = join(root, name), original = readFileSync(path);
      for (const text of failures) {
        write(path, text);
        const before = snapshot(f.root);
        assert.equal(check(s.diagnose(), 'config.spec.mode').reason, 'spec_resources_invalid');
        for (const route of ['spec.current', 'spec.issue-direct.issue']) {
          const result = s.invoke([route, '--lang', 'zh']);
          assert.equal(result.status, route === 'spec.current' ? 1 : 2);
          assert.equal(result.stderr, '');
          assert.equal(json(result).error, 'spec_resources_invalid');
          assert.equal(result.stdout.trim(), JSON.stringify(json(result), null, 2));
        }
        assert.deepEqual(snapshot(f.root), before);
      }
      write(path, original);
    }
    // Markdown is authored freely, including tables, code and headings that differ by language.
    const prompt = '# Custom guidance\n\n| Step | Action |\n| --- | --- |\n| 1 | Read the Issue |\n\n~~~sh\ngit status\n~~~';
    write(join(root, 'prompt.en.md'), prompt);
    assert.equal(check(s.diagnose(), 'config.spec.mode').status, 'ready');
    assert.ok(ok(s.current('--lang', 'en')).stdout.endsWith(prompt));
  } finally { f.dispose(); }
});
