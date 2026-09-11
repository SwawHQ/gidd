import { test } from 'node:test';
import { statSync, readFileSync, readdirSync, lstatSync, symlinkSync } from 'node:fs';
import { adapter, code, hash, makeZip, rmSync, product, toolsRoot, assert, compile, copySkill, dirname, existsSync, fixture, findGit, join, json, mkdirSync, ok, ps, run, snapshot, stub, write } from './support/helpers.mjs';
import { checkRuntime } from '../.agents/skills/gidd/scripts/runtime-compat.mjs';

// Encode for the native Windows argv boundary, including terminal backslashes.
const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

function installation(f, prepare = true) {
  const skill = join(f.root, 'installed skill & spaces'), target = join(f.root, '目标 repo & spaces');
  copySkill(skill);
  assert.equal(existsSync(join(skill, 'config.toml')), false, 'Installation must not inherit development configuration');
  assert.equal(existsSync(join(skill, 'config.example.toml')), true, 'Installation must include the configuration template');
  mkdirSync(target);
  write(join(target, '.agents/skills/gidd/config.toml'), 'schema_version = 1\n[tools]\n');
  const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
  const invoke = (args, env = {}, options = {}) => run(cmd, ['/d','/s','/c', `""${join(skill, 'gidd.cmd')}" ${args.map(quote).join(' ')}"`], {
    cwd: skill, windowsVerbatimArguments: true, ...options, env: { PATH: dirname(process.execPath), GIDD_LANG: '', LC_ALL: 'en_US.UTF-8', ...env },
  });
  if (prepare) ok(invoke(['bootstrap','--yes','--repository',target]));
  return { skill, target, invoke, args: ['--repository', target] };
}

function sameDirectory(actual, expected) {
  const a = statSync(actual, { bigint: true }), b = statSync(expected, { bigint: true });
  assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino);
}

test('compatibility is a standalone bootstrap method with internal version policy', () => {
  for (const [versions,status] of [[{bun:'1.4.2'},'compatible'],[{bun:'1.4.1'},'incompatible'],
    [{bun:'2.0.0'},'compatible'],[{node:'24.19.0'},'compatible'],[{node:'24.18.9'},'incompatible'],
    [{node:'25.0.0'},'compatible'],[{node:'unknown'},'incompatible']]) assert.equal(checkRuntime(versions).status,status);
  assert.equal(json(ok(run(process.execPath,[join(code,'../runtime-compat.mjs')]))).status,'compatible');
});

test('bootstrap is read only without yes; ordinary commands require the generated launcher', () => {
  const f=fixture();
  try {
    const s=installation(f,false), before=snapshot(f.root);
    const report=json(s.invoke(['bootstrap',...s.args],{PATH:''}));
    assert.equal(report.status,'needs_bootstrap'); assert.equal(report.runtime,null);
    assert.equal(report.read_only,true); assert.deepEqual(snapshot(f.root),before);
    const compatible=json(s.invoke(['bootstrap',...s.args]));
    assert.equal(compatible.runtime.status,'ready'); assert.equal(compatible.launcher_matches,false);
    assert.equal(json(s.invoke(['help'])).reason,'bootstrap_required');
    assert.equal(json(s.invoke(['bootstrap','--reinstall'])).reason,'reinstall_requires_yes');
    for (const args of [['--yes','--yes'],['--unknown'],['--repository']]) assert.equal(s.invoke(['bootstrap',...args]).status,2);
    assert.deepEqual(snapshot(f.root),before);
    const published=json(ok(s.invoke(['bootstrap','--yes',...s.args])));
    assert.equal(published.launcher_action,'published');
    const launcher=join(toolsRoot(f.root),'js_exec.cmd'), mtime=statSync(launcher).mtimeMs;
    assert.doesNotMatch(readFileSync(launcher,'utf8'), /chcp|[^\x00-\x7f]/i, 'Ordinary startup must not change the console code page');
    assert.equal(json(ok(s.invoke(['bootstrap',...s.args]))).launcher_matches,true);
    assert.equal(json(ok(s.invoke(['bootstrap','--yes',...s.args]))).launcher_action,'reused');
    assert.equal(statSync(launcher).mtimeMs,mtime);
  } finally {f.dispose();}
});

test('shared launcher forwards raw argv, stdin, cwd, stderr and exit without PowerShell or compatibility', () => {
  const f=fixture();
  try {
    const s=installation(f);
    write(join(s.skill,'scripts/gidd.mjs'), `import {readFileSync} from 'node:fs'; console.log(JSON.stringify({args:process.argv.slice(2),input:readFileSync(0,'utf8'),cwd:process.cwd(),exe:process.execPath})); console.error('launcher fixture stderr'); process.exit(23);`);
    rmSync(join(s.skill,'scripts/runtime-compat.mjs'));
    rmSync(join(s.skill,'scripts/windows'),{recursive:true});
    const before=snapshot(toolsRoot(f.root));
    const args=['two words','','--help','tail\\','a & b','a^b','!literal!','two "quotes"'];
    const result=s.invoke(args,{PATH:''},{input:'launcher stdin',cwd:s.target});
    assert.equal(result.status,23,result.stderr);
    const report=json(result); assert.deepEqual(report.args,args);
    assert.equal(report.input,'launcher stdin'); sameDirectory(report.cwd,s.target); assert.equal(report.exe,process.execPath);
    assert.match(result.stderr,/launcher fixture stderr/);
    assert.deepEqual(snapshot(toolsRoot(f.root)),before);
    // The shared launcher runs a different repository's script, without rebinding.
    const other=join(f.root,'other repo/.agents/skills/gidd'); copySkill(other);
    const otherCmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    assert.match(ok(run(otherCmd,['/d','/s','/c',`""${join(other,'gidd.cmd')}" help en"`],{windowsVerbatimArguments:true,env:{PATH:''}})).stdout,/target repository/);
  } finally {f.dispose();}
});

test('bootstrap alone selects managed Bun, managed Node, PATH Bun, PATH Node and validates before execution', () => {
  const f=fixture();
  try {
    const exe=compile(f.root), root=toolsRoot(f.root), bin=join(f.root,'bin'), log=join(f.root,'probes.log');
    const invoke=(extra={},path=bin)=>adapter(f.root,{action:'bootstrap',repositoryRoot:f.root,responses:{},downloads:{},...extra},{env:{PATH:path,GIDD_TEST_PROBE_LOG:log}});
    const expect=(name,source,extra={})=>{
      rmSync(log,{force:true}); const r=json(ok(invoke(extra))).runtime;
      assert.equal(r.id,`tool.${name}`); assert.equal(r.details.source,source); return readFileSync(log,'utf8');
    };
    stub(exe,join(root,'node/node.exe'),undefined,true); stub(exe,join(bin,'bun.exe'));
    assert.ok(!expect('node','managed').includes(join(bin,'bun.exe')));
    stub(exe,join(root,'bun/bun.exe'),undefined,true);
    assert.ok(!expect('bun','managed').includes('node.exe'));
    assert.ok(!expect('node','managed',{node:true}).includes('bun.exe'));
    write(join(root,'bun/install.json'),'corrupt');
    assert.ok(!expect('node','managed').includes('bun.exe'));
    rmSync(root,{recursive:true}); stub(exe,join(bin,'node.exe'));
    expect('bun','path'); expect('node','path',{node:true});
    write(join(bin,'bun.exe.mode'),'1.0.0'); expect('node','path');
    stub(exe,join(root,'bun/bun.exe'),undefined,true); write(join(root,'bun/install.json'),'corrupt');
    assert.equal(json(ok(invoke({},join(root,'bun')))).runtime,null,'Managed candidates found through PATH still need integrity validation');
    assert.match(invoke({yes:true},join(root,'bun')).stderr,/occupied_or_unknown_target:bun/);
  } finally {f.dispose();}
});

test('bootstrap installs, repairs and rolls back managed runtimes before publishing the launcher', {timeout:120000}, () => {
  const f=fixture();
  try {
    const exe=compile(f.root), config=join(f.root,'.agents/skills/gidd/config.toml');
    for (const name of ['bun','node']) {
      const home=join(f.root,name), version=name==='bun'?'1.4.2':'24.19.0'; mkdirSync(home);
      const archiveName=name==='bun'?'bun-windows-x64.zip':`node-v${version}-win-x64.zip`;
      const archive=join(f.root,archiveName), license=join(f.root,`${name}-LICENSE`); write(license,'fixture license\n');
      const entry=name==='bun'?'bun-windows-x64/bun.exe':`node-v${version}-win-x64/node.exe`;
      makeZip(f.root,archive,[{name:entry,source:exe},...(name==='node'?[{name:`node-v${version}-win-x64/LICENSE`,source:license}]:[])]);
      const checksum=name==='bun'?`https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt`:`https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
      const url=name==='bun'?`https://github.com/oven-sh/bun/releases/download/bun-v${version}/${archiveName}`:`https://nodejs.org/dist/v${version}/${archiveName}`;
      const licenseUrl=`https://raw.githubusercontent.com/oven-sh/bun/bun-v${version}/LICENSE.md`;
      const metadata=name==='bun'?{'https://api.github.com/repos/oven-sh/bun/releases/latest':JSON.stringify({tag_name:`bun-v${version}`,draft:false,prerelease:false})}:
        {'https://nodejs.org/dist/index.json':JSON.stringify([{version:`v${version}`,lts:'Fixture',files:['win-x64-zip']}])};
      const responses={...metadata,[checksum]:`${hash(archive)}  ${archiveName}\n`,[licenseUrl]:readFileSync(license,'utf8')}, downloads={[url]:archive,[licenseUrl]:license};
      write(config,'schema_version = 1\n[tools]\n');
      const spec={action:'bootstrap',repositoryRoot:f.root,responses,downloads,yes:true,node:name==='node'}, env={PATH:'',USERPROFILE:home};
      const invoke=(extra={})=>adapter(f.root,{...spec,...extra},{env});
      const before=hash(config), result=json(ok(invoke())), root=toolsRoot(home), target=join(root,name), launcher=join(root,'js_exec.cmd');
      assert.equal(result.runtime.id,`tool.${name}`); assert.equal(hash(config),before); assert.equal(existsSync(join(root,name==='bun'?'node':'bun')),false);
      const healthy=snapshot(home); assert.equal(json(ok(invoke({responses:{},downloads:{}}))).runtime_action,'reused');
      assert.deepEqual(snapshot(home),healthy);
      const launcherHash=hash(launcher), executable=join(target,`${name}.exe`);
      write(executable,'damaged GIDD executable');
      assert.equal(json(ok(invoke())).runtime_action,'installed'); assert.equal(hash(executable),hash(exe));
      assert.equal(hash(launcher),launcherHash); assert.equal(existsSync(join(root,`.cache/previous-${name}`)),false);
      write(executable,'damaged before committed cleanup failure');
      const committed=json(ok(invoke({failCleanup:true})));
      assert.equal(committed.cleanup_pending,true); assert.equal(hash(executable),hash(exe),'Post-publication cleanup must not restore the damaged executable');
      // An upgrade must recognize the previous launcher as committed cleanup evidence.
      const currentText=readFileSync(launcher,'utf8');
      const legacyText=currentText.replace('setlocal DisableDelayedExpansion\r\n', () =>
        'setlocal DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%C in (\'"%SystemRoot%\\System32\\chcp.com"\') do set "GIDD_JS_CODEPAGE=%%C"\r\n"%SystemRoot%\\System32\\chcp.com" 65001 >nul\r\n')
        .replace('"%GIDD_JS_EXEC%" %*', () => '"%SystemRoot%\\System32\\chcp.com" %GIDD_JS_CODEPAGE% >nul\r\n"%GIDD_JS_EXEC%" %*');
      write(launcher,legacyText);
      const legacyTree=snapshot(root);
      assert.match(invoke({failCleanup:true,responses:{},downloads:{}}).stderr,/fixture_cleanup_failed/);
      assert.deepEqual(snapshot(root),legacyTree,'An old published launcher must not restore a damaged backup during upgrade');
      write(launcher,currentText);
      const committedTree=snapshot(root);
      assert.equal(json(ok(invoke({yes:false,responses:{},downloads:{}}))).status,'ready');
      assert.deepEqual(snapshot(root),committedTree,'Read-only checks must leave committed cleanup pending');
      assert.match(invoke({failCleanup:true,responses:{},downloads:{}}).stderr,/fixture_cleanup_failed/);
      assert.deepEqual(snapshot(root),committedTree,'A second cleanup failure must preserve the published runtime and its backup');
      const retried=json(ok(invoke({responses:{},downloads:{}})));
      assert.equal(retried.runtime_action,'reused'); assert.equal(retried.cleanup_pending,false);
      assert.equal(hash(executable),hash(exe)); assert.equal(hash(launcher),launcherHash);
      assert.equal(existsSync(join(root,`.cache/previous-${name}`)),false);
      const old=snapshot(target);
      assert.match(invoke({reinstall:true,failPublish:true}).stderr,/fixture_publish_failed/);
      assert.deepEqual(snapshot(target),old); assert.equal(hash(launcher),launcherHash);
      assert.match(invoke({reinstall:true,responses:{...responses,[checksum]:`${'0'.repeat(64)}  ${archiveName}\n`}}).stderr,/download_hash_mismatch/);
      assert.deepEqual(snapshot(target),old); assert.equal(hash(launcher),launcherHash);
      ok(invoke({reinstall:true}));
      const definition=json(ok(adapter(f.root,{action:'release',name,version,source:name==='bun'?'https://github.com/oven-sh/bun/releases':'https://nodejs.org/dist',pinnedPath:'',responses})));
      const definitionPath=join(f.root,`${name}-definition.json`); write(definitionPath,JSON.stringify(definition));
      if(name==='bun') write(join(f.root,`bun-${version}-LICENSE.md`),readFileSync(license,'utf8'));
      const interrupted=adapter(f.root,{action:'install',root,definitionPath,fixtureDirectory:f.root,stopAt:'backed_up',replace:true},{env});
      assert.notEqual(interrupted.status,0); assert.equal(existsSync(target),false);
      assert.equal(existsSync(join(root,`.cache/previous-${name}`)),true);
      const interruptedTree=snapshot(root);
      assert.equal(json(ok(invoke({yes:false}))).status,'needs_bootstrap');
      assert.deepEqual(snapshot(root),interruptedTree,'Read-only bootstrap must not recover or discard a backup');
      assert.match(json(product(['setup',name,'--repository',f.root],{env})).reason,/pending_runtime_recovery/);
      ok(invoke({responses:{},downloads:{}}));
      assert.deepEqual(snapshot(target),old); assert.equal(hash(launcher),launcherHash);
      assert.equal(existsSync(join(root,`.cache/previous-${name}`)),false);
      assert.equal(existsSync(join(root,`.cache/${name}`)),false);
      write(join(target,'user.txt'),'keep');
      assert.match(invoke({reinstall:true}).stderr,/occupied_or_unknown_target/); assert.equal(readFileSync(join(target,'user.txt'),'utf8'),'keep');
    }
  } finally {f.dispose();}
});

test('generated launcher pins an external Unicode/percent path and does not search again', () => {
  const f=fixture();
  try {
    const s=installation(f,false), name=process.versions.bun?'bun':'node';
    const home=join(f.root,'用户 %GIDD_PATH_SENTINEL% ! profile'), bin=join(f.root,'运行时 %GIDD_PATH_SENTINEL% ! bin');
    mkdirSync(home); stub(process.execPath,join(bin,`${name}.exe`));
    const env={USERPROFILE:home,PATH:bin,GIDD_PATH_SENTINEL:'unexpected-expansion'};
    const report=json(ok(s.invoke(['bootstrap','--yes',...s.args],env)));
    assert.equal(report.runtime.details.source,'path');
    const launcher=join(toolsRoot(home),'js_exec.cmd'), previous=hash(launcher);
    assert.doesNotMatch(readFileSync(launcher,'utf8'), /chcp|[^\x00-\x7f]/i);
    const root=toolsRoot(home), binding=join(root,readdirSync(root).find(n=>n.startsWith('.runtime-path-')));
    assert.equal(lstatSync(binding).isSymbolicLink(),true); sameDirectory(binding,bin);
    assert.equal(json(ok(s.invoke(['bootstrap',...s.args],env))).launcher_matches,true);
    rmSync(binding); // Remove the junction itself, never its external contents.
    assert.equal(existsSync(join(bin,`${name}.exe`)),true);
    assert.equal(json(s.invoke(['bootstrap',...s.args],env)).launcher_matches,false);
    assert.equal(existsSync(binding),false,'Read-only checks must not repair a missing link');
    write(binding,'unknown file');
    assert.equal(json(s.invoke(['bootstrap','--yes',...s.args],env)).reason,'occupied_runtime_binding');
    assert.equal(readFileSync(binding,'utf8'),'unknown file'); assert.equal(hash(launcher),previous);
    rmSync(binding);
    const wrong=join(f.root,'wrong target'); mkdirSync(wrong); symlinkSync(wrong,binding,'junction');
    assert.equal(json(s.invoke(['bootstrap','--yes',...s.args],env)).reason,'occupied_runtime_binding');
    sameDirectory(binding,wrong); assert.equal(hash(launcher),previous); rmSync(binding);
    assert.equal(json(ok(s.invoke(['bootstrap','--yes',...s.args],env))).launcher_action,'reused');
    sameDirectory(binding,bin);
    write(join(bin,'SKILL.md'),'external content, not GIDD storage');
    assert.equal(json(s.invoke(['doctor',...s.args],{...env,PATH:''})).schema,'gidd.doctor/v1');
    const nextBin=join(f.root,'另一个 runtime'); mkdirSync(nextBin); stub(process.execPath,join(nextBin,`${name}.exe`));
    const failed=adapter(f.root,{action:'bootstrap',repositoryRoot:s.target,responses:{},downloads:{},yes:true,failPublish:true},
      {env:{...env,PATH:nextBin}});
    assert.notEqual(failed.status,0); assert.equal(hash(launcher),previous);
    assert.match(ok(s.invoke(['help','en'],{...env,PATH:''})).stdout,/target repository/);

    const log=join(f.root,'unexpected-probe.log'), fake=compile(f.root);
    stub(fake,join(toolsRoot(home),'bun/bun.exe'),undefined,true);
    assert.match(ok(s.invoke(['help','en'],{...env,PATH:'',GIDD_TEST_PROBE_LOG:log})).stdout,/target repository/);
    assert.equal(hash(launcher),previous); assert.equal(existsSync(log),false);
    rmSync(join(bin,`${name}.exe`));
    assert.notEqual(s.invoke(['help','en'],{...env,GIDD_TEST_PROBE_LOG:log}).status,0);
    assert.equal(existsSync(log),false,'A missing bound runtime must not fall back to managed Bun');
    rmSync(join(root,'bun'),{recursive:true});
    stub(process.execPath,join(root,name,`${name}.exe`),undefined,true);
    assert.equal(json(ok(s.invoke(['bootstrap','--yes',...s.args],{...env,PATH:''}))).runtime.details.source,'managed');
    assert.doesNotMatch(readFileSync(launcher,'utf8'),/chcp|[^\x00-\x7f]/i);
    assert.match(ok(s.invoke(['--help','en'],{...env,PATH:''})).stdout,/target repository/);

  } finally {f.dispose();}
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
    assert.equal(existsSync(join(toolsRoot(f.root),'bun')), false);
    stub(exe, join(bin, 'node.exe'));
    const node = json(ok(product(['setup','node',...s.args], { env: { PATH: bin } })));
    assert.deepEqual(node.tools.map(t => [t.name, t.action]), [['node','reused']]);
    assert.equal(existsSync(join(toolsRoot(f.root),'bun')), false);
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
    ok(adapter(f.root,{action:'bootstrap',repositoryRoot:f.root,responses:{},downloads:{},yes:true},{env:{PATH:dirname(process.execPath)}}));
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
    // Runtime version pins are retired; unrelated configuration remains editable.
    for (const key of ['tools.node.version','tools.bun.version']) {
      assert.equal(s.invoke(['config','set',key,'999.0.0',...s.args],env).status,2);
    }
    assert.equal(s.invoke(['config','set','tools.directory','custom',...s.args],env).status,2);
    const direct = ps(join(s.skill,'scripts/windows/config.ps1'),
      ['-RepositoryPath',s.target,'-Action','set','-Key','tools.node.source','-Value','https://mirror.example/node'],{env});
    assert.equal(json(ok(direct)).value,'https://mirror.example/node');
    ok(s.invoke(['config','show',...s.args],env));
  } finally { f.dispose(); }
});
