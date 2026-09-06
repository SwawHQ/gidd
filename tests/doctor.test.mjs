import { test } from 'bun:test';
import { statSync } from 'node:fs';
import { assert, code, compile, dirname, existsSync, findGit, fixture, join, json, mkdirSync, ok, ps, rmSync, run, snapshot, stub, write } from './support/helpers.mjs';

test('doctor: dependency matrix, repository states, read-only checks and redaction', () => {
  const f = fixture();
  try {
    const git = findGit(), gitBin = dirname(git), exe = compile(f.root);
    const skills = join(f.root, '技能 with spaces'), repository = join(f.root, 'repo 中文 & spaces');
    const fakeBin = join(f.root, 'fake-bin'), emptyBin = join(f.root, 'empty-bin');
    for (const dir of [skills, repository, fakeBin, emptyBin]) mkdirSync(dir, { recursive: true });
    const gitOnly = `${emptyBin};${gitBin}`, toolPath = `${fakeBin};${gitBin}`;
    ok(run(git, ['-C', repository, 'init', '--quiet']));
    const check = (report, id) => {
      const matches = report.checks.filter(item => item.id === id);
      assert.equal(matches.length, 1, id); return matches[0];
    };
    const runCase = (name, path, validate, target = repository, env = {}) => {
      const before = snapshot(f.root);
      const result = ps(join(code, 'doctor.ps1'), ['-RepositoryPath', target, '-UserSkillsRoot', skills], { env: { PATH: path, ...env } });
      const report = json(result);
      assert.equal(report.schema, 'gidd.doctor/v1');
      assert.deepEqual(snapshot(f.root), before, `Doctor wrote fixture: ${name}`);
      validate(report, result.status);
      console.log(`PASS doctor: ${name}`);
    };
    runCase('all dependencies missing', emptyBin, (r, status) => {
      assert.equal(status, 1);
      for (const id of ['tool.git','tool.node','tool.bun','tool.gh','runtime']) assert.equal(check(r,id).status,'missing');
      assert.equal(check(r,'repository').status,'not_checked');
    });
    stub(exe, join(fakeBin,'node.exe'),'v22.0.0'); stub(exe, join(fakeBin,'gh.exe'),'gh version 2.98.0 (test)');
    runCase('Node alone, unborn repository, missing config',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'runtime').details.selected,'tool.node');
      assert.equal(check(r,'repository.history').reason,'unborn_branch'); assert.equal(check(r,'repository.config').status,'missing');
    });
    stub(exe,join(skills,'gidd.tools/bun/bun.exe'),'1.2.15',true);
    stub(exe,join(skills,'gidd.tools/gh/gh.exe'),'gh version 2.98.0 (test)',true);
    runCase('Bun alone from managed tools',gitOnly,r => {
      assert.equal(check(r,'runtime').details.selected,'tool.bun'); assert.equal(check(r,'tool.gh').details.source,'gidd.tools');
    });
    runCase('PATH Node preferred over managed Bun',toolPath,r => assert.equal(check(r,'runtime').details.selected,'tool.node'));
    stub(exe,join(fakeBin,'bun.exe'),'1.2.15');
    runCase('PATH Bun tie preference',toolPath,r => assert.equal(check(r,'runtime').details.selected,'tool.bun'));
    write(join(fakeBin,'node.exe.mode'),'v18.0.0'); write(join(fakeBin,'bun.exe.mode'),'fail'); write(join(fakeBin,'gh.exe.mode'),'not gh');
    runCase('old, failing and malformed PATH tools fall back',toolPath,r => {
      assert.equal(check(r,'tool.node').status,'invalid');
      for (const id of ['tool.bun','tool.gh']) assert.equal(check(r,id).details.source,'gidd.tools');
      assert.ok(!JSON.stringify(r).includes('private-test-secret'));
    });
    write(join(fakeBin,'gh.exe.mode'),'hang');
    const start = Date.now();
    runCase('hung executable times out and falls back',toolPath,r => assert.equal(check(r,'tool.gh').details.rejected[0].reason,'process_timeout'));
    assert.ok(Date.now()-start < 20000,'Bounded tool probe');
    write(join(fakeBin,'gh.exe.mode'),'gh version 2.98.0 (test)'); write(join(fakeBin,'bun.exe'),'not an executable');
    runCase('broken executable falls back',toolPath,r => assert.equal(check(r,'tool.bun').details.rejected[0].reason,'process_start_failed'));
    runCase('ordinary directory is not a repository',toolPath,r => {
      assert.equal(check(r,'repository').status,'invalid'); assert.equal(check(r,'repository.config').status,'not_checked');
    },skills);
    ok(run(git,['-C',repository,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','--quiet','-m','fixture']));
    ok(run(git,['-C',repository,'remote','add','origin','https://github.com/SwawHQ/gidd.git']));
    ok(run(git,['-C',repository,'remote','add','private','https://username:private-test-secret@example.invalid/private.git']));
    const config = join(repository,'.agents/skills/gidd/config.toml'); write(config,'deliberately invalid TOML = [');
    runCase('local readiness, explicit target and redacted remote',toolPath,(r,status) => {
      assert.equal(status,0); assert.equal(r.status,'local_ready');
      for (const id of ['repository.config.validation','github.identity']) assert.equal(check(r,id).status,'not_checked');
      assert.equal(check(r,'repository.remotes').details.remotes.find(x=>x.name==='origin').github_repository,'SwawHQ/gidd');
      assert.ok(!JSON.stringify(r).includes('private-test-secret'));
    },repository,{GIT_DIR:join(f.root,'nonexistent-git-dir')});
    const nested = join(repository,'nested directory'); mkdirSync(nested);
    runCase('nested target resolves repository root',toolPath,r => {
      // Git expands Windows 8.3 names; compare file identity instead of spelling.
      const actual=statSync(check(r,'repository.config').details.path,{bigint:true});
      const expected=statSync(config,{bigint:true});
      assert.notEqual(expected.ino,0n); assert.equal(actual.dev,expected.dev); assert.equal(actual.ino,expected.ino);
    },nested);
    runCase('missing target directory',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'repository').reason,'directory_missing'); assert.equal(check(r,'runtime').status,'ready');
    },join(f.root,'not-created'));
    rmSync(config); mkdirSync(config);
    runCase('config path is a directory',toolPath,(r,status) => { assert.equal(status,1); assert.equal(check(r,'repository.config').status,'invalid'); });
    assert.ok(existsSync(config));
  } finally { f.dispose(); }
},60000);
