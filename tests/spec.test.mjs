import { test } from 'node:test';
import { realpathSync, renameSync } from 'node:fs';
import { configure } from '../.agents/skills/gidd/scripts/config.mjs';
import { parseConfiguration } from '../.agents/skills/gidd/scripts/storage.mjs';
import { specCommand, parseSpecArguments } from '../.agents/skills/gidd/scripts/spec.mjs';
import { publishRepositoryEntry, runRepositoryCommand } from './support/repository.mjs';
import { loadSpec } from '../.agents/skills/gidd/scripts/specs.mjs';
import { checkIssueMarkdown } from '../.agents/skills/gidd/scripts/issue-check.mjs';
import { adapter, assert, bindFixture, compile, copySkill, dirname, existsSync, findGit, fixture, join, json, mkdirSync, ok,
  readFileSync, rmSync, run, snapshot, stub, toolsRoot, write } from './support/helpers.mjs';

const chosen = 'schema_version = 1\n[spec]\nmode = "issue-direct"\n';
const github = '[repo]\nremote.url = "https://github.com/owner/repo"\nremote.name = "origin"\n';
const configPath = root => join(root, '.agents/skills/gidd/config.toml');
function installation(f, config = chosen) {
  const skill = join(f.root, "installed skill 中文 & ' spaces");
  const target = join(f.root, 'target'), elsewhere = join(f.root, 'elsewhere');
  copySkill(skill); mkdirSync(join(target, '.git'), { recursive: true }); mkdirSync(elsewhere);
  if (config !== null) write(configPath(target), config);
  ok(adapter(f.root,{action:'bootstrap',repositoryRoot:target,responses:{},downloads:{},yes:true},{env:{PATH:dirname(process.execPath)}}));
  publishRepositoryEntry(target,join(skill,'scripts/gidd.mjs'));
  const invoke = (args, options = {}) => runRepositoryCommand(target, args,
    { cwd: elsewhere, ...options, env: { PATH: '', GIDD_LANG: 'en', ...options.env } });
  const current = (...args) => invoke(['spec.current', '--json', ...args]);
  const diagnose = () => json(invoke(['doctor', '--offline']));
  return { skill, target, invoke, current, diagnose };
}
const check = (report, id) => report.checks.find(item => item.id === id);
const validIssue = '## Goal\nShow the selected spec.\n\n## Scope\nUpdate the CLI and its help.\n\n## Acceptance criteria\n- [ ] Listing prints the installed spec names.\n\n## Validation\n```powershell\ndev.cmd .test spec\n```\n\n## Delivery record\n';

test('spec mode editing preserves text while preparation ignores business configuration', () => {
  const f = fixture();
  try {
    const path = configPath(f.root);
    assert.throws(() => configure(f.root, 'set', 'spec.mode', 'issue-pr'), /spec_mode_unsupported/);
    assert.equal(existsSync(path), false);
    for (const newline of ['\n', '\r\n']) {
      const text = '\uFEFF' + ['# 用户注释', 'schema_version = 1', '[spec] # choice',
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
      assert.equal(result.status, 1); assert.equal(report.mode, undefined);
      assert.equal(report.checks.length, 1);
      const mode = check(report, 'config.spec.mode');
      assert.equal(mode.reason, text?.includes('issue-pr') ? 'spec_mode_unsupported' : 'spec_mode_missing');
      assert.deepEqual(mode.details.available_modes, ['issue-direct']);
      assert.deepEqual(mode.commands[0].args, ['config', 'set', 'spec.mode', 'issue-direct']);
      const diagnosis = s.diagnose();
      if (text !== null) assert.equal(check(diagnosis, 'config.spec.mode').reason, mode.reason);
      else assert.equal(check(diagnosis, 'config.spec.mode').blocked_by, 'config.toml');
      assert.deepEqual(snapshot(f.root), before);
    }
    configure(s.target, 'set', 'spec.mode', 'issue-direct');
    assert.equal(check(s.diagnose(), 'config.spec.mode').status, 'ready');
    assert.deepEqual(check(s.diagnose(), 'config.spec.mode').details, { configured: 'issue-direct', version: 1 });
    assert.equal(json(ok(s.current())).mode, 'issue-direct');
  } finally { f.dispose(); }
});

test('successful offline doctor guarantees current spec and localized templates are readable', () => {
  const f = fixture();
  try {
    const s = installation(f, chosen + github + 'remote.account = "Octocat"\n');
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
        const report = json(ok(s.current('--lang', lang)));
        assert.equal(report.status, 'ready');
        assert.ok(report.instructions.trim());
        assert.ok(ok(s.invoke(['spec.current', '--lang', lang])).stdout.trim());
        assert.ok(ok(s.invoke(['spec.current.issue', '--lang', lang])).stdout.trim());
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

test('list and named specs work without selection; current and templates are localized and read-only', () => {
  const f = fixture();
  try {
    const s = installation(f), before = snapshot(f.root);
    for (const [lang, prompt, template] of [['zh', /不要求开发分支、PR 或独立审批/, /## 验收条件/],
      ['en', /independent approval are not required/, /## Acceptance criteria/]]) {
      const report = json(ok(s.current('--lang', lang)));
      assert.equal(report.read_only, true); assert.equal(report.target.branch, null);
      assert.match(report.instructions, prompt);
      assert.equal(Object.hasOwn(report, 'helpers'), false);
      assert.deepEqual(json(ok(s.invoke(['spec', '--json', '--lang', lang]))).names, ['issue-direct']);
      assert.match(ok(s.invoke(['spec.current', '--lang', lang])).stdout, prompt);
      assert.match(ok(s.invoke(['spec.current.issue', '--lang', lang])).stdout, template);
      assert.match(json(ok(s.invoke(['spec.current.issue', '--json', '--lang', lang]))).content, template);
    }
    assert.equal(ok(s.invoke(['spec'])).stdout.trim(), 'issue-direct');
    assert.match(ok(s.invoke(['spec.current'], { env: { GIDD_LANG: 'zh-CN' } })).stdout, /规范/);
    assert.deepEqual(snapshot(f.root), before);
    for (const text of ['', 'schema_version = 1\n', 'schema_version = 1\n[spec]\nmode = "unavailable"\n']) {
      write(configPath(s.target), text);
      const saved = snapshot(f.root);
      assert.deepEqual(json(ok(s.invoke(['spec', '--json']))).names, ['issue-direct']);
      assert.equal(json(ok(s.invoke(['spec.issue-direct', '--json']))).mode, 'issue-direct');
      assert.match(ok(s.invoke(['spec.issue-direct.issue'])).stdout, /## Acceptance criteria/);
      assert.deepEqual(snapshot(f.root), saved);
    }
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
      [['spec.current.issue.check'], 'issue_source_required'],
      [['spec.unknown'], 'spec_mode_unsupported'],
      [['spec.current.issue.check.extra'], 'invalid_spec_route'],
      [['spec..issue'], 'invalid_spec_route'],
      [['spec.current.pr'], 'invalid_spec_route'],
      [['spec.current', '--lang', 'fr'], 'unsupported_help_language'],
      [['spec.current.issue.check', 'a.md', 'b.md'], 'invalid_arguments'],
    ]) {
      const result = s.invoke([...args, ...(args[0].startsWith('spec.') ? ['--json'] : [])]);
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
    const s = installation(f), root = join(s.skill, 'spec.issue-direct');
    const path = join(root, 'prompt.en.md'), saved = readFileSync(path, 'utf8');
    rmSync(path);
    assert.equal(check(s.diagnose(), 'config.spec.mode').reason, 'spec_resources_missing');
    assert.equal(check(json(s.current()), 'config.spec.mode').reason, 'spec_resources_missing');
    write(path, saved);
    const definitionPath = join(root, 'definition.json'), original = readFileSync(definitionPath, 'utf8');
    for (const change of [d => { d.version = 2; },
      d => { d.prompts.en = '../outside.md'; }, d => { d.id = 'issue-pr'; }, d => { delete d.checks; }]) {
      const definition = JSON.parse(original); change(definition); write(definitionPath, JSON.stringify(definition));
      const before = snapshot(f.root), result = s.current();
      assert.equal(result.status, 1);
      const resource = check(json(result), 'config.spec.mode');
      assert.equal(json(result).checks.length, 1);
      assert.equal(resource.status, 'invalid');
      assert.equal(resource.details.configured, 'issue-direct');
      assert.equal(realpathSync.native(resource.details.path), realpathSync.native(root));
      assert.equal(resource.reason, 'spec_resources_invalid'); assert.equal(resource.commands, undefined);
      assert.match(resource.hint, /Restore or reinstall/);
      assert.equal(check(s.diagnose(), 'config.spec.mode').reason, resource.reason);
      assert.deepEqual(snapshot(f.root), before);
    }
    write(definitionPath, original); write(path, '');
    assert.equal(check(json(s.current()), 'config.spec.mode').reason, 'spec_resources_invalid');
    write(path, saved);
    assert.equal(json(ok(s.current())).mode, 'issue-direct');
    // Tool repair understands the configuration even if spec assets are absent.
    renameSync(root, root + '.saved');
    ok(adapter(f.root, { action: 'configuration', repositoryRoot: s.target }, { env: { PATH: '' } }));
  } finally { f.dispose(); }
});

test('default branch comes only from a local remote HEAD and spec output contains no command helpers', async () => {
  const f = fixture();
  try {
    const s = installation(f, chosen + github), git = findGit();
    write(join(toolsRoot(f.root), 'tool-bindings.json'), JSON.stringify({ schema: 'gidd.tool-bindings/v1', platform: 'windows-x64',
      tools: { git: { path: git, source: 'path', version: '2.49.0' } } }));
    const before = snapshot(f.root), calls = [];
    const result = await specCommand(s.target, parseSpecArguments('spec.current', [ '--lang', 'zh']), {
      execute: async (exe, args) => {
        calls.push({ exe, args });
        assert.equal(exe, git); assert.deepEqual(args, ['-C', s.target, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
        return { ok: true, text: 'refs/remotes/origin/trunk' };
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(result.report.target, { branch: 'trunk', source: 'local_remote_head', remote_verified: false });
    assert.equal(Object.hasOwn(result.report, 'helpers'), false);
    assert.doesNotMatch(result.text, /helper|gh\.exe|required_inputs/i);
    assert.match(result.text, /本地远程 HEAD 记录，未联网确认/);
    assert.deepEqual(snapshot(f.root), before);
    const unknown = await specCommand(s.target, parseSpecArguments('spec.current', []), {
      execute: async () => ({ ok: false, text: '' }),
    });
    assert.equal(unknown.report.target.branch, null);
    const broken = await specCommand(s.target, parseSpecArguments('spec.current', []), {
      execute: async () => ({ ok: false, reason: 'process_start_failed', text: '' }),
    });
    assert.equal(broken.report.status, 'ready', 'A broken Git executable must not hide the spec guidance');
    assert.equal(broken.report.target.branch, null);
  } finally { f.dispose(); }
});

test('generated repository link dispatches spec and template commands from any cwd', () => {
  const f = fixture();
  try {
    const s = installation(f);
    const entry = publishRepositoryEntry(s.target, join(s.skill, 'scripts/gidd.mjs')).path;
    const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
    const invoke = args => run(cmd, ['/d', '/s', '/c', `""${entry}" ${args}"`], {
      windowsVerbatimArguments: true, cwd: f.root, env: { PATH: '', GIDD_LANG: 'en', GIT_DIR: join(f.root, 'unrelated.git') },
    });
    write(join(f.root, 'issue draft.md'), validIssue);
    const before = snapshot(f.root), report = json(ok(invoke('spec.current --json')));
    assert.deepEqual(json(ok(invoke('spec --json'))).names, ['issue-direct']);
    assert.match(ok(invoke('spec.current')).stdout, /Spec/);
    assert.equal(realpathSync.native(report.repository), realpathSync.native(s.target));
    assert.equal(Object.hasOwn(report, 'helpers'), false);
    assert.match(ok(invoke('spec.current.issue')).stdout, /## Acceptance criteria/);
    assert.match(ok(invoke('spec.issue-direct.issue')).stdout, /## Acceptance criteria/);
    assert.equal(json(ok(invoke('spec.current.issue.check "issue draft.md" --json'))).status, 'passed');
    assert.equal(json(invoke('spec.current --repository elsewhere')).reason, 'repository_override_forbidden');
    assert.equal(json(invoke('spec --repository elsewhere')).reason, 'repository_override_forbidden');
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.dispose(); }
});

test('Issue body checks support both templates and distinguish placeholders, empty content and examples', () => {
  const spec = loadSpec('issue-direct');
  const errors = body => checkIssueMarkdown(body, spec.issueRules).filter(item => item.status === 'failed');
  assert.deepEqual(errors(validIssue), []);
  assert.deepEqual(errors(validIssue.replace('[ ]', '[x]')), []);
  for (const marker of ['- [ ]\t', '- [X]  ', '1. [x] ', '* [\t] ']) {
    assert.deepEqual(errors(validIssue.replace('- [ ] ', marker)), [], marker);
  }
  for (const marker of ['- [ ]', '- [x]', '- [X]']) {
    assert.equal(errors(validIssue.replace('- [ ] ', marker))[0].reason, 'acceptance_items_missing', marker);
  }
  assert.deepEqual(errors(validIssue.replace('## Goal', 'Goal\n----')), []);
  const zh = validIssue.replace('## Goal', '## 目标').replace('## Scope', '## 范围')
    .replace('## Acceptance criteria', '## 验收条件').replace('## Validation', '## 验证方式').replace('## Delivery record', '## 完成记录');
  assert.deepEqual(errors(zh), []);
  for (const template of Object.values(spec.templates)) {
    assert.equal(errors(template).filter(item => item.reason === 'placeholder_remaining').length, 4);
  }
  assert.equal(errors('').filter(item => item.reason === 'section_missing').length, 4);
  for (const example of ['```md\n' + validIssue + '\n```', '~~~md\n' + validIssue + '\n~~~',
    validIssue.split('\n').map(line => '> ' + line).join('\n'), '<!--\n' + validIssue + '\n-->',
    validIssue.split('\n').map(line => '    ' + line).join('\n')]) {
    assert.ok(errors(example).some(item => item.reason === 'section_missing'));
  }
  assert.ok(errors('<div>\n' + validIssue.replaceAll('\n\n', '\n').replace(/```[\s\S]*?```/, 'Run the tests.') + '\n</div>').some(item => item.reason === 'section_missing'));
  const noTasks = validIssue.replace('- [ ] Listing prints the installed spec names.', '```md\n- [ ] Example only\n```');
  assert.equal(errors(noTasks)[0].reason, 'acceptance_items_missing');
  assert.equal(errors(validIssue.replace('Show the selected spec.', '<!-- hidden -->'))[0].reason, 'section_empty');
  assert.equal(errors(validIssue.replace('Show the selected spec.', 'TODO'))[0].line, 2);
  assert.equal(errors(validIssue.replace('Show the selected spec.', '- [TODO](https://example.test)'))[0].reason, 'placeholder_remaining');
  assert.ok(errors(validIssue.replace('Listing prints the installed spec names.', '<span></span>')).length);
  for (const marker of ['[', '<']) assert.equal(errors(validIssue.replace('Show the selected spec.', marker.repeat(30000)))[0].reason, 'section_empty');
  assert.equal(errors(validIssue + '\n## 目标\nAnother goal\n')[0].reason, 'section_duplicate');
});

test('local Issue checks resolve relative paths from cwd and return distinct validation and reading exit codes', () => {
  const f = fixture();
  try {
    const s = installation(f), path = join(f.root, 'draft issue.md');
    write(path, validIssue);
    const before = snapshot(f.root);
    const valid = s.invoke(['spec.current.issue.check', '../draft issue.md', '--json']);
    assert.equal(valid.status, 0);
    assert.equal(json(valid).status, 'passed');
    assert.equal(json(valid).scope, 'issue_body');
    assert.equal(json(valid).source.path, path);
    assert.equal(json(valid).read_only, true);
    assert.deepEqual(snapshot(f.root), before);
    write(path, validIssue.replace('- [ ] ', '- [ ]'));
    const malformed = s.invoke(['spec.current.issue.check', path, '--json']);
    assert.equal(malformed.status, 1);
    assert.ok(json(malformed).checks.some(item => item.reason === 'acceptance_items_missing'));
    write(path, loadSpec('issue-direct').templates.en);
    const invalid = s.invoke(['spec.issue-direct.issue.check', path, '--json']);
    assert.equal(invalid.status, 1); assert.equal(json(invalid).status, 'failed');
    assert.ok(json(invalid).checks.some(item => item.line && item.hint));
    for (const source of ['missing.md', s.target, '#0', '#bad', '999999999999999999999']) {
      const result = s.invoke(['spec.current.issue.check', source, '--json']);
      assert.equal(result.status, 2, source); assert.equal(json(result).status, 'error');
    }
    write(path, Buffer.from([0xff]));
    assert.equal(json(s.invoke(['spec.current.issue.check', path, '--json'])).reason, 'issue_source_invalid_utf8');
    write(path, Buffer.alloc(1024 * 1024 + 1));
    assert.equal(json(s.invoke(['spec.current.issue.check', path, '--json'])).reason, 'issue_source_too_large');
    write(path, validIssue); write(configPath(s.target), 'broken configuration');
    assert.equal(s.invoke(['spec.issue-direct.issue.check', path]).status, 0, 'Named local checks do not depend on current selection or GitHub');
    assert.equal(s.invoke(['spec.current.issue.check', path]).status, 2);
  } finally { f.dispose(); }
});

test('rule resources are validated by doctor and template structure stays consistent with rules', () => {
  const f = fixture();
  try {
    const s = installation(f), root = join(s.skill, 'spec.issue-direct');
    const rulesPath = join(root, 'issue.json'), original = readFileSync(rulesPath, 'utf8');
    rmSync(rulesPath);
    assert.equal(check(s.diagnose(), 'config.spec.mode').reason, 'spec_resources_missing');
    for (const change of [rules => { rules.sections[0].required = 'yes'; },
      rules => { rules.sections[1].id = rules.sections[0].id; },
      rules => { rules.sections[0].headings.en = 'Scope'; }, rules => { rules.sections[2].min_task_items = -1; },
      rules => { rules.sections[0].requiredd = true; }]) {
      const rules = JSON.parse(original); change(rules); write(rulesPath, JSON.stringify(rules));
      assert.equal(check(s.diagnose(), 'config.spec.mode').reason, 'spec_resources_invalid');
    }
    write(rulesPath, original);
    write(join(root, 'issue.en.md'), '## Goal\nOnly one section');
    assert.equal(check(s.diagnose(), 'config.spec.mode').reason, 'spec_resources_invalid');
  } finally { f.dispose(); }
});

test('GitHub Issue checks verify repository and identity, read only, and share the local body validator', async () => {
  const f = fixture();
  try {
    const s = installation(f, chosen + github + 'remote.account = "Octocat"\n');
    const git = join(f.root, 'git.exe'), gh = join(f.root, 'gh.exe');
    write(git, 'mock'); write(gh, 'mock');
    write(join(toolsRoot(f.root), 'tool-bindings.json'), JSON.stringify({ schema: 'gidd.tool-bindings/v1', platform: 'windows-x64',
      tools: { git: { path: git, source: 'path', version: '2.49.0' }, gh: { path: gh, source: 'path', version: '2.98.0' } } }));
    let remote = 'https://github.com/owner/repo.git', account = 'Octocat';
    let issue = { body: validIssue, number: 123, url: 'https://github.com/owner/repo/issues/123' }, issueFailure = false;
    const calls = [], execute = async (exe, args) => {
      calls.push({ exe, args });
      if (exe === git) {
        assert.deepEqual(args.slice(0, 2), ['-C', s.target]);
        const key = args.slice(2).join(' ');
        const replies = { 'rev-parse --is-inside-work-tree': 'true', 'rev-parse --show-toplevel': s.target,
          remote: 'origin', 'remote get-url --all origin': remote };
        assert.ok(Object.hasOwn(replies, key), 'Only repository read commands are permitted');
        return { ok: true, text: replies[key] };
      }
      assert.equal(exe, gh);
      if (args[0] === 'api') {
        assert.deepEqual(args, ['api', '--hostname', 'github.com', '--method', 'GET', 'user', '--jq', '.login']);
        return { ok: true, text: account };
      }
      assert.deepEqual(args, ['issue', 'view', '123', '--repo', 'github.com/owner/repo', '--json', 'body,number,url']);
      return issueFailure ? { ok: false, reason: 'command_failed', text: '' } : { ok: true, text: JSON.stringify(issue) };
    };
    const before = snapshot(f.root);
    const invoke = source => specCommand(s.target, parseSpecArguments('spec.current.issue.check', [source, '--json']), { execute });
    const result = await invoke('#123');
    assert.equal(result.exitCode, 0); assert.equal(result.report.status, 'passed');
    assert.deepEqual(result.report.checks, checkIssueMarkdown(validIssue, loadSpec('issue-direct').issueRules));
    assert.deepEqual((await invoke('123')).report.checks, result.report.checks);
    assert.equal(result.report.source.url, issue.url);
    issue.body = '## Goal\nIncomplete';
    assert.equal((await invoke('123')).exitCode, 1);
    issueFailure = true;
    assert.equal((await invoke('123')).report.reason, 'issue_read_failed');
    issueFailure = false; issue.number = 999;
    assert.equal((await invoke('123')).report.reason, 'issue_response_invalid');
    account = 'OtherAccount'; calls.length = 0;
    assert.equal((await invoke('123')).report.reason, 'unexpected_account');
    assert.ok(calls.every(call => call.args[0] !== 'issue'));
    remote = 'https://github.com/other/repo.git'; calls.length = 0;
    assert.equal((await invoke('123')).report.reason, 'repository_address_mismatch');
    assert.ok(calls.every(call => call.exe !== gh));
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.dispose(); }
});
