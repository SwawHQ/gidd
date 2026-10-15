import { test } from 'node:test';
import { renameSync } from 'node:fs';
import { runRepositoryCommand } from './support/repository.mjs';
import { flowSnapshot } from '../.agents/skills/gidd/scripts.js/shared/flow-definition.mjs';
import { loadFlow } from '../.agents/skills/gidd/scripts.js/shared/flows.mjs';
import { recordFlowUse, flowStorage } from '../.agents/skills/gidd/scripts.js/shared/flow-history.mjs';
import { adapter, assert, bindFixture, copySkill, dirname, existsSync, findGit, fixture, join, json,
  mkdirSync, ok, readFileSync, run, snapshot, toolsRoot, write, compile, stub, rmSync, initializeDataFixture } from './support/helpers.mjs';

function setup() {
  const f = fixture(), git = findGit(), skill = join(f.root, "技能 %GIDD_SENTINEL% ! & ' spaces");
  copySkill(skill);
  const target = join(f.root, 'target'); mkdirSync(target);
  ok(run(git, ['init', '-b', 'main', target]));
  ok(run(git, ['-C', target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'initial']));
  ok(adapter(f.root, { action: 'bootstrap', repositoryRoot: target, responses: {}, downloads: {}, yes: true },
    { env: { PATH: dirname(process.execPath) } }));
  bindFixture(f.root, { git });
  const invoke = (args, cwd = target, env = {}, entry = join(skill, 'gidd.cmd')) => runRepositoryCommand(target, args, {
    entry, cwd, env: { PATH: '', LC_ALL: 'en', GIDD_SENTINEL: 'must-not-expand', ...env },
  });
  return { ...f, git, skill, target, invoke };
}

test('static entry works outside a repository for help and shared user preferences', () => {
  const s = setup();
  try {
    const before = snapshot(s.root);
    assert.match(ok(s.invoke(['help', 'zh'], s.root)).stdout, /^GIDD（/);
    assert.deepEqual(snapshot(s.root), before);
    const config = join(toolsRoot(s.root), 'config.toml');
    const result = json(ok(s.invoke(['lang.set', 'zh'], s.root)));
    assert.equal(result.config_path, config);
    assert.equal(result.key, 'ui.language');
    for (const cwd of [s.root, s.target]) assert.match(ok(s.invoke(['help'], cwd)).stdout, /^GIDD（/);
    assert.match(ok(s.invoke(['help', 'en'], s.root)).stdout, /^GIDD \(/);
    assert.equal(ok(s.invoke(['set.show'], s.target)).stdout, readFileSync(config, 'utf8'));
    assert.equal(json(ok(s.invoke(['lang.clear'], s.root))).changed, true);
    assert.doesNotMatch(readFileSync(config, 'utf8'), /language\s*=/);
    assert.equal(existsSync(join(s.target, '.agents')), false);
    assert.equal(existsSync(s.target + '.gidd'), false);
    assert.equal(json(s.invoke(['doctor', '--offline'], s.root)).checks.find(x => x.id === 'folder.git.worktree').details.code, 'not_git_repository');
  } finally { s.dispose(); }
});

test('one static entry discovers each calling repository and shares main data with linked worktrees', () => {
  const s = setup();
  try {
    const other = join(s.root, 'other'), nested = join(s.target, 'nested'), linked = join(s.root, 'linked');
    mkdirSync(other); mkdirSync(nested);
    ok(run(s.git, ['init', '-b', 'main', other]));
    ok(run(s.git, ['-C', s.target, 'worktree', 'add', '-b', 'linked', linked]));
    const before = snapshot(s.root);
    for (const [cwd, expected] of [[s.target, s.target], [nested, s.target], [other, other], [linked, s.target]]) {
      const report = json(s.invoke(['doctor', '--offline', '--lang', 'en'], cwd));
      assert.equal(report.folder.toLowerCase(), expected.toLowerCase());
    }
    assert.deepEqual(snapshot(s.root), before);
    initializeDataFixture(s.target);
    recordFlowUse(flowStorage(s.target), flowSnapshot(loadFlow('00/00')));
    assert.equal(existsSync(join(s.target + '.gidd', 'flow-history.jsonl')), true);
    assert.equal(existsSync(linked + '.gidd'), false);
    assert.equal(ok(s.invoke(['flow.history', '--lang', 'zh'], nested)).stdout, '工作流程记录（最新在前，最多200条）：\n00/00\n');
  } finally { s.dispose(); }
});

test('static entry can move with its skill and preserves argument boundaries', () => {
  const s = setup();
  try {
    const moved = join(s.root, 'moved skill'); renameSync(s.skill, moved);
    const entry = join(moved, 'gidd.cmd');
    assert.match(ok(s.invoke(['help', 'en'], s.target, {}, entry)).stdout, /^GIDD \(/);
    for (const args of [['lang.set', ''], ['lang.set', 'en extra'], ['doctor', '--repository', s.target]]) {
      const result = s.invoke(args, s.target, {}, entry);
      assert.equal(result.status, 2);
      assert.ok(json(result).details.code);
    }
    assert.equal(existsSync(join(toolsRoot(s.root), 'config.toml')), false);
  } finally { s.dispose(); }
});

test('a missing runtime prepares tools and then runs the original command', () => {
  const s = setup();
  try {
    const home = join(s.root, 'empty home'), bin = join(s.root, 'native tools'); mkdirSync(join(home, 'AppData/Roaming'), {recursive:true});
    stub(compile(s.root), join(bin, 'gh.exe'));
    const result = ok(s.invoke(['flow.deliveries', '--lang', 'zh'], s.root, {
      USERPROFILE: home, PATH: [dirname(process.execPath), dirname(s.git), bin].join(';'),
    }));
    assert.ok(json(result).modes.length);
    assert.match(result.stderr, /gidd.tools\/v1/);
    const root = toolsRoot(home);
    for (const name of [process.versions.bun ? 'bun' : 'node', 'git', 'gh']) assert.ok(existsSync(join(root, name + '.link.cmd')));
    assert.equal(existsSync(s.target + '.gidd'), false);
    const before = snapshot(s.root);
    assert.match(ok(s.invoke(['help', 'en'], s.root, {USERPROFILE:home})).stdout, /^GIDD \(/);
    assert.deepEqual(snapshot(s.root), before);
  } finally { s.dispose(); }
});

test('automatic preparation failure stops once and keeps stdout empty', () => {
  const s = setup();
  try {
    const home = join(s.root, 'empty home'); mkdirSync(join(home, 'AppData/Roaming'), {recursive:true});
    write(join(s.skill, 'scripts.powershell/bootstrap.ps1'), "[Console]::Error.WriteLine('fixture_preparation_failed'); exit 7");
    const before = snapshot(s.root), result = s.invoke(['help'], s.target, {USERPROFILE:home});
    assert.equal(result.status, 7); assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'fixture_preparation_failed');
    assert.deepEqual(snapshot(s.root), before);
  } finally { s.dispose(); }
});

test('catalog queries and doctor work without Git bindings or a repository', () => {
  const s = setup();
  try {
    rmSync(join(toolsRoot(s.root), 'tool-bindings.json'));
    const before = snapshot(s.root);
    for (const args of [['flow.deliveries'], ['flow.list','00'], ['flow.issue','00/00']]) {
      const report = json(ok(s.invoke([...args,'--lang','zh'],s.root)));
      assert.equal(report.scope, undefined);
    }
    assert.match(ok(s.invoke(['flow','00/00','--lang','zh'],s.root)).stdout, /流程与授权/);
    const report = json(s.invoke(['doctor','--offline'],s.root));
    assert.equal(report.schema, 'gidd.doctor/v1');
    assert.ok(report.checks.length > 5);
    assert.notEqual(report.checks.find(x=>x.id==='tool.git').status,'ready');
    assert.notEqual(s.invoke(['14.flow','--lang','zh'],s.root).status,0);
    assert.deepEqual(snapshot(s.root),before);
  } finally { s.dispose(); }
});
