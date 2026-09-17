import { test } from 'node:test';
import { realpathSync, renameSync, statSync } from 'node:fs';
import { assertInstallationRepository, checkRepositoryLink, publishRepositoryEntry } from './support/repository.mjs';
import { inspectRepositoryEntry } from '../.agents/skills/gidd/scripts.js/repository-check.mjs';
import { adapter, assert, compile, copySkill, dirname, existsSync, fixture, findGit, join, json, mkdirSync, ok, readFileSync, readdirSync, rmSync, run, snapshot, stub, toolsRoot, write } from './support/helpers.mjs';

const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
function setup(f) {
  const git = findGit(), skill = join(f.root, "外部 skill %literal% ! & # ' spaces");
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

test('issue-direct guidance uses only the public preparation and repository commands', () => {
  const f = fixture();
  try {
    const s = setup(f), target = s.create('issue-direct lifecycle');
    ok(s.ensure(target));
    const invoke = args => s.invoke(s.link(target), args, { env: { PATH: '' } });
    for (const [key,value] of [['spec.current','issue-direct'],['git.user.mode','inherit'],['git.credential.mode','inherit'],
      ['repo.remote.account','Octocat'],['repo.remote.name','origin'],['repo.remote.url','https://github.com/Team/Repo']]) {
      ok(invoke(['set',key,value]));
    }
    for (const [key,value] of [['user.name','Fixture'],['user.email','fixture@example.test']]) {
      ok(run(s.git,['-C',target,'config',key,value]));
    }
    assert.equal(json(ok(invoke(['doctor','--offline']))).status,'local_ready');
    assert.match(ok(invoke(['spec.current'])).stdout, /Prompt source: ` .+prompt\.en\.md `/);
    const form = json(ok(invoke(['spec.current.issue','--lang','en']))).form;
    assert.deepEqual(form.body.map(field => field.id), ['goal', 'scope', 'acceptance', 'validation', 'delivery']);
    assert.match(ok(invoke(['spec.current'])).stdout, /spec\.issue-direct\.issue/);
    const config = readFileSync(join(target,'.agents/skills/gidd/config.toml'));
    write(s.link(target),'damaged entry');
    assert.notEqual(s.ensure(target,['--check']).status,0);
    assert.equal(json(ok(s.ensure(target))).entry.action,'updated');
    assert.equal(json(ok(invoke(['doctor','--offline']))).status,'local_ready');
    assert.deepEqual(readFileSync(join(target,'.agents/skills/gidd/config.toml')),config);
  } finally { f.dispose(); }
});

test('repository preparation runs entirely in PowerShell; generated commands run entirely in JS', () => {
  const f=fixture();
  try {
    const s=setup(f), target=s.create('native preparation'), scripts=join(s.skill,'scripts.js'), bin=join(f.root,'bin');
    // These runtimes only implement --version: attempting to run JS returns 90.
    for(const name of ['bun','node']) stub(join(f.root,'tool.exe'),join(bin,name+'.exe'));
    const originals=new Map();
    for(const name of readdirSync(scripts).filter(name=>name.endsWith('.mjs'))) {
      const path=join(scripts,name);originals.set(path,readFileSync(path));write(path,"throw new Error('ensure_must_not_execute_js');");
    }
    const entry=join(s.skill,'gidd.pre.ensure.cmd'), env={PATH:[bin,dirname(s.git)].join(';')};
    for(const name of ['bun','node']) {
      const first=json(ok(s.invoke(entry,['--repo',target,'--jsruntime='+name],{env})));
      assert.equal(first.runtime.id,'tool.'+name);assert.equal(first.entry.status,'ready');
      assert.equal(json(ok(s.invoke(entry,['--repo',target,'--check'],{env}))).status,'ready');
      write(s.link(target),'damaged');
      assert.equal(json(ok(s.invoke(entry,['--repo',target,'--jsruntime='+name],{env}))).entry.action,'updated');
    }
    for(const [path,bytes] of originals) write(path,bytes);
    // Bind the real test runtime, then remove every native implementation file.
    stub(process.execPath,join(bin,(process.versions.bun?'bun':'node')+'.exe'));
    ok(s.invoke(entry,['--repo',target,'--jsruntime='+(process.versions.bun?'bun':'node')],{env}));
    const native=join(s.skill,'scripts.powershell');
    assert.ok(native.startsWith(f.root));rmSync(native,{recursive:true});
    assert.match(ok(s.invoke(s.link(target),['help','en'],{env:{PATH:''}})).stdout,/Check tools, repository and GitHub identity/);
    assert.equal(json(s.invoke(s.link(target),['doctor','--offline'],{env:{PATH:''}})).schema,'gidd.doctor/v1');
  } finally {f.dispose();}
});

test('native preparation and JS agree on worktree ownership without remote prerequisites', async () => {
  const f=fixture();
  try {
    const s=setup(f),target=s.create('repository rules');
    const urls=[
      'https://github.com/Team/Repo.git','git@github.com:Team/Repo.git',
      'HTTPS://GitHub.COM/Team/Repo.GIT','SSH://GIT@github.com/Team/Repo.git',
      'ssh://git@github.example.test:2222/Team/Repo.git',
      'https://gitlab.com/Team/Repo.git','https://u:PRIVATE_TOKEN@github.com/Team/Repo.git',
      'https://github.com/Team/Repo?token=PRIVATE_TOKEN','https://github.com/../Repo',
    ];
    for(const url of urls) {
      ok(run(s.git,['-C',target,'remote','set-url','origin',url]));
      const native=adapter(f.root,{action:'repository',operation:'inspect',repositoryRoot:target,git:s.git});
      let js;
      try { js=await inspectRepositoryEntry(target,s.git); }
      catch(error) { assert.equal(native.status,1);assert.equal(native.stderr.trim(),error.message);continue; }
      assert.deepEqual(json(ok(native)).path,js.path);
    }
    ok(run(s.git,['-C',target,'remote','set-url','origin','https://github.com/Team/Repo.git']));
    ok(s.ensure(target));const link=s.link(target);
    const race=adapter(f.root,{action:'repository',operation:'publish',repositoryRoot:target,
      entry:join(s.skill,'scripts.js/gidd.mjs'),runtime:process.versions.bun?'node':'bun',concurrentText:'concurrent edit'});
    assert.equal(race.status,1);assert.match(race.stderr,/repository_entry_changed/);
    assert.equal(readFileSync(link,'utf8'),'concurrent edit');assert.equal(existsSync(link+'.lock'),false);
  } finally {f.dispose();}
});

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
      assert.equal(output.stdout.trim(), readFileSync(join(skill, `references/gidd.pre.ensure.help.${language}.md`), 'utf8').trim());
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

test('repository installations reject other targets before preparation or native publication', { timeout: 120000 }, () => {
  const f = fixture();
  try {
    const s = setup(f), target = s.create('owner-other');
    publishRepositoryEntry(target, join(s.skill, 'scripts.js/gidd.mjs'));
    // All fixtures share the same remote: ownership belongs to the local worktree.
    for (const layout of ['.agents', '.claude']) {
      const owner = s.create('owner-' + layout), skill = join(owner, layout, 'skills/gidd'); copySkill(skill);
      const entry = join(skill, 'gidd.pre.ensure.cmd'), source = join(skill, 'scripts.js/gidd.mjs');
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
      const entry = join(skill, 'gidd.pre.ensure.cmd'), source = join(skill, 'scripts.js/gidd.mjs');
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
    assert.equal(assertInstallationRepository(target, join(s.skill, 'scripts.js/gidd.mjs')), null);
    assert.equal(publishRepositoryEntry(target, join(s.skill, 'scripts.js/gidd.mjs')).location, 'absolute');
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
    assert.equal(inspect().entry.reason, 'repository_entry_outdated');
    rmSync(link); mkdirSync(link);
    assert.equal(inspect().entry.reason, 'repository_entry_occupied');
    rmSync(link, { recursive: true }); write(link, saved);
    write(link + '.lock', 'another writer');
    assert.equal(inspect().entry.reason, 'repository_entry_locked');
    rmSync(link + '.lock');
    const replacement = join(f.root, 'other skill'); copySkill(replacement);
    publishRepositoryEntry(target, join(replacement, 'scripts.js/gidd.mjs'));
    assert.equal(inspect().entry.reason, 'repository_entry_outdated');
    write(link, saved);
    write(join(toolsRoot(f.root), '.cache/previous-gh/pending.txt'), 'do not recover');
    const pending = inspect();
    assert.equal(pending.tool_checks.find(c => c.id === 'binding.gh').reason, 'tool_recovery_pending');
    assert.equal(pending.entry.status, 'ready');
    ok(run(s.git, ['-C', target, 'remote', 'set-url', 'origin', 'https://gitlab.com/Other/Repo']));
    const wrongRemote = inspect();
    assert.equal(wrongRemote.repository_check.status, 'ready');
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
      ok(result);
      assert.equal(json(result).entry.status, 'ready');
      assert.ok(!result.stdout.includes('PRIVATE_TOKEN'));
      assert.equal(existsSync(s.link(target)), true);
      assert.equal(existsSync(join(target, '.agents/skills/gidd/config.toml')), false);
    }
    const target = s.create('configured');
    const config = join(target, '.agents/skills/gidd/config.toml');
    write(config, 'schema_version = 1\n[repo]\nremote.name = "missing"\n');
    const original = readFileSync(config, 'utf8'), result = s.ensure(target);
    ok(result);
    assert.equal(readFileSync(config, 'utf8'), original); assert.equal(existsSync(s.link(target)), true);
    write(config, 'schema_version = 1\n[repo]\n');
    ok(run(s.git, ['-C', target, 'remote', 'set-url', 'origin', 'git@github.example.test:Team/Repo.git']));
    assert.equal(json(ok(s.ensure(target))).repository_check.status, 'ready');
    for (const bytes of ['broken TOML', Buffer.from([255]), '#'.repeat(20000)]) {
      write(config, bytes); const before = readFileSync(config);
      ok(s.ensure(target)); ok(s.ensure(target, ['--check']));
      assert.deepEqual(readFileSync(config), before);
    }
  } finally { f.dispose(); }
});

test('repository links repair generated contents and preserve target, arguments and unrelated files', { timeout: 120000 }, () => {
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
    assert.equal(publishRepositoryEntry(target, join(replacement, 'scripts.js/gidd.mjs')).action, 'updated');
    assert.match(ok(s.invoke(link, ['help', 'en'])).stdout, /Check tools, repository and GitHub identity/);
    assert.equal(publishRepositoryEntry(target, join(s.skill, 'scripts.js/gidd.mjs')).action, 'updated');
    assert.match(ok(s.invoke(link, ['help', 'zh'], { env: { PATH: '' } })).stdout, /显示中文帮助/);
    assert.match(ok(s.invoke(link, [])).stdout, /Check tools, repository and GitHub identity/);
    const other = s.create('other');
    const output = s.invoke(link, ['doctor', '--offline'], { cwd: other, env: { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other } });
    const report = json(output); assert.equal(report.folder, target);
    assert.equal(report.checks.find(c => c.id === 'config.toml').reason, 'config_missing');
    assert.equal(realpathSync.native(report.checks.find(c => c.id === 'folder.git.worktree').details.path), realpathSync.native(target));
    const rejected = s.invoke(link, ['set.show', '--repository', other]);
    assert.equal(json(rejected).reason, 'repository_override_forbidden');
    assert.equal(json(s.invoke(link, ['--repository=' + other])).reason, 'repository_override_forbidden');
    assert.equal(json(s.invoke(link, ['--encoded-arguments', Buffer.from(JSON.stringify(['set.show', '--repository', other])).toString('base64')])).reason, 'unknown_command');
    const source = 'https://github.example.test/team/repo';
    const set = json(ok(s.invoke(link, ['set', 'repo.remote.url', source])));
    assert.equal(set.value, source);
    assert.ok(readFileSync(join(target, '.agents/skills/gidd/config.toml'), 'utf8').includes(source));
    const gitMarker = join(target, '.git'), savedMarker = join(target, '.git.saved');
    renameSync(gitMarker, savedMarker);
    try {
      const broken = s.invoke(link, ['doctor', '--offline'], { cwd: other });
      const diagnosis = json(broken);
      assert.equal(broken.status, 1); assert.equal(diagnosis.schema, 'gidd.doctor/v1');
      const repositoryCheck = diagnosis.checks.find(c => c.id === 'folder.git.worktree');
      assert.equal(repositoryCheck.reason, 'not_git_repository'); assert.equal(repositoryCheck.severity, 'error');
      assert.ok(repositoryCheck.hint);
      assert.equal(diagnosis.checks.find(c => c.id === 'config.toml').details.path, join(target, '.agents/skills/gidd/config.toml'));
      assert.match(ok(s.invoke(link, ['help', 'en'])).stdout, /Check tools, repository and GitHub identity/);
      const shown = s.invoke(link, ['set.show']);
      assert.equal(shown.status, 2); assert.equal(shown.stdout, '');
      assert.equal(JSON.parse(shown.stderr).reason, 'not_git_repository_root');
    } finally { renameSync(savedMarker, gitMarker); }
    const beforeRemoved = snapshot(f.root);
    for (const args of [['tools'], ['tools','--check'], ['tools','--ensure']]) {
      assert.equal(json(s.invoke(link, args)).reason, 'unknown_command');
    }
    assert.deepEqual(snapshot(f.root), beforeRemoved);
    const fresh = s.create('new repository'); const shared = snapshot(toolsRoot(f.root));
    assert.equal(json(ok(s.ensure(fresh))).entry.action, 'created'); assert.deepEqual(snapshot(toolsRoot(f.root)), shared);
    // Earlier direct publications may spell the same Windows path using its short name.
    ok(s.ensure(target));
    const saved = readFileSync(link, 'utf8');
    const config = join(target, '.agents/skills/gidd/config.toml'), savedConfig = readFileSync(config, 'utf8');
    for (const damaged of ['', '@echo off\r\necho modified\r\n', Buffer.alloc(20000, 0xff),
      saved.replace(/set "GIDD_LINK_SPEC=[^"]*"/, 'set "GIDD_LINK_SPEC=invalid"')]) {
      write(link, damaged);
      const beforeRepair = snapshot(f.root);
      assert.equal(json(s.ensure(target, ['--check'])).entry.reason, 'repository_entry_outdated');
      assert.deepEqual(snapshot(f.root), beforeRepair);
      assert.equal(json(ok(s.ensure(target))).entry.action, 'updated');
      assert.equal(readFileSync(link, 'utf8'), saved);
      assert.equal(readFileSync(config, 'utf8'), savedConfig);
      assert.deepEqual(snapshot(toolsRoot(f.root)), shared);
      assert.match(ok(s.invoke(link, ['help', 'en'])).stdout, /Check tools, repository and GitHub identity/);
    }
    rmSync(link); mkdirSync(link); write(join(link, 'keep.txt'), 'not a generated file');
    const occupied = snapshot(f.root);
    assert.equal(json(s.ensure(target)).reason, 'repository_entry_occupied');
    assert.deepEqual(snapshot(f.root), occupied);
    rmSync(link, { recursive: true }); write(link, saved); write(link + '.lock', 'another writer');
    assert.throws(() => publishRepositoryEntry(target, join(s.skill, 'scripts.js/gidd.mjs')), /repository_entry_locked/);
    assert.equal(readFileSync(link, 'utf8'), saved); rmSync(link + '.lock');
    ok(run(s.git, ['-C', target, 'remote', 'set-url', 'origin', 'https://gitlab.com/Other/Repo']));
    ok(s.ensure(target)); assert.equal(readFileSync(link, 'utf8'), saved);
    const dispatcher = join(s.skill, 'scripts.js/gidd.mjs');
    write(dispatcher, `import {readFileSync} from 'node:fs'; export async function main(args, options) { console.log(JSON.stringify({args, options, linkEnvironment:Object.keys(process.env).filter(key=>key.startsWith('GIDD_LINK_')), input:readFileSync(0,'utf8')})); console.error('linked stderr'); return 23; }`);
    const args = ['two words', '', 'a & b', 'a^b', '!literal!', 'two "quotes"', 'tail\\', '--help'];
    const forwarded = s.invoke(link, args, { input: 'linked stdin', cwd: other });
    assert.equal(forwarded.status, 23, forwarded.stderr); assert.deepEqual(json(forwarded).args, args);
    assert.equal(json(forwarded).input, 'linked stdin'); assert.equal(json(forwarded).options.boundRepository, target);
    assert.deepEqual(json(forwarded).linkEnvironment, [], 'Launcher metadata must not leak into the command or its children');
    assert.match(forwarded.stderr, /linked stderr/);
    const generated = readFileSync(link, 'utf8');
    write(link, generated.replace(/set "GIDD_LINK_SPEC=[^"]*"/, 'set "GIDD_LINK_SPEC=invalid"'));
    const invalid = s.invoke(link, ['help']);
    assert.equal(invalid.status, 2);
    assert.equal(json(invalid).reason, 'repository_entry_invalid');
    write(link, generated);
    rmSync(join(s.skill, 'scripts.js/gidd.mjs'));
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
      assert.match(ok(s.invoke(s.link(target), ['help', 'en'])).stdout, /Check tools, repository and GitHub identity/);
      const moved = join(f.root, 'moved-' + layout); renameSync(target, moved);
      const report = json(s.invoke(s.link(moved), ['doctor', '--offline']));
      assert.equal(report.folder, moved);
      assert.equal(report.checks.find(c => c.id === 'folder.git.worktree').reason, 'unborn_branch');
    }
    const parent = s.create('parent');
    ok(run(s.git, ['-C', parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'fixture']));
    const worktree = join(f.root, 'linked worktree');
    ok(run(s.git, ['-C', parent, 'worktree', 'add', '--quiet', '--detach', worktree]));
    const worktreeSkill = join(worktree, '.agents/skills/gidd'); copySkill(worktreeSkill);
    const worktreeEntry = join(worktreeSkill, 'gidd.pre.ensure.cmd');
    assert.equal(json(s.ensure(parent, ['--check'], worktreeEntry)).reason, 'installation_repository_mismatch');
    assert.throws(() => publishRepositoryEntry(parent, join(worktreeSkill, 'scripts.js/gidd.mjs')), /installation_repository_mismatch/);
    assert.equal(realpathSync.native(json(ok(s.ensure(worktree, [], worktreeEntry))).entry.target), realpathSync.native(worktree));
    const report = json(s.invoke(s.link(worktree), ['doctor', '--offline'])); assert.equal(report.folder, worktree);
    const nested = join(parent, 'nested'); mkdirSync(nested);
    assert.equal(json(s.ensure(nested)).reason, 'not_git_repository_root');
  } finally { f.dispose(); }
});
