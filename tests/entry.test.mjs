import { test } from 'node:test';
import { statSync, readFileSync } from 'node:fs';
import { assert, compile, copySkill, dirname, existsSync, fixture, findGit, join, json, mkdirSync, ok, ps, run, snapshot, stub, write } from './support/helpers.mjs';

// Encode for the native Windows argv boundary, including terminal backslashes.
const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

function installation(f) {
  const skill = join(f.root, 'installed skill & spaces'), target = join(f.root, '目标 repo & spaces');
  copySkill(skill);
  assert.equal(existsSync(join(skill, 'config.toml')), false, 'Installation must not inherit development configuration');
  mkdirSync(target);
  write(join(target, '.agents/skills/gidd/config.toml'), 'schema_version = 1\n[tools]\ndirectory = "tools"\n');
  const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
  const invoke = (args, env = {}) => run(cmd, ['/d','/s','/c', `""${join(skill, 'gidd.cmd')}" ${args.map(quote).join(' ')}"`], {
    cwd: skill, windowsVerbatimArguments: true, env: { PATH: '', GIDD_LANG: '', LC_ALL: 'en_US.UTF-8', ...env },
  });
  return { skill, target, invoke, args: ['--repository', target] };
}

function sameDirectory(actual, expected) {
  const a = statSync(actual, { bigint: true }), b = statSync(expected, { bigint: true });
  assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino);
}

test('installed shell entry provides offline help and doctor without runtimes or writes', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), before = snapshot(f.root);
    assert.match(ok(s.invoke(['help','zh'])).stdout, /目标仓库/);
    for (const alias of ['--help','-h']) {
      assert.equal(ok(s.invoke([alias,'zh'])).stdout, ok(s.invoke(['help','zh'])).stdout);
    }
    assert.match(ok(s.invoke([])).stdout, /target repository/);
    assert.match(ok(s.invoke([], { GIDD_LANG: 'zh' })).stdout, /目标仓库/);
    assert.match(ok(s.invoke(['help','en'], { GIDD_LANG: 'zh' })).stdout, /target repository/);
    for (const args of [['unknown'], ['help','fr'], ['help','en','extra'], ['doctor'], ['doctor','--repository','.'],
      ['doctor',...s.args,'--repository',s.target], ['doctor',...s.args,'--account','x'], ['setup','python',...s.args],
      ['setup','bun',...s.args,'--offline','x'], ['auth','Octocat',...s.args]]) {
      const result = s.invoke(args);
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(json(result).schema, 'gidd.cli/v1');
    }
    const result = s.invoke(['doctor',...s.args]);
    assert.equal(result.status, 1);
    const report = json(result);
    assert.equal(report.schema, 'gidd.doctor/v1');
    sameDirectory(report.repository, s.target);
    assert.equal(report.checks.find(c => c.id === 'runtime').status, 'missing');
    for (const command of [['identity'],['auth']]) {
      const missing = s.invoke([...command,...s.args]);
      assert.equal(missing.status, 2);
      assert.equal(json(missing).reason, 'runtime_unavailable');
    }
    assert.deepEqual(snapshot(f.root), before, 'Help, invalid commands and missing dependencies must not write or install');
  } finally { f.dispose(); }
});

test('shell setup selects only bun, node or gh and keeps storage independent of installation', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), exe = compile(f.root), bin = join(f.root, 'bin');
    stub(exe, join(bin, 'bun.exe'));
    const bun = json(ok(s.invoke(['setup','bun',...s.args], { PATH: bin })));
    assert.deepEqual(bun.tools.map(t => [t.name, t.action]), [['bun','reused']]);
    assert.equal(existsSync(join(s.target,'tools')), false);
    stub(exe, join(bin, 'node.exe'));
    const node = json(ok(s.invoke(['setup','node',...s.args], { PATH: bin })));
    assert.deepEqual(node.tools.map(t => [t.name, t.action]), [['node','reused']]);
    assert.equal(existsSync(join(s.target,'tools')), false);
    const tools = join(s.target,'tools');
    stub(exe, join(tools,'gh/gh.exe'), undefined, true);
    write(join(tools,'bun/keep.txt'), 'unrelated damaged installation');
    const beforeSkill = snapshot(s.skill), beforeBun = snapshot(join(tools,'bun'));
    const gh = json(ok(s.invoke(['setup','gh',...s.args])));
    assert.deepEqual(gh.tools.map(t => t.name), ['gh']);
    sameDirectory(gh.tools_root, tools);
    assert.deepEqual(snapshot(join(tools,'bun')), beforeBun);
    assert.deepEqual(snapshot(s.skill), beforeSkill);
    write(join(s.target,'.agents/skills/gidd/config.toml'), 'schema_version = 1\n[tools]\ndirectory = "tools"\ngh = { version = "2.99.0", source = "https://github.com/cli/cli/releases" }\n');
    const conflict = s.invoke(['setup','gh',...s.args]);
    assert.equal(conflict.status, 1);
    assert.match(json(conflict).reason, /occupied_or_version_conflicting_target:gh/);
  } finally { f.dispose(); }
});

test('repository installation locates its own Git worktree independently of cwd', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const target = join(f.root, 'installed repo'), git = findGit();
    mkdirSync(target);
    ok(run(git, ['init',target]));
    const worktree = join(f.root, 'linked worktree');
    ok(run(git, ['-C',target,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-m','fixture']));
    ok(run(git, ['-C',target,'worktree','add','-b','fixture',worktree]));
    const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
    const unbound = join(f.root,'user profile/.agents/skills/gidd');
    copySkill(unbound);
    const rejected = run(cmd, ['/d','/s','/c', `""${join(unbound,'gidd.cmd')}" doctor"`], {
      cwd: target, windowsVerbatimArguments: true, env: { PATH: dirname(git) },
    });
    assert.equal(rejected.status,2);
    assert.equal(json(rejected).reason,'repository_required_for_unbound_entry');
    for (const root of [target,worktree]) {
      const skill = join(root,'.agents/skills/gidd');
      copySkill(skill);
      write(join(skill,'config.toml'),'schema_version = 1\n[tools]\ndirectory = "tools"\n');
      const before = snapshot(root);
      const result = run(cmd, ['/d','/s','/c', `""${join(skill,'gidd.cmd')}" doctor"`], {
        cwd: f.root, windowsVerbatimArguments: true, env: { PATH: dirname(git) },
      });
      assert.equal(result.status,1);
      sameDirectory(json(result).repository,root);
      const override = run(cmd, ['/d','/s','/c', `""${join(skill,'gidd.cmd')}" doctor --repository "${f.root}""`], {
        cwd: root, windowsVerbatimArguments: true, env: { PATH: '' },
      });
      assert.equal(override.status,1);
      sameDirectory(json(override).repository,f.root);
      assert.deepEqual(snapshot(root),before);
    }
  } finally { f.dispose(); }
});

test('shell identity and auth preserve JavaScript results, events and exit codes', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), git = findGit();
    const config = join(s.target,'.agents/skills/gidd/config.toml');
    const configured = 'schema_version = 1\n[tools]\ndirectory = "tools"\n[github]\nhostname = "github.com"\naccount = "Octocat"\nremote = "fixture"\n';
    write(config,configured);
    for (const args of [['init'], ['config','user.name','Fixture Author'], ['config','user.email','author@example.test'],
      ['remote','add','fixture','git@github.com:owner/repo.git']]) ok(run(git, ['-C',s.target,...args]));
    const compiled = compile(f.root,'auth-gh.cs'), gh = join(f.root,'bin/gh.exe');
    stub(compiled, gh, 'existing');
    const env = { PATH: [dirname(process.execPath),dirname(git),dirname(gh)].join(';'), GH_CONFIG_DIR: join(f.root,'credentials'),
      GH_TOKEN:'', GITHUB_TOKEN:'', GH_ENTERPRISE_TOKEN:'', GITHUB_ENTERPRISE_TOKEN:'' };
    const before = snapshot(s.target);
    const identity = s.invoke(['identity',...s.args],env);
    assert.equal(identity.status, 1);
    const report = json(identity);
    assert.equal(report.schema,'gidd.identity/v1');
    assert.equal(report.checks.find(c => c.id === 'github.api').status,'ready');
    assert.equal(report.checks.find(c => c.id === 'git.author').details.email,'author@example.test');
    assert.equal(report.checks.find(c => c.id === 'git.remote_read').reason,'https_remote_required');
    assert.equal(json(ok(s.invoke(['auth',...s.args],env))).reason,'already_authenticated');
    write(config,configured.replace('remote = "fixture"\n',''));
    assert.equal(json(ok(s.invoke(['auth',...s.args],env))).reason,'already_authenticated');
    assert.equal(json(s.invoke(['identity',...s.args],env)).reason,'config_missing_github_remote');
    write(config,configured.replace('"Octocat"','"OtherAccount"'));
    const mismatch = s.invoke(['auth',...s.args],env);
    assert.equal(mismatch.status,1);
    assert.equal(json(mismatch).reason,'existing_account_mismatch');
    write(config,configured);
    write(gh + '.mode','success');
    const auth = ok(s.invoke(['auth',...s.args],env));
    assert.equal(json(auth).reason,'authenticated');
    assert.equal(JSON.parse(auth.stderr.trim()).type,'authorization_required');
    assert.deepEqual(snapshot(s.target),before, 'Only the fake gh may write login state');
  } finally { f.dispose(); }
});

test('config shell command creates and edits defaults; identity/auth reject missing config and overrides', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), env = { PATH: dirname(process.execPath) };
    const config = join(s.target,'.agents/skills/gidd/config.toml');
    const original = readFileSync(config,'utf8');
    const missing = s.invoke(['identity',...s.args],env);
    assert.equal(json(missing).reason,'config_missing_github_hostname');
    for (const args of [['identity','--account','Octocat'],['identity','--hostname','github.com'],['identity','--remote','origin'],['auth','Octocat']]) {
      assert.equal(json(s.invoke([...args,...s.args],env)).reason,'github_parameters_moved_to_config');
    }
    for (const [key,value] of [['hostname','github.com'],['account','Octocat'],['remote','upstream']]) {
      const result = json(ok(s.invoke(['config','set',`github.${key}`,value,...s.args],env)));
      assert.equal(result.key,`github.${key}`);
    }
    assert.ok(readFileSync(config,'utf8').startsWith(original));
    assert.equal(json(ok(s.invoke(['config','show',...s.args],env))).content,readFileSync(config,'utf8'));
    const before = snapshot(s.target);
    for (const [key,value] of [['github.account','bad name'],['github.token','secret'],['schema_version','2']]) {
      assert.equal(s.invoke(['config','set',key,value,...s.args],env).status,2);
    }
    assert.deepEqual(snapshot(s.target),before);
    const target = join(f.root,'fresh'); mkdirSync(target);
    const created = s.invoke(['config','set','github.account','Octocat','--repository',target],env);
    ok(created);
    const text = readFileSync(join(target,'.agents/skills/gidd/config.toml'),'utf8');
    assert.match(text,/hostname = "github.com"/); assert.match(text,/remote = "origin"/);
    assert.match(text,/account = "Octocat"/);
    // Pin both runtimes to an unavailable version; config editing must still work.
    for (const key of ['tools.node.version','tools.bun.version']) {
      ok(s.invoke(['config','set',key,'999.0.0',...s.args],env));
    }
    ok(s.invoke(['config','set','tools.directory','new tools',...s.args],env));
    assert.equal(existsSync(join(s.target,'new tools')),false);
    for (const value of ['new tools\\', join(s.target, 'absolute tools') + '\\']) {
      const changed = json(ok(s.invoke(['config','set','tools.directory',value,...s.args],env)));
      assert.equal(changed.value,value);
      assert.ok(readFileSync(config,'utf8').includes(`directory = ${JSON.stringify(value)}`));
      assert.equal(existsSync(join(s.target, 'absolute tools')),false);
    }
    // Also exercise the shell-to-JavaScript boundary independently of gidd.cmd.
    const direct = ps(join(s.skill,'scripts/windows/config.ps1'),
      ['-RepositoryPath',s.target,'-Action','set','-Key','tools.directory','-Value','direct tools\\'],{env});
    assert.equal(json(ok(direct)).value,'direct tools\\');
    ok(s.invoke(['config','show',...s.args],env));
  } finally { f.dispose(); }
});
