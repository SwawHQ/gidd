import { test } from 'node:test';
import { statSync, readFileSync } from 'node:fs';
import { adapter, hash, makeZip, rmSync, product, toolsRoot, assert, compile, copySkill, dirname, existsSync, fixture, findGit, join, json, mkdirSync, ok, ps, run, snapshot, stub, write } from './support/helpers.mjs';
import { selectRuntime } from '../.agents/skills/gidd/scripts/tools.mjs';
import { resolveStorage } from '../.agents/skills/gidd/scripts/storage.mjs';

// Encode for the native Windows argv boundary, including terminal backslashes.
const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

function installation(f) {
  const skill = join(f.root, 'installed skill & spaces'), target = join(f.root, '目标 repo & spaces');
  copySkill(skill);
  assert.equal(existsSync(join(skill, 'config.toml')), false, 'Installation must not inherit development configuration');
  mkdirSync(target);
  write(join(target, '.agents/skills/gidd/config.toml'), 'schema_version = 1\n[tools]\n');
  const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
  const invoke = (args, env = {}) => run(cmd, ['/d','/s','/c', `""${join(skill, 'gidd.cmd')}" ${args.map(quote).join(' ')}"`], {
    cwd: skill, windowsVerbatimArguments: true, env: { PATH: dirname(process.execPath), GIDD_LANG: '', LC_ALL: 'en_US.UTF-8', ...env },
  });
  return { skill, target, invoke, args: ['--repository', target] };
}

function sameDirectory(actual, expected) {
  const a = statSync(actual, { bigint: true }), b = statSync(expected, { bigint: true });
  assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino);
}

test('stage0 forwards argv, stdin, cwd, stderr and the JavaScript exit code', () => {
  const f = fixture();
  try {
    const s = installation(f);
    write(join(s.skill,'scripts/gidd.mjs'), `import {readFileSync} from 'node:fs';\nconsole.log(JSON.stringify({args:JSON.parse(Buffer.from(process.argv[3],'base64').toString('utf8')),input:readFileSync(0,'utf8'),cwd:process.cwd(),exe:process.execPath}));\nconsole.error('stage0 fixture stderr'); process.exit(23);`);
    const value = 'two words "quoted" tail\\';
    const result = ps(join(s.skill,'scripts/windows/entry.ps1'),['config','set','tools.node.source',value,...s.args],{
      cwd: s.target, input: 'stage0 stdin', env: { PATH: dirname(process.execPath) },
    });
    assert.equal(result.status,23,result.stderr);
    const report = json(result); assert.deepEqual(report.args,['config','set','tools.node.source',value,...s.args]);
    assert.equal(report.input,'stage0 stdin'); sameDirectory(report.cwd,s.target); assert.equal(report.exe,process.execPath);
    assert.match(result.stderr,/stage0 fixture stderr/); assert.equal(existsSync(toolsRoot(f.root)),false);
  } finally { f.dispose(); }
});

test('stage0 and JS agree on source priority, short circuit, minima and integrity', { timeout: 60000 }, async () => {
  const f = fixture(), previous = process.env.PATH;
  try {
    const exe = compile(f.root), root = toolsRoot(f.root), bin = join(f.root,'path'), log = join(f.root,'probes.log');
    const config = join(f.root,'.agents/skills/gidd/config.toml');
    const configure = runtime => write(config,`schema_version = 1\n[bootstrap]\nruntime = "${runtime}"\n`);
    const invoke = () => adapter(f.root,{ action: 'bootstrap', repositoryRoot: f.root, responses: {}, downloads: {} },{ env: { PATH: bin, GIDD_TEST_PROBE_LOG: log } });
    process.env.PATH = bin;
    const expect = async (name,source) => {
      rmSync(log,{ force: true });
      const result = json(ok(invoke())); assert.equal(result.id,`tool.${name}`); assert.equal(result.details.source,source);
      const js = await selectRuntime(resolveStorage(f.root)); assert.equal(js.id,result.id); assert.equal(js.details.source,source);
      return readFileSync(log,'utf8');
    };
    configure('bun'); stub(exe,join(root,'node/node.exe'),undefined,true); stub(exe,join(bin,'bun.exe'));
    assert.ok(!(await expect('node','managed')).includes(join(bin,'bun.exe')), 'Managed Node short circuits PATH Bun');
    stub(exe,join(root,'bun/bun.exe'),undefined,true);
    assert.ok(!(await expect('bun','managed')).includes('node.exe'), 'Default Bun short circuits managed Node');
    configure('node'); assert.ok(!(await expect('node','managed')).includes('bun.exe'));
    write(join(root,'node/install.json'),'corrupt');
    const probes = await expect('bun','managed'); assert.ok(!probes.includes('node.exe'), 'Corrupt candidate is never executed');
    rmSync(root,{ recursive: true }); stub(exe,join(bin,'node.exe'));
    await expect('node','path'); configure('bun'); await expect('bun','path');
    write(join(bin,'bun.exe.mode'),'1.0.0'); await expect('node','path');
    write(config,'schema_version = 1\n[tools]\nnode = { version = "99.0.0", source = "https://nodejs.org/dist" }\n');
    const result = invoke(); assert.notEqual(result.status,0); assert.match(result.stderr,/unexpected_metadata_request/);
    assert.equal(existsSync(join(root,'bun')),false);
    write(config,'schema_version = 1\n[bootstrap]\nruntime = ""\n'); assert.match(invoke().stderr,/config_invalid_bootstrap_runtime/);
    // Finding the managed path through PATH still requires the installation record.
    configure('bun'); rmSync(root,{ recursive: true, force: true });
    stub(exe,join(root,'bun/bun.exe'),undefined,true); write(join(root,'bun/install.json'),'corrupt');
    const bypass = adapter(f.root,{ action: 'bootstrap', repositoryRoot: f.root, responses: {}, downloads: {} },{ env: { PATH: join(root,'bun'), GIDD_TEST_PROBE_LOG: log } });
    assert.match(bypass.stderr,/occupied_or_version_conflicting_target:bun/);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; f.dispose(); }
});

test('stage0 installs the configured default using verified fixtures and reuses it on retry', { timeout: 60000 }, () => {
  const f = fixture();
  try {
    const exe = compile(f.root), config = join(f.root,'.agents/skills/gidd/config.toml');
    for (const name of ['bun','node']) {
      const home = join(f.root,name), version = name === 'bun' ? '1.4.2' : '24.19.0'; mkdirSync(home);
      const archiveName = name === 'bun' ? 'bun-windows-x64.zip' : `node-v${version}-win-x64.zip`;
      const archive = join(f.root,archiveName), license = join(f.root,`${name}-LICENSE`); write(license,'fixture license\n');
      const entry = name === 'bun' ? 'bun-windows-x64/bun.exe' : `node-v${version}-win-x64/node.exe`;
      makeZip(f.root,archive,[{ name: entry, source: exe }, ...(name === 'node' ? [{ name: `node-v${version}-win-x64/LICENSE`, source: license }] : [])]);
      const checksum = name === 'bun' ? `https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt` : `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
      const url = name === 'bun' ? `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${archiveName}` : `https://nodejs.org/dist/v${version}/${archiveName}`;
      const licenseUrl = `https://raw.githubusercontent.com/oven-sh/bun/bun-v${version}/LICENSE.md`;
      const responses = { [checksum]: `${hash(archive)}  ${archiveName}\n`, [licenseUrl]: readFileSync(license,'utf8') }, downloads = { [url]: archive, [licenseUrl]: license };
      write(config,`schema_version = 1\n[bootstrap]\nruntime = "${name}"\n[tools]\n${name} = { version = "${version}", source = "${name === 'bun' ? 'https://github.com/oven-sh/bun/releases' : 'https://nodejs.org/dist'}" }\n`);
      const before = hash(config), spec = { action: 'bootstrap', repositoryRoot: f.root, responses, downloads }, env = { PATH: '', USERPROFILE: home };
      assert.equal(json(ok(adapter(f.root,spec,{ env }))).id,`tool.${name}`);
      assert.equal(hash(config),before); assert.equal(existsSync(join(toolsRoot(home),name,'install.json')),true);
      assert.equal(existsSync(join(toolsRoot(home),name === 'bun' ? 'node' : 'bun')),false);
      const snapshotBefore = snapshot(home);
      ok(adapter(f.root,{ ...spec, responses: {}, downloads: {} },{ env }));
      assert.deepEqual(snapshot(home),snapshotBefore, 'Next launch is read only and needs no metadata/download');
      const failedHome = join(f.root,`${name}-failed`); mkdirSync(failedHome);
      const bad = { ...responses, [checksum]: `${'0'.repeat(64)}  ${archiveName}\n` };
      assert.match(adapter(f.root,{ ...spec, responses: bad },{ env: { ...env, USERPROFILE: failedHome } }).stderr,/download_hash_mismatch/);
      assert.equal(existsSync(join(toolsRoot(failedHome),name)),false);
      ok(adapter(f.root,spec,{ env: { ...env, USERPROFILE: failedHome } }));
    }
  } finally { f.dispose(); }
});

test('installed shell entry provides help and doctor reuse a PATH runtime without writes', { timeout: 30000 }, () => {
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
    assert.equal(report.checks.find(c => c.id === 'runtime').status, 'ready');
    for (const command of [['identity'],['auth']]) {
      const missing = s.invoke([...command,...s.args]);
      assert.equal(missing.status, 2);
      assert.equal(json(missing).reason, 'config_missing_github_hostname');
    }
    assert.deepEqual(snapshot(f.root), before, 'Help, invalid commands and missing dependencies must not write or install');
  } finally { f.dispose(); }
});

test('shell setup selects only bun, node or gh and keeps storage independent of installation', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), exe = compile(f.root), bin = join(f.root, 'bin');
    stub(exe, join(bin, 'bun.exe'));
    const bun = json(ok(product(['setup','bun',...s.args], { env: { PATH: bin } })));
    assert.deepEqual(bun.tools.map(t => [t.name, t.action]), [['bun','reused']]);
    assert.equal(existsSync(toolsRoot(f.root)), false);
    stub(exe, join(bin, 'node.exe'));
    const node = json(ok(product(['setup','node',...s.args], { env: { PATH: bin } })));
    assert.deepEqual(node.tools.map(t => [t.name, t.action]), [['node','reused']]);
    assert.equal(existsSync(toolsRoot(f.root)), false);
    const tools = toolsRoot(f.root);
    stub(exe, join(tools,'gh/gh.exe'), undefined, true);
    write(join(tools,'bun/keep.txt'), 'unrelated damaged installation');
    const beforeSkill = snapshot(s.skill), beforeBun = snapshot(join(tools,'bun'));
    const gh = json(ok(s.invoke(['setup','gh',...s.args])));
    assert.deepEqual(gh.tools.map(t => t.name), ['gh']);
    sameDirectory(gh.tools_root, tools);
    assert.deepEqual(snapshot(join(tools,'bun')), beforeBun);
    assert.deepEqual(snapshot(s.skill), beforeSkill);
    write(join(s.target,'.agents/skills/gidd/config.toml'), 'schema_version = 1\n[tools]\ngh = { version = "2.99.0", source = "https://github.com/cli/cli/releases" }\n');
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
      cwd: target, windowsVerbatimArguments: true, env: { PATH: [dirname(process.execPath),dirname(git)].join(';') },
    });
    assert.equal(rejected.status,2);
    assert.equal(json(rejected).reason,'repository_required_for_unbound_entry');
    for (const root of [target,worktree]) {
      const skill = join(root,'.agents/skills/gidd');
      copySkill(skill);
      write(join(skill,'config.toml'),'schema_version = 1\n[tools]\n');
      const before = snapshot(root);
      const result = run(cmd, ['/d','/s','/c', `""${join(skill,'gidd.cmd')}" doctor"`], {
        cwd: f.root, windowsVerbatimArguments: true, env: { PATH: [dirname(process.execPath),dirname(git)].join(';') },
      });
      assert.equal(result.status,1);
      sameDirectory(json(result).repository,root);
      const override = run(cmd, ['/d','/s','/c', `""${join(skill,'gidd.cmd')}" doctor --repository "${f.root}""`], {
        cwd: root, windowsVerbatimArguments: true, env: { PATH: dirname(process.execPath) },
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
    const configured = 'schema_version = 1\n[tools]\n[github]\nhostname = "github.com"\naccount = "Octocat"\nremote = "fixture"\n';
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
    assert.equal(s.invoke(['config','set','tools.directory','custom',...s.args],env).status,2);
    const direct = ps(join(s.skill,'scripts/windows/config.ps1'),
      ['-RepositoryPath',s.target,'-Action','set','-Key','tools.node.source','-Value','https://mirror.example/node'],{env});
    assert.equal(json(ok(direct)).value,'https://mirror.example/node');
    ok(s.invoke(['config','show',...s.args],env));
  } finally { f.dispose(); }
});
