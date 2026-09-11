import { test } from 'node:test';
import { statSync } from 'node:fs';
import { prepare, diagnosis, toolsRoot, assert, code, compile, dirname, existsSync, findGit, fixture, join, json, mkdirSync, ok, ps, rmSync, run, snapshot, stub, write } from './support/helpers.mjs';

test('doctor: dependency matrix, repository states, read-only checks and redaction', { timeout: 120000 }, () => {
  const f = fixture();
  try {
    const git = findGit(), gitBin = dirname(git), exe = compile(f.root);
    const skills = join(f.root, '技能 with spaces'), repository = join(f.root, 'repo 中文 & spaces');
    const fakeBin = join(f.root, 'fake-bin'), emptyBin = join(f.root, 'empty-bin');
    for (const dir of [skills, repository, fakeBin, emptyBin]) mkdirSync(dir, { recursive: true });
    const gitOnly = `${emptyBin};${gitBin}`, toolPath = `${fakeBin};${gitBin}`;
    ok(run(git, ['-C', repository, 'init', '--quiet']));
    const config=join(repository,'.agents/skills/gidd/config.toml');
    const toolConfig = 'schema_version = 1\n[tools]\n';
    const validConfig = toolConfig + '[github]\nhostname = "github.com"\naccount = "Octocat"\nremote = "origin"\n';
    write(config,validConfig);
    const check = (report, id) => {
      const matches = report.checks.filter(item => item.id === id);
      assert.equal(matches.length, 1, id); return matches[0];
    };
    const runCase = (name, path, validate, target = repository, env = {}) => {
      const before = snapshot(f.root);
      const result = diagnosis(target, { env: { PATH: path, ...env } });
      const report = json(result);
      assert.equal(report.schema, 'gidd.doctor/v1');
      assert.deepEqual(snapshot(f.root), before, `Doctor wrote fixture: ${name}`);
      validate(report, result.status);
      console.log(`PASS doctor: ${name}`);
    };
    runCase('all dependencies missing', emptyBin, (r, status) => {
      assert.equal(status, 1);
      for (const id of ['tool.git','tool.node','tool.bun','tool.gh']) assert.equal(check(r,id).status,'missing');
      assert.equal(check(r,'runtime').status,'ready');
      assert.equal(check(r,'runtime').details.compatibility_checked,false);
      assert.equal(check(r,'repository').status,'not_checked');
      assert.equal(check(r,'repository.config.github').status,'ready');
      for (const id of ['repository.history','repository.remotes','repository.remote']) assert.equal(check(r,id).status,'not_checked');
    });
    stub(exe, join(fakeBin,'node.exe'),'v24.19.0'); stub(exe, join(fakeBin,'gh.exe'),'gh version 2.98.0 (test)');
    rmSync(config);
    runCase('Node alone, unborn repository, missing config',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'runtime').details.selected,process.versions.bun?'tool.bun':'tool.node');
      assert.equal(check(r,'repository.history').reason,'unborn_branch'); assert.equal(check(r,'repository.config').status,'missing');
      assert.equal(check(r,'repository.remotes').reason,'no_remotes');
    });
    write(config,validConfig);
    stub(exe,join(toolsRoot(f.root),'bun/bun.exe'),'1.4.2',true);
    stub(exe,join(toolsRoot(f.root),'gh/gh.exe'),'gh version 2.98.0 (test)',true);
    runCase('Bun alone from managed tools',gitOnly,r => {
      assert.equal(check(r,'runtime').details.selected,process.versions.bun?'tool.bun':'tool.node'); assert.equal(check(r,'tool.gh').details.source,'managed');
      assert.equal(check(r,'repository.remote').reason,'configured_remote_missing');
    });
    runCase('managed and PATH observations do not change the current runtime',toolPath,r => assert.equal(check(r,'runtime').details.selected,process.versions.bun?'tool.bun':'tool.node'));
    stub(exe,join(fakeBin,'bun.exe'),'1.4.2');
    runCase('PATH observations preserve the current runtime',toolPath,r => assert.equal(check(r,'runtime').details.selected,process.versions.bun?'tool.bun':'tool.node'));
    write(join(fakeBin,'node.exe.mode'),'v18.0.0'); write(join(fakeBin,'bun.exe.mode'),'fail'); write(join(fakeBin,'gh.exe.mode'),'not gh');
    runCase('old, failing and malformed PATH tools fall back',toolPath,r => {
      assert.equal(check(r,'tool.node').status,'ready');
      for (const id of ['tool.bun','tool.gh']) assert.equal(check(r,id).details.source,'managed');
      assert.ok(!JSON.stringify(r).includes('private-test-secret'));
    });
    write(join(fakeBin,'gh.exe.mode'),'hang');
    const start = Date.now();
    runCase('hung executable times out and falls back',toolPath,r => assert.equal(check(r,'tool.gh').details.source,'managed'));
    assert.ok(Date.now()-start < 20000,'Bounded tool probe');
    write(join(fakeBin,'gh.exe.mode'),'gh version 2.98.0 (test)'); write(join(fakeBin,'bun.exe'),'not an executable');
    runCase('broken executable falls back',toolPath,r => assert.equal(check(r,'tool.bun').details.source,'managed'));
    runCase('ordinary directory is not a repository',toolPath,r => {
      assert.equal(check(r,'repository').reason,'not_git_repository'); assert.equal(check(r,'repository.config').status,'missing');
    },skills);
    write(join(skills,'.agents/skills/gidd/config.toml'), validConfig);
    runCase('copied configuration does not make an ordinary directory a repository',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'repository').reason,'not_git_repository');
      assert.equal(check(r,'repository.config.github').status,'ready');
      assert.equal(check(r,'repository.remote').status,'not_checked');
    },skills);
    const bare = join(f.root,'bare.git');
    ok(run(git,['init','--bare','--quiet',bare]));
    runCase('bare repository is not a working tree',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'repository').reason,'not_worktree');
    },bare);
    const broken = join(f.root,'broken repository');
    write(join(broken,'.git'),'gitdir: nowhere\n');
    runCase('broken Git marker is not treated as a new ordinary directory',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'repository').reason,'not_readable_worktree');
    },broken);
    ok(run(git,['-C',repository,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','--quiet','-m','fixture']));
    ok(run(git,['-C',repository,'remote','add','origin','https://github.com/SwawHQ/gidd.git']));
    ok(run(git,['-C',repository,'remote','add','private','https://username:private-test-secret@example.invalid/private.git']));
    write(config,validConfig);
    ok(prepare(repository,'git',{env:{PATH:gitBin}})); ok(prepare(repository,'gh',{env:{PATH:''}}));
    runCase('local readiness, explicit target and redacted remote',toolPath,(r,status) => {
      assert.equal(status,0); assert.equal(r.status,'local_ready');
      assert.equal(check(r,'repository.config.validation').status,'ready');
      assert.equal(check(r,'repository.config.github').status,'ready');
      assert.equal(check(r,'repository.remote').reason,'configured_remote_host_matches');
      assert.equal(check(r,'github.identity').status,'not_checked');
      assert.equal(check(r,'repository.remotes').details.remotes.find(x=>x.name==='origin').github_repository,'SwawHQ/gidd');
      assert.ok(!JSON.stringify(r).includes('private-test-secret'));
    },repository,{GIT_DIR:join(f.root,'nonexistent-git-dir')});
    write(config,toolConfig);
    runCase('valid tool schema does not imply complete GitHub configuration',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'repository.config.validation').status,'ready');
      assert.deepEqual(check(r,'repository.config.github').details.missing_fields,['hostname','account','remote']);
      assert.equal(check(r,'repository.remote').reason,'github_remote_configuration_required');
    });
    for (const key of ['hostname','account','remote']) {
      write(config,validConfig.replace(new RegExp('^' + key + ' = .*\\n','m'),''));
      runCase('missing GitHub field: ' + key,toolPath,(r,status) => {
        assert.equal(status,1); assert.deepEqual(check(r,'repository.config.github').details.missing_fields,[key]);
        assert.equal(check(r,'repository.remote').status,key === 'account' ? 'ready' : 'not_checked');
      });
      write(config,validConfig.replace(new RegExp('^' + key + ' = .*','m'),key + ' = "private-test-secret:invalid"'));
      runCase('invalid GitHub field: ' + key,toolPath,(r,status) => {
        assert.equal(status,1); assert.deepEqual(check(r,'repository.config.github').details.invalid_fields,[key]);
        assert.ok(!JSON.stringify(r).includes('private-test-secret'));
      });
    }
    write(config,validConfig.replace('remote = "origin"','remote = "absent"'));
    runCase('other remotes do not satisfy the configured remote',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'repository.remotes').status,'ready');
      assert.equal(check(r,'repository.remote').reason,'configured_remote_missing');
    });
    write(config,validConfig);
    for (const [url,reason] of [
      ['https://GitHub.com/SwawHQ/gidd.git/','configured_remote_host_matches'],
      ['git@github.com:SwawHQ/gidd.git','configured_remote_host_matches'],
      ['ssh://git@github.com/SwawHQ/gidd.git','configured_remote_host_matches'],
      ['ssh://git@github.com:22/SwawHQ/gidd','configured_remote_host_matches'],
      ['https://example.invalid/SwawHQ/gidd.git','remote_hostname_mismatch'],
      ['https://username:private-test-secret@github.com/SwawHQ/gidd.git','unsupported_remote_url'],
      ['https://github.com/SwawHQ/gidd?token=private-test-secret','unsupported_remote_url'],
      ['https://github.com/SwawHQ/gidd#private-test-secret','unsupported_remote_url'],
      ['https://github.com/SwawHQ/../gidd','unsupported_remote_url'],
      ['../local-repository','unsupported_remote_url'],
    ]) {
      ok(run(git,['-C',repository,'remote','set-url','origin',url]));
      runCase('selected remote: ' + reason,toolPath,(r,status) => {
        assert.equal(status,reason === 'configured_remote_host_matches' ? 0 : 1);
        assert.equal(check(r,'repository.remote').reason,reason);
        if (status === 0) assert.equal(check(r,'repository.remote').details.github_repository,'SwawHQ/gidd');
        assert.ok(!JSON.stringify(r).includes('private-test-secret'));
      });
    }
    write(config,validConfig.replace('github.com','github.example.invalid'));
    ok(run(git,['-C',repository,'remote','set-url','origin','ssh://git@github.example.invalid/Team/Repo.git']));
    runCase('configured enterprise hostname is checked locally',toolPath,(r,status) => {
      assert.equal(status,0); assert.equal(check(r,'repository.remote').details.github_repository,'Team/Repo');
      assert.equal(check(r,'github.identity').status,'not_checked');
    });
    write(config,validConfig);
    ok(run(git,['-C',repository,'config','--replace-all','remote.origin.url','https://github.com/SwawHQ/gidd.git']));
    ok(run(git,['-C',repository,'config','--add','remote.origin.url','https://github.com/Other/Repo.git']));
    runCase('multiple fetch URLs do not silently choose a repository',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'repository.remote').reason,'remote_url_ambiguous');
    });
    ok(run(git,['-C',repository,'config','--replace-all','remote.origin.url','https://github.com/SwawHQ/gidd.git']));
    const nested = join(repository,'nested directory'); mkdirSync(nested);
    runCase('nested target resolves repository root',toolPath,r => {
      // Git expands Windows 8.3 names; compare file identity instead of spelling.
      const actual=statSync(check(r,'repository.config').details.path,{bigint:true});
      const expected=statSync(config,{bigint:true});
      assert.notEqual(expected.ino,0n); assert.equal(actual.dev,expected.dev); assert.equal(actual.ino,expected.ino);
    },nested);
    write(config,'deliberately invalid TOML = [');
    runCase('invalid configuration does not pass or select default storage',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'repository.config.validation').status,'invalid');
      assert.equal(check(r,'tools.storage').details.managed_tools_checked,false);
      assert.equal(check(r,'tool.git').status,'ready'); assert.equal(check(r,'github.identity').status,'not_checked');
    });
    runCase('missing target directory',toolPath,(r,status) => {
      assert.equal(status,1); assert.equal(check(r,'repository').reason,'directory_missing'); assert.equal(check(r,'tool.gh').status,'ready');
    },join(f.root,'not-created'));
    rmSync(config); mkdirSync(config);
    runCase('config path is a directory',toolPath,(r,status) => { assert.equal(status,1); assert.equal(check(r,'repository.config').status,'invalid'); });
    assert.ok(existsSync(config));
  } finally { f.dispose(); }
});
