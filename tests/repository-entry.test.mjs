import { test } from 'node:test';
import { realpathSync, renameSync, statSync } from 'node:fs';
import { assertInstallationRepository, checkRepositoryLink, publishRepositoryEntry } from '../.agents/skills/gidd/scripts/repository-entry.mjs';
import { assert, compile, copySkill, dirname, existsSync, fixture, findGit, join, json, mkdirSync, ok, readFileSync, rmSync, run, snapshot, stub, toolsRoot, write } from './support/helpers.mjs';

const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
function setup(f) {
  const git = findGit(), skill = join(f.root, '外部 skill %literal% ! & spaces');
  copySkill(skill);
  const bin = join(f.root, 'bin'); stub(compile(f.root), join(bin, 'gh.exe'));
  const env = { PATH: [dirname(process.execPath), dirname(git), bin].join(';'), GIDD_LANG: 'en', literal: undefined };
  const invoke = (entry, args = [], options = {}) => run(join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe'),
    ['/d', '/s', '/c', `""${entry}" ${args.map(quote).join(' ')}"`],
    { windowsVerbatimArguments: true, cwd: f.root, ...options, env: { ...env, ...options.env } });
  const create = (name, remote = 'https://github.com/Team/Repo.git') => {
    const target = join(f.root, name); mkdirSync(target);
    ok(run(git, ['-C', target, 'init', '--quiet']));
    if (remote) ok(run(git, ['-C', target, 'remote', 'add', 'origin', remote]));
    return target;
  };
  const ensure = (target, extra = [], entry = join(skill, 'gidd.pre.ensure.cmd')) => invoke(entry, ['--repo', target, ...extra]);
  const link = target => join(target, '.agents/skills/gidd/gidd.link.cmd');
  return { git, skill, invoke, create, ensure, link };
}

test('repository ensure help works without tools or a repository and honors language selection', { timeout: 120000 }, () => {
  const f = fixture();
  try {
    const skill = join(f.root, 'help skill'); copySkill(skill);
    const entry = join(skill, 'gidd.pre.ensure.cmd');
    const invoke = (args, env = {}) => run(join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe'),
      ['/d', '/s', '/c', `""${entry}" ${args.map(quote).join(' ')}"`],
      { windowsVerbatimArguments: true, cwd: f.root,
        env: { PATH: '', GIDD_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: 'en', ...env } });
    const before = snapshot(f.root);
    for (const [args, env, language] of [
      [[], {}, 'en'], [['help', 'en'], { GIDD_LANG: 'invalid' }, 'en'],
      [['help', 'zh'], { GIDD_LANG: 'en', LC_ALL: 'en' }, 'zh-CN'],
      [['--help'], { GIDD_LANG: 'zh-CN', LC_ALL: 'en' }, 'zh-CN'],
      [['-h', 'en'], { GIDD_LANG: 'zh' }, 'en'],
      [['help'], { LC_ALL: 'zh_CN.UTF-8', LC_MESSAGES: 'en' }, 'zh-CN'],
      [['help'], { LC_MESSAGES: 'zh', LANG: 'en' }, 'zh-CN'],
      [[], { LANG: 'zh' }, 'zh-CN'], [['help'], { LC_ALL: 'fr_FR', LANG: 'zh' }, 'en'],
    ]) {
      const output = ok(invoke(args, env));
      assert.equal(output.stderr, '');
      assert.equal(output.stdout.trim(), readFileSync(join(skill, `scripts/help/pre-ensure/${language}.txt`), 'utf8').trim());
    }
    for (const [args, env, reason] of [
      [['help', 'fr'], {}, 'unsupported_help_language'],
      [['--help'], { GIDD_LANG: 'invalid' }, 'unsupported_help_language'],
      [['help', 'en', '--force'], {}, 'invalid_arguments'],
      [['--force', '--help'], {}, 'invalid_arguments'],
      [['--force'], {}, 'repository_required'],
      [['--repo'], {}, 'invalid_arguments'],
      [['--repo', f.root, '--repository', f.root], {}, 'invalid_arguments'],
      [['--repository', f.root, '--repo', f.root], {}, 'invalid_arguments'],
      [['--repo', f.root, '--repo', f.root], {}, 'invalid_arguments'],
      [['--repo', f.root, '--check', '--force'], {}, 'check_conflicts_with_preparation'],
      [['--repo', f.root, '--check', '--jsruntime=node'], {}, 'check_conflicts_with_preparation'],
      [['--repo', f.root, '--check', '--ensure'], {}, 'invalid_arguments'],
    ]) {
      const result = invoke(args, env);
      assert.equal(result.status, 2); assert.equal(json(result).reason, reason);
    }
    assert.equal(existsSync(toolsRoot(f.root)), false);
    assert.deepEqual(snapshot(f.root), before, 'Help and invalid arguments must not prepare tools or write files');
  } finally { f.dispose(); }
});

test('repository installations reject other targets before preparation or JS publication', { timeout: 120000 }, () => {
  const f = fixture();
  try {
    const s = setup(f), target = s.create('owner-other');
    publishRepositoryEntry(target, join(s.skill, 'gidd.cmd'));
    // All fixtures share the same remote: ownership belongs to the local worktree.
    for (const layout of ['.agents', '.claude']) {
      const owner = s.create('owner-' + layout), skill = join(owner, layout, 'skills/gidd'); copySkill(skill);
      const entry = join(skill, 'gidd.pre.ensure.cmd'), source = join(skill, 'gidd.cmd');
      const before = snapshot(f.root);
      for (const args of [[], ['--check'], ['--force']]) {
        const result = s.ensure(target, args, entry);
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.equal(json(result).reason, 'installation_repository_mismatch');
        assert.doesNotMatch(result.stderr, /download/i);
        assert.deepEqual(snapshot(f.root), before);
      }
      assert.equal(json(s.invoke(entry, ['--repository', target])).reason, 'installation_repository_mismatch');
      assert.throws(() => publishRepositoryEntry(target, source), /installation_repository_mismatch/);
      assert.throws(() => checkRepositoryLink(target, source), /installation_repository_mismatch/);
      assert.deepEqual(snapshot(f.root), before, 'Rejected sources must preserve existing links and tools');
      assert.equal(existsSync(toolsRoot(f.root)), false);
      assert.equal(assertInstallationRepository(owner, source), realpathSync.native(owner));
      const normalized = owner.toUpperCase() + '\\.';
      const check = s.ensure(normalized, ['--check'], entry);
      assert.equal(check.status, 1, check.stdout + check.stderr);
      assert.equal(json(check).entry.reason, 'repository_entry_missing');
      assert.deepEqual(snapshot(f.root), before);
    }
  } finally { f.dispose(); }
});

test('ambiguous Git-contained installations fail closed while help remains available', { timeout: 120000 }, () => {
  const f = fixture();
  try {
    const s = setup(f), owner = s.create('collection'), target = s.create('target');
    for (const location of ['nested/.agents/skills/gidd', 'plugins/gidd', '.agents/skills/gidd']) {
      const skill = join(owner, location); copySkill(skill);
      // A Git-managed skill collection must not be mistaken for its parent repository.
      if (location === '.agents/skills/gidd') ok(run(s.git, ['-C', join(owner, '.agents'), 'init', '--quiet']));
      const entry = join(skill, 'gidd.pre.ensure.cmd'), source = join(skill, 'gidd.cmd');
      const before = snapshot(f.root);
      for (const repo of [owner, target]) {
        for (const extra of [[], ['--check']]) {
          const result = s.ensure(repo, extra, entry);
          assert.equal(result.status, 2, result.stdout + result.stderr);
          assert.equal(json(result).reason, 'installation_scope_unknown');
        }
        assert.throws(() => publishRepositoryEntry(repo, source), /installation_scope_unknown/);
        assert.throws(() => checkRepositoryLink(repo, source), /installation_scope_unknown/);
      }
      assert.match(ok(s.invoke(entry, ['help', 'en'], { env: { PATH: '' } })).stdout, /GIDD prerequisites preparation/);
      assert.deepEqual(snapshot(f.root), before);
    }
    assert.equal(assertInstallationRepository(target, join(s.skill, 'gidd.cmd')), null);
    assert.equal(publishRepositoryEntry(target, join(s.skill, 'gidd.cmd')).location, 'absolute');
  } finally { f.dispose(); }
});

test('repository check reports missing, healthy and damaged state without writes or downloads', { timeout: 120000 }, () => {
  const f = fixture();
  try {
    const s = setup(f), target = s.create('check target'), entry = join(s.skill, 'gidd.pre.ensure.cmd');
    const inspect = (repository = target, env = {}) => {
      const before = snapshot(f.root);
      const result = s.invoke(entry, ['--repo', repository, '--check'], { env });
      assert.ok([0, 1].includes(result.status), result.stdout + result.stderr);
      const report = json(result); assert.equal(report.read_only, true);
      assert.equal(result.status, report.status === 'ready' ? 0 : 1);
      assert.equal(report.message, undefined, 'A check must not claim it prepared an entry');
      assert.doesNotMatch(result.stderr, /download/i);
      assert.deepEqual(snapshot(f.root), before, 'Check must not publish, recover, install, or edit files');
      return report;
    };
    const noRuntime = inspect(target, { PATH: '' });
    assert.equal(noRuntime.status, 'needs_tools');
    assert.equal(noRuntime.entry.reason, 'runtime_unavailable');
    assert.equal(noRuntime.repository_check.status, 'not_checked');
    assert.equal(existsSync(toolsRoot(f.root)), false);
    const noGit = inspect(target, { PATH: [dirname(process.execPath), join(f.root, 'bin')].join(';') });
    assert.equal(noGit.repository_check.reason, 'git_unavailable');
    assert.equal(noGit.tool_checks.find(c => c.id === 'tool.gh').status, 'ready');
    assert.equal(noGit.entry.reason, 'repository_entry_missing');
    const fresh = inspect();
    assert.equal(fresh.status, 'needs_tools');
    assert.equal(fresh.repository_check.status, 'ready');
    assert.equal(fresh.entry.reason, 'repository_entry_missing');
    assert.equal(existsSync(toolsRoot(f.root)), false);

    ok(s.ensure(target));
    assert.equal(inspect().status, 'ready');
    const link = s.link(target), saved = readFileSync(link, 'utf8');
    rmSync(link);
    assert.equal(inspect().entry.reason, 'repository_entry_missing');
    write(link, '@echo off\r\necho user owned\r\n');
    assert.equal(inspect().entry.reason, 'repository_entry_occupied');
    rmSync(link); mkdirSync(link);
    assert.equal(inspect().entry.reason, 'repository_entry_occupied');
    rmSync(link, { recursive: true }); write(link, saved);
    write(link + '.lock', 'another writer');
    assert.equal(inspect().entry.reason, 'repository_entry_locked');
    rmSync(link + '.lock');
    const replacement = join(f.root, 'other skill'); copySkill(replacement);
    publishRepositoryEntry(target, join(replacement, 'gidd.cmd'));
    assert.equal(inspect().entry.reason, 'repository_entry_outdated');
    write(link, saved);
    write(join(toolsRoot(f.root), '.cache/previous-gh/pending.txt'), 'do not recover');
    const pending = inspect();
    assert.equal(pending.tool_checks.find(c => c.id === 'binding.gh').reason, 'tool_recovery_pending');
    assert.equal(pending.entry.status, 'ready');
    ok(run(s.git, ['-C', target, 'remote', 'set-url', 'origin', 'https://gitlab.com/Other/Repo']));
    const wrongRemote = inspect();
    assert.equal(wrongRemote.repository_check.reason, 'github_remote_required');
    assert.equal(wrongRemote.tool_checks.find(c => c.id === 'tool.gh').status, 'ready');
    assert.equal(wrongRemote.entry.status, 'ready');
    const bindings = join(toolsRoot(f.root), 'tool-bindings.json'); write(bindings, '{broken');
    assert.equal(inspect().tool_checks.find(c => c.id === 'binding.git').reason, 'bootstrap_required');
  } finally { f.dispose(); }
});

test('repository ensure rejects unsuitable targets and keeps configuration untouched', { timeout: 120000 }, () => {
  const f = fixture();
  try {
    const s = setup(f), entry = join(s.skill, 'gidd.pre.ensure.cmd');
    const ordinary = join(f.root, 'ordinary'); mkdirSync(ordinary);
    const before = snapshot(f.root);
    for (const args of [['--repository'], ['--repository', '.'], ['--repository', ordinary],
      ['--repository', join(f.root, 'absent')], ['--repository', ordinary, '--check'], ['--repository', ordinary, '--ensure']]) {
      const result = s.invoke(entry, args); assert.notEqual(result.status, 0);
      assert.deepEqual(snapshot(f.root), before, 'Invalid location must not prepare tools or create files');
    }
    for (const [name, remote] of [['no remote', null], ['gitlab', 'https://gitlab.com/Team/Repo.git'],
      ['credential URL', 'https://u:PRIVATE_TOKEN@github.com/Team/Repo.git']]) {
      const target = s.create(name, remote), result = s.ensure(target);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(json(result).entry.status, 'not_published');
      assert.ok(json(result).tool_checks.some(c => c.reason === 'github_remote_required'));
      assert.ok(!result.stdout.includes('PRIVATE_TOKEN'));
      assert.equal(existsSync(s.link(target)), false);
      assert.equal(existsSync(join(target, '.agents/skills/gidd/config.toml')), false);
    }
    const target = s.create('configured');
    const config = join(target, '.agents/skills/gidd/config.toml');
    write(config, 'schema_version = 1\n[github]\nhostname = "github.com"\nremote = "missing"\n');
    const original = readFileSync(config, 'utf8'), result = s.ensure(target);
    assert.equal(result.status, 1); assert.ok(json(result).tool_checks.some(c => c.reason === 'configured_remote_missing'));
    assert.equal(readFileSync(config, 'utf8'), original); assert.equal(existsSync(s.link(target)), false);
    write(config, 'schema_version = 1\n[github]\nhostname = "github.example.test"\n');
    ok(run(s.git, ['-C', target, 'remote', 'set-url', 'origin', 'git@github.example.test:Team/Repo.git']));
    assert.equal(json(ok(s.ensure(target))).repository_check.remotes[0].hostname, 'github.example.test');
  } finally { f.dispose(); }
});

test('repository links preserve target, arguments, idempotence and unknown files', { timeout: 120000 }, () => {
  const f = fixture();
  try {
    const s = setup(f), target = s.create('仓库 %target% ! & spaces'), link = s.link(target);
    const first = json(ok(s.ensure(target)));
    assert.equal(first.entry.location, 'absolute'); assert.equal(first.entry.action, 'created');
    assert.equal(first.repository_check.status, 'ready');
    assert.equal(existsSync(join(target, '.agents/skills/gidd/config.toml')), false);
    assert.ok([...readFileSync(link)].every(byte => byte < 128));
    const tree = snapshot(f.root), modified = statSync(link).mtimeMs;
    const second = json(ok(s.invoke(join(s.skill, 'gidd.pre.ensure.cmd'), ['--repository', target])));
    assert.equal(second.entry.action, 'reused'); assert.equal(second.launcher_action, 'reused');
    assert.ok(second.tools.every(tool => tool.action === 'reused' && tool.binding_action === 'reused'));
    assert.deepEqual(snapshot(f.root), tree); assert.equal(statSync(link).mtimeMs, modified);
    const replacement = join(f.root, 'replacement skill'); copySkill(replacement);
    assert.equal(publishRepositoryEntry(target, join(replacement, 'gidd.cmd')).action, 'updated');
    assert.match(ok(s.invoke(link, ['help', 'en'])).stdout, /Help and diagnosis/);
    assert.equal(publishRepositoryEntry(target, join(s.skill, 'gidd.cmd')).action, 'updated');
    assert.match(ok(s.invoke(link, ['help', 'zh'], { env: { PATH: '' } })).stdout, /帮助与诊断/);
    assert.match(ok(s.invoke(link, [])).stdout, /Help and diagnosis/);
    const other = s.create('other');
    const output = s.invoke(link, ['doctor', '--offline'], { cwd: other, env: { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other } });
    const report = json(output); assert.equal(report.repository, target);
    assert.equal(report.checks.find(c => c.id === 'config').reason, 'config_missing');
    assert.equal(realpathSync.native(report.checks.find(c => c.id === 'repository').details.path), realpathSync.native(target));
    const rejected = s.invoke(link, ['config', 'show', '--repository', other]);
    assert.equal(json(rejected).reason, 'repository_override_forbidden');
    assert.equal(json(s.invoke(link, ['--repository=' + other])).reason, 'repository_override_forbidden');
    assert.equal(json(s.invoke(link, ['--encoded-arguments', Buffer.from(JSON.stringify(['config', 'show', '--repository', other])).toString('base64')])).reason, 'unknown_command');
    const source = 'https://example.test/工具&!%value%';
    const set = json(ok(s.invoke(link, ['config', 'set', 'tools.node.source', source])));
    assert.equal(set.value, source);
    assert.ok(readFileSync(join(target, '.agents/skills/gidd/config.toml'), 'utf8').includes(source));
    const beforeRemoved = snapshot(f.root);
    for (const args of [['tools'], ['tools','--check'], ['tools','--ensure']]) {
      assert.equal(json(s.invoke(link, args)).reason, 'unknown_command');
    }
    assert.deepEqual(snapshot(f.root), beforeRemoved);
    const fresh = s.create('new repository'); const shared = snapshot(toolsRoot(f.root));
    assert.equal(json(ok(s.ensure(fresh))).entry.action, 'created'); assert.deepEqual(snapshot(toolsRoot(f.root)), shared);
    const saved = readFileSync(link, 'utf8'); write(link, '@echo off\r\necho user owned\r\n');
    const occupied = s.ensure(target); assert.equal(occupied.status, 1);
    assert.ok(json(occupied).tool_checks.some(c => c.reason === 'repository_entry_occupied'));
    assert.equal(readFileSync(link, 'utf8'), '@echo off\r\necho user owned\r\n');
    write(link, saved); write(link + '.lock', 'another writer');
    assert.throws(() => publishRepositoryEntry(target, join(s.skill, 'gidd.cmd')), /repository_entry_locked/);
    assert.equal(readFileSync(link, 'utf8'), saved); rmSync(link + '.lock');
    ok(run(s.git, ['-C', target, 'remote', 'set-url', 'origin', 'https://gitlab.com/Other/Repo']));
    assert.equal(s.ensure(target).status, 1); assert.equal(readFileSync(link, 'utf8'), saved);
    const dispatcher = join(s.skill, 'scripts/gidd.mjs');
    write(dispatcher, `import {readFileSync} from 'node:fs'; export async function main(args, options) { console.log(JSON.stringify({args, options, input:readFileSync(0,'utf8')})); console.error('linked stderr'); return 23; }`);
    const args = ['two words', '', 'a & b', 'a^b', '!literal!', 'two "quotes"', 'tail\\', '--help'];
    const forwarded = s.invoke(link, args, { input: 'linked stdin', cwd: other });
    assert.equal(forwarded.status, 23, forwarded.stderr); assert.deepEqual(json(forwarded).args, args);
    assert.equal(json(forwarded).input, 'linked stdin'); assert.equal(json(forwarded).options.boundRepository, target);
    assert.match(forwarded.stderr, /linked stderr/);
    rmSync(join(s.skill, 'gidd.cmd'));
    assert.equal(json(s.invoke(link, ['help'])).status, 'error');
  } finally { f.dispose(); }
});

test('repository-relative links survive moves and accept Git worktrees', { timeout: 120000 }, () => {
  const f = fixture();
  try {
    const s = setup(f);
    for (const layout of ['.agents', '.claude']) {
      const target = s.create('local-' + layout), skill = join(target, layout, 'skills/gidd'); copySkill(skill);
      const result = json(ok(s.ensure(target, [], join(skill, 'gidd.pre.ensure.cmd'))));
      assert.equal(result.entry.location, 'relative');
      assert.match(ok(s.invoke(s.link(target), ['help', 'en'])).stdout, /Help and diagnosis/);
      const moved = join(f.root, 'moved-' + layout); renameSync(target, moved);
      const report = json(s.invoke(s.link(moved), ['doctor', '--offline']));
      assert.equal(report.repository, moved);
      assert.equal(report.checks.find(c => c.id === 'repository').reason, 'unborn_branch');
    }
    const parent = s.create('parent');
    ok(run(s.git, ['-C', parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'fixture']));
    const worktree = join(f.root, 'linked worktree');
    ok(run(s.git, ['-C', parent, 'worktree', 'add', '--quiet', '--detach', worktree]));
    const worktreeSkill = join(worktree, '.agents/skills/gidd'); copySkill(worktreeSkill);
    const worktreeEntry = join(worktreeSkill, 'gidd.pre.ensure.cmd');
    assert.equal(json(s.ensure(parent, ['--check'], worktreeEntry)).reason, 'installation_repository_mismatch');
    assert.throws(() => publishRepositoryEntry(parent, join(worktreeSkill, 'gidd.cmd')), /installation_repository_mismatch/);
    assert.equal(realpathSync.native(json(ok(s.ensure(worktree, [], worktreeEntry))).entry.target), realpathSync.native(worktree));
    const report = json(s.invoke(s.link(worktree), ['doctor', '--offline'])); assert.equal(report.repository, worktree);
    const nested = join(parent, 'nested'); mkdirSync(nested);
    assert.equal(json(s.ensure(nested)).reason, 'not_git_repository_root');
  } finally { f.dispose(); }
});
