import { test } from 'node:test';
import { renameSync } from 'node:fs';
import { configure } from '../.agents/skills/gidd/scripts/config.mjs';
import { parseConfiguration } from '../.agents/skills/gidd/scripts/storage.mjs';
import { specCommand, parseSpecArguments } from '../.agents/skills/gidd/scripts/spec.mjs';
import { publishRepositoryEntry } from '../.agents/skills/gidd/scripts/repository-entry.mjs';
import { adapter, assert, copySkill, existsSync, findGit, fixture, join, json, mkdirSync, ok,
  readFileSync, rmSync, run, snapshot, toolsRoot, write } from './support/helpers.mjs';

const chosen = 'schema_version = 1\n[spec]\nmode = "issue-direct"\n';
const github = '[github]\nhostname = "github.com"\nrepository = "https://github.com/owner/repo"\nremote = "origin"\n';
const configPath = root => join(root, '.agents/skills/gidd/config.toml');
function installation(f, config = chosen) {
  const skill = join(f.root, "installed skill 中文 & ' spaces");
  const target = join(f.root, 'target'), elsewhere = join(f.root, 'elsewhere');
  copySkill(skill); mkdirSync(join(target, '.git'), { recursive: true }); mkdirSync(elsewhere);
  if (config !== null) write(configPath(target), config);
  const invoke = (args, options = {}) => run(process.execPath,
    [join(skill, 'scripts/gidd.mjs'), ...args, '--repository', target],
    { cwd: elsewhere, ...options, env: { PATH: '', GIDD_LANG: 'en', ...options.env } });
  const current = (...args) => invoke(['spec', 'current', '--json', ...args]);
  const diagnose = () => json(invoke(['doctor', '--offline']));
  return { skill, target, invoke, current, diagnose };
}
const check = (report, id) => report.checks.find(item => item.id === id);

test('spec mode editing preserves text and remains readable by both bootstrap parsers', () => {
  const f = fixture();
  try {
    const path = configPath(f.root);
    assert.throws(() => configure(f.root, 'set', 'spec.mode', 'issue-pr'), /spec_mode_unsupported/);
    assert.equal(existsSync(path), false);
    for (const newline of ['\n', '\r\n']) {
      const text = '\uFEFF' + ['# 用户注释', 'schema_version = 1', '[spec] # choice',
        "  mode = 'unknown-mode' # preserve", '[github]', 'account = "bad account"', '[tools]', ''].join(newline);
      write(path, text);
      ok(adapter(f.root, { action: 'configuration', repositoryRoot: f.root }, { env: { PATH: '' } }));
      assert.equal(parseConfiguration(text).spec.mode, 'unknown-mode');
      configure(f.root, 'set', 'spec.mode', 'issue-direct');
      assert.equal(readFileSync(path, 'utf8'), text.replace("'unknown-mode'", '"issue-direct"'));
      configure(f.root, 'set', 'github.account', 'Octocat');
      assert.equal(parseConfiguration(configure(f.root, 'show').content).spec.mode, 'issue-direct');
      ok(adapter(f.root, { action: 'configuration', repositoryRoot: f.root }, { env: { PATH: '' } }));
    }
    for (const text of ['schema_version = 1\n', 'schema_version = 1\n[spec]\n# select here\n[tools]\n']) {
      write(path, text); configure(f.root, 'set', 'spec.mode', 'issue-direct');
      assert.equal(parseConfiguration(readFileSync(path, 'utf8')).spec.mode, 'issue-direct');
    }
    for (const tail of ['mode = true\n', 'mode = "a"\nmode = "b"\n', 'unknown = "x"\n', '[spec]\n']) {
      const text = 'schema_version = 1\n[spec]\n' + tail;
      write(path, text);
      assert.throws(() => parseConfiguration(text), /config_/);
      assert.notEqual(adapter(f.root, { action: 'configuration', repositoryRoot: f.root }, { env: { PATH: '' } }).status, 0);
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
      assert.equal(result.status, 1); assert.equal(report.mode, undefined);
      const mode = check(report, 'config.spec.mode');
      assert.equal(mode.reason, text?.includes('issue-pr') ? 'spec_mode_unsupported' : 'spec_mode_missing');
      assert.deepEqual(mode.details.available_modes, ['issue-direct']);
      assert.deepEqual(mode.commands[0].args, ['config', 'set', 'spec.mode', 'issue-direct']);
      const diagnosis = s.diagnose();
      assert.equal(check(diagnosis, 'spec.resources').status, 'not_checked');
      if (text !== null) assert.equal(check(diagnosis, 'config.spec.mode').reason, mode.reason);
      else assert.equal(check(diagnosis, 'config.spec.mode').blocked_by, 'config_file');
      assert.deepEqual(snapshot(f.root), before);
    }
    configure(s.target, 'set', 'spec.mode', 'issue-direct');
    assert.equal(check(s.diagnose(), 'config.spec.mode').status, 'ready');
    assert.equal(check(s.diagnose(), 'spec.resources').status, 'ready');
    assert.equal(json(ok(s.current())).mode, 'issue-direct');
  } finally { f.dispose(); }
});

test('spec defaults to current and provides localized offline guidance and templates without tools or GitHub identity', () => {
  const f = fixture();
  try {
    const s = installation(f), before = snapshot(f.root);
    for (const [lang, prompt, template] of [['zh', /不要求开发分支、PR 或独立审批/, /## 验收条件/],
      ['en', /independent approval are not required/, /## Acceptance criteria/]]) {
      const report = json(ok(s.current('--lang', lang)));
      assert.equal(report.read_only, true); assert.equal(report.target.branch, null);
      assert.match(report.instructions, prompt);
      assert.ok(report.helpers.every(helper => !helper.available));
      assert.deepEqual(json(ok(s.invoke(['spec', '--json', '--lang', lang]))), report);
      assert.equal(ok(s.invoke(['spec', '--lang', lang])).stdout, ok(s.invoke(['spec', 'current', '--lang', lang])).stdout);
      assert.match(ok(s.invoke(['spec', 'current', '--lang', lang])).stdout, prompt);
      assert.match(ok(s.invoke(['spec', 'template', 'issue', '--lang', lang])).stdout, template);
      assert.match(json(ok(s.invoke(['spec', 'template', 'issue', '--json', '--lang', lang]))).content, template);
    }
    assert.equal(ok(s.invoke(['spec'])).stdout, ok(s.invoke(['spec', 'current'])).stdout);
    assert.match(ok(s.invoke(['spec'], { env: { GIDD_LANG: 'zh-CN' } })).stdout, /当前规范/);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.dispose(); }
});

test('unknown arguments and retired names are rejected without changing files', () => {
  const f = fixture();
  try {
    const s = installation(f), before = snapshot(f.root);
    for (const args of [['unknown'], ['current', 'extra'], ['current', '--json', '--json'], ['current', '--lang'],
      ['--json', '--json'], ['--lang'], ['--lang', 'fr'], ['--unknown'], ['--json', 'current'],
      ['current', '--lang', 'fr'], ['current', '--lang', 'en', '--lang', 'zh'], ['template'], ['template', '../secret']]) {
      const result = s.invoke(['spec', ...args]);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.equal(json(result).schema, 'gidd.spec/v1');
    }
    for (const [args, reason] of [
      [['workflow', 'current'], 'unknown_command'],
      [['config', 'set', 'workflow.mode', 'issue-direct'], 'config_unknown_key'],
    ]) {
      const result = s.invoke(args);
      assert.equal(result.status, 2);
      assert.equal(json(result).reason, reason);
    }
    assert.throws(() => parseConfiguration('schema_version = 1\n[workflow]\nmode = "issue-direct"\n'), /config_unsupported_syntax_or_field/);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.dispose(); }
});

test('resource failures require repair and cannot silently fall back to another spec', () => {
  const f = fixture();
  try {
    const s = installation(f), root = join(s.skill, 'specs/issue-direct');
    const path = join(root, 'prompts/en.md'), saved = readFileSync(path, 'utf8');
    rmSync(path);
    assert.equal(check(s.diagnose(), 'spec.resources').reason, 'spec_resources_missing');
    assert.equal(check(json(s.current()), 'spec.resources').reason, 'spec_resources_missing');
    write(path, saved);
    const definitionPath = join(root, 'definition.json'), original = readFileSync(definitionPath, 'utf8');
    for (const change of [d => { d.helpers.push('unimplemented.issue.helper'); },
      d => { d.prompts.en = '../outside.md'; }, d => { d.id = 'issue-pr'; }]) {
      const definition = JSON.parse(original); change(definition); write(definitionPath, JSON.stringify(definition));
      const before = snapshot(f.root), result = s.current();
      assert.equal(result.status, 1);
      const resource = check(json(result), 'spec.resources');
      assert.equal(resource.reason, 'spec_resources_invalid'); assert.equal(resource.commands, undefined);
      assert.match(resource.hint, /Restore or reinstall/);
      assert.equal(check(s.diagnose(), 'spec.resources').reason, resource.reason);
      assert.deepEqual(snapshot(f.root), before);
    }
    write(definitionPath, original); write(path, '');
    assert.equal(check(json(s.current()), 'spec.resources').reason, 'spec_resources_invalid');
    write(path, saved);
    assert.equal(json(ok(s.current())).mode, 'issue-direct');
    // Tool repair understands the configuration even if spec assets are absent.
    renameSync(root, root + '.saved');
    ok(adapter(f.root, { action: 'configuration', repositoryRoot: s.target }, { env: { PATH: '' } }));
  } finally { f.dispose(); }
});

test('helpers use bound tools and repository identity; default branch comes only from a local remote HEAD', async () => {
  const f = fixture();
  try {
    const s = installation(f, chosen + github), git = findGit(), gh = join(f.root, 'unused-gh.exe');
    write(gh, 'not executed');
    write(join(s.target, '.agents/skills/gidd/gidd.link.cmd'), '@echo off\r\n');
    write(join(toolsRoot(f.root), 'tool-bindings.json'), JSON.stringify({ schema: 'gidd.tool-bindings/v1', platform: 'windows-x64',
      tools: { git: { path: git, source: 'path', version: '2.49.0' }, gh: { path: gh, source: 'path', version: '2.98.0' } } }));
    const before = snapshot(f.root), calls = [];
    const result = await specCommand(s.target, parseSpecArguments(['current', '--lang', 'zh']), {
      execute: async (exe, args) => {
        calls.push({ exe, args });
        assert.equal(exe, git); assert.deepEqual(args, ['-C', s.target, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
        return { ok: true, text: 'refs/remotes/origin/trunk' };
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(result.report.target, { branch: 'trunk', source: 'local_remote_head', remote_verified: false });
    const commands = result.report.helpers;
    assert.ok(commands.every(h => h.available));
    const create = commands.find(h => h.id === 'github.issue.create');
    assert.equal(create.executable, gh); assert.equal(create.effect, 'write');
    assert.deepEqual(create.required_inputs, ['title', 'file']);
    assert.equal(create.args.at(-1), 'github.com/owner/repo');
    assert.match(result.text, /本地远程 HEAD 记录，未联网确认/);
    assert.deepEqual(snapshot(f.root), before);
    const unknown = await specCommand(s.target, parseSpecArguments(['current']), {
      execute: async () => ({ ok: false, text: '' }),
    });
    assert.equal(unknown.report.target.branch, null);
    const broken = await specCommand(s.target, parseSpecArguments(['current']), {
      execute: async () => ({ ok: false, reason: 'process_start_failed', text: '' }),
    });
    assert.equal(broken.report.status, 'ready', 'A broken Git executable must not hide the spec guidance');
    assert.equal(broken.report.target.branch, null);
  } finally { f.dispose(); }
});

test('generated repository link dispatches spec and its template helper from any cwd', () => {
  const f = fixture();
  try {
    const s = installation(f);
    const entry = publishRepositoryEntry(s.target, join(s.skill, 'scripts/gidd.mjs')).path;
    write(join(toolsRoot(f.root), 'js_exec.cmd'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"' + process.execPath.replaceAll('%', '%%') + '" %*\r\nexit /b %ERRORLEVEL%\r\n');
    const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
    const invoke = args => run(cmd, ['/d', '/s', '/c', `""${entry}" ${args}"`], {
      windowsVerbatimArguments: true, cwd: f.root, env: { PATH: '', GIDD_LANG: 'en', GIT_DIR: join(f.root, 'unrelated.git') },
    });
    const before = snapshot(f.root), report = json(ok(invoke('spec --json')));
    assert.deepEqual(json(ok(invoke('spec current --json'))), report);
    assert.match(ok(invoke('spec')).stdout, /Current spec/);
    assert.equal(report.repository, s.target);
    const helper = report.helpers.find(h => h.id === 'spec.template.issue');
    assert.equal(helper.executable, entry); assert.equal(helper.available, true);
    assert.match(ok(invoke(helper.args.join(' '))).stdout, /## Acceptance criteria/);
    assert.equal(json(invoke('spec current --repository elsewhere')).reason, 'repository_override_forbidden');
    assert.equal(json(invoke('spec --repository elsewhere')).reason, 'repository_override_forbidden');
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.dispose(); }
});
