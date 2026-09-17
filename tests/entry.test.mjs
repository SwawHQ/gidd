import { test } from 'node:test';
import { publishRepositoryEntry, runRepositoryCommand } from './support/repository.mjs';
import { statSync, readFileSync, readdirSync, lstatSync, symlinkSync } from 'node:fs';
import { bindFixture, adapter, code, hash, makeZip, rmSync, toolsRoot, assert, compile, copySkill, dirname, existsSync, fixture, findGit, join, json, mkdirSync, ok, run, snapshot, stub, write } from './support/helpers.mjs';

// Encode for the native Windows argv boundary, including terminal backslashes.
const runtimeLink = (process.versions.bun ? 'bun' : 'node') + '.link.cmd';
const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

function installation(f, prepare = true) {
  const skill = join(f.root, 'installed skill & spaces'), target = join(f.root, '目标 repo & spaces');
  copySkill(skill);
  assert.equal(existsSync(join(skill, 'config.toml')), false, 'Installation must not inherit development configuration');
  mkdirSync(target);
  const git = findGit();
  ok(run(git, ['-C',target,'init','--quiet']));
  ok(run(git, ['-C',target,'remote','add','origin','https://github.com/Team/Repo.git']));
  write(join(target, '.agents/skills/gidd/config.toml'), 'schema_version = 1\n');
  const entryBin=join(f.root,'entry-tools'), entryExe=compile(f.root);
  stub(entryExe,join(entryBin,'gh.exe'));
  const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
  const invoke = (args, env = {}, options = {}, entry) => {
    const executable = entry ? join(skill, entry) : join(target,'.agents/skills/gidd/gidd.link.cmd');
    const forwarded = args;
    return run(cmd, ['/d','/s','/c', `""${executable}" ${forwarded.map(quote).join(' ')}"`], {
      cwd: skill, windowsVerbatimArguments: true, ...options,
      env: { PATH: [dirname(process.execPath),dirname(git),entryBin].join(';'), GIDD_LANG: '', LC_ALL: 'en_US.UTF-8', ...env },
    });
  };
  const ensure = (args = [], env = {}) => invoke(['--repo',target,...args],env,{},'gidd.pre.ensure.cmd');
  if (prepare) ok(ensure());
  return { skill, target, invoke, ensure };
}

function sameDirectory(actual, expected) {
  const a = statSync(actual, { bigint: true }), b = statSync(expected, { bigint: true });
  assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino);
}

test('tools-only prepares exactly one native tool without repository configuration or a JS dependency', () => {
  const f=fixture();
  try {
    const s=installation(f,false), bin=join(f.root,'only-tools'), exe=join(f.root,'tool.exe');
    write(join(s.skill,'config.toml'),'invalid repository configuration');
    const invoke=(args)=>s.invoke(args,{PATH:bin},{},'gidd.pre.ensure.cmd');
    const root=toolsRoot(f.root), initial=snapshot(f.root);
    for(const name of ['git','gh','bun','node']) {
      const report=json(invoke(['--tools-only='+name,'--check']));
      assert.equal(report.status,'needs_tools');assert.equal(report.tool,name);
    }
    assert.deepEqual(snapshot(f.root),initial);
    for(const args of [['--tools-only'],['--tools-only=bad'],['--tools-only=git','--tools-only=gh'],
      ['--tools-only=git','--repo',s.target],['--tools-only=git','--jsruntime=bun'],['--tools-only=git','--check','--force']]) {
      assert.equal(invoke(args).status,2);
    }
    const published=new Map();
    for(const name of ['git','gh','bun','node']) {
      stub(exe,join(bin,name+'.exe'));
      const report=json(ok(invoke(['--tools-only='+name])));
      assert.equal(report.tool,name);assert.equal(report.status,'ready');
      assert.equal(json(ok(invoke(['--tools-only='+name.toUpperCase(),'--check']))).tool,name);
      assert.equal(existsSync(join(root,name)),false,'External tools are reused');
      for(const [other,digest] of published) assert.equal(hash(join(root,other+'.link.cmd')),digest);
      published.set(name,hash(join(root,name+'.link.cmd')));
      const before=snapshot(f.root);
      assert.equal(json(ok(invoke(['--tools-only='+name,'--check']))).status,'ready');
      assert.deepEqual(snapshot(f.root),before);
      const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
      assert.match(ok(run(cmd,['/d','/s','/c',`""${join(root,name+'.link.cmd')}" --version"`],{windowsVerbatimArguments:true,env:{PATH:''}})).stdout,/\d+\.\d+\.\d+/);
    }
    assert.equal(existsSync(join(root,'js_exec.cmd')),false);
    assert.equal(existsSync(join(s.target,'.agents/skills/gidd/gidd.link.cmd')),false);
  } finally {f.dispose();}
});

test('preparing another runtime preserves the repository runtime selection',()=>{
  const f=fixture();
  try {
    const s=installation(f), root=toolsRoot(f.root), name=process.versions.bun?'node':'bun';
    const link=join(s.target,'.agents/skills/gidd/gidd.link.cmd'), before=hash(link), launcher=hash(join(root,runtimeLink));
    const bin=join(f.root,'other-runtime');stub(join(f.root,'tool.exe'),join(bin,name+'.exe'));
    ok(s.invoke(['--tools-only='+name],{PATH:bin},{},'gidd.pre.ensure.cmd'));
    assert.equal(hash(link),before);assert.equal(hash(join(root,runtimeLink)),launcher);
    assert.equal(json(ok(s.ensure())).runtime.id,'tool.'+(process.versions.bun?'bun':'node'));
    assert.equal(hash(link),before);
    assert.equal(json(ok(s.ensure(['--check']))).status,'ready');
  } finally {f.dispose();}
});

test('native runtime version checks apply the policy without executing JavaScript', () => {
  const f=fixture();
  try {
    const exe=compile(f.root);
    for (const [name,version,status] of [['bun','1.4.2','compatible'],['bun','1.4.1','incompatible'],
      ['bun','2.0.0','compatible'],['node','v24.19.0','compatible'],['node','v24.18.9','incompatible'],
      ['node','v25.0.0','compatible'],['node','unknown','incompatible']]) {
      const path=join(f.root,'probes',name+'.exe');stub(exe,path,version);
      assert.equal(json(ok(adapter(f.root,{action:'runtime',executable:path,name}))).status,status);
    }
    assert.equal(json(ok(adapter(f.root,{action:'runtime',executable:process.execPath,name:process.versions.bun?'bun':'node'}))).status,'compatible');
  } finally { f.dispose(); }
});

test('preparation owns tool checks and gidd no longer routes tool commands', () => {
  const f=fixture();
  try {
    const s=installation(f,false),before=snapshot(f.root);
    assert.equal(existsSync(join(s.skill,'gidd.tools.ensure.cmd')),false);
    for (const name of ['entry','doctor','config','authorize']) assert.equal(existsSync(join(s.skill,`scripts.powershell/${name}.ps1`)),false);
    const missing=json(s.ensure(['--check'],{PATH:''}));
    assert.equal(missing.status,'needs_tools'); assert.equal(missing.runtime,null);
    assert.equal(missing.read_only,true); assert.deepEqual(snapshot(f.root),before);
    const checked=json(s.ensure(['--check']));
    assert.equal(checked.status,'needs_tools'); assert.deepEqual(snapshot(f.root),before);
    for(const args of [['--yes'],['--check','--check'],['--check','--ensure'],['--check','--force'],['--check','--jsruntime=node'],['--jsruntime=bad'],['--jsruntime=bun','--jsruntime=node'],['--node'],['--reinstall'],['--unknown'],['--repository']])
      assert.equal(s.ensure(args).status,2);
    const prepared=json(ok(s.ensure()));
    assert.equal(prepared.launcher_action,'published'); assert.equal(prepared.tools.length,2);
    assert.equal(json(ok(s.ensure(['--jsruntime='+(process.versions.bun?'bun':'node')]))).runtime.id,process.versions.bun?'tool.bun':'tool.node');
    const installed=snapshot(toolsRoot(f.root));
    const ready=json(ok(s.ensure(['--check'])));assert.equal(ready.status,'ready');
    for (const args of [['tools'],['tools','--check'],['tools','--ensure'],['bootstrap'],['setup']]) {
      assert.equal(json(s.invoke(args)).reason,'unknown_command');
    }
    assert.doesNotMatch(ok(s.invoke(['help','en'])).stdout,/External tools|gidd\.pre\.ensure|gidd tools/);
    assert.doesNotMatch(ok(s.invoke(['help','zh'])).stdout,/外部工具|gidd\.pre\.ensure|gidd tools/);
    assert.deepEqual(snapshot(toolsRoot(f.root)),installed);
    assert.equal(json(ok(s.ensure())).launcher_action,'reused');
    assert.deepEqual(snapshot(toolsRoot(f.root)),installed);
  } finally {f.dispose();}
});

test('shared launcher forwards raw argv, stdin, cwd, stderr and exit without PowerShell or compatibility', () => {
  const f=fixture();
  try {
    const s=installation(f);
    write(join(s.skill,'echo.mjs'), `import {readFileSync} from 'node:fs'; console.log(JSON.stringify({args:process.argv.slice(2),input:readFileSync(0,'utf8'),cwd:process.cwd(),exe:process.execPath})); console.error('launcher fixture stderr'); process.exit(23);`);
    rmSync(join(s.skill,'scripts.powershell'),{recursive:true});
    const before=snapshot(toolsRoot(f.root));
    const args=['two words','','--help','tail\\','a & b','a^b','!literal!','two "quotes"'];
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const result=run(cmd,['/d','/s','/c',`""${join(toolsRoot(f.root),runtimeLink)}" ${[join(s.skill,'echo.mjs'),...args].map(quote).join(' ')}"`],{windowsVerbatimArguments:true,env:{PATH:''},input:'launcher stdin',cwd:s.target});
    assert.equal(result.status,23,result.stderr);
    const report=json(result); assert.deepEqual(report.args,args);
    assert.equal(report.input,'launcher stdin'); sameDirectory(report.cwd,s.target); assert.equal(report.exe,process.execPath);
    assert.match(result.stderr,/launcher fixture stderr/);
    assert.deepEqual(snapshot(toolsRoot(f.root)),before);
    // A runtime wrapper can run any JS file, independently of GIDD commands.
    const other=join(f.root,'other repo/echo.mjs'); write(other,"console.log('other fixture');");
    assert.equal(ok(run(cmd,['/d','/s','/c',`""${join(toolsRoot(f.root),runtimeLink)}" "${other}""`],{windowsVerbatimArguments:true,env:{PATH:''}})).stdout.trim(),'other fixture');
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

test('runtime selection retains a valid binding and switches only when requested',()=>{
  const f=fixture();
  try {
    const exe=compile(f.root),root=toolsRoot(f.root),bin=join(f.root,'external');
    for(const name of ['bun','node'])stub(exe,join(root,name,name+'.exe'),undefined,true);
    const invoke=(extra={},path='')=>adapter(f.root,{action:'bootstrap',repositoryRoot:f.root,yes:true,responses:{},downloads:{},...extra},{env:{PATH:path}});
    assert.equal(json(ok(invoke({runtime:'node'}))).runtime.id,'tool.node');
    const unselected=snapshot(join(root,'bun'));
    assert.equal(json(ok(invoke())).runtime.id,'tool.node');
    assert.equal(json(ok(invoke({yes:false}))).runtime.id,'tool.node');
    assert.deepEqual(snapshot(join(root,'bun')),unselected);
    assert.equal(json(ok(invoke({runtime:'bun'}))).runtime.id,'tool.bun');
    rmSync(root,{recursive:true});stub(exe,join(bin,'node.exe'));
    assert.equal(json(ok(invoke({runtime:'node'},bin))).runtime.details.source,'path');
    assert.equal(json(ok(invoke())).runtime.details.source,'path','Bound external runtime survives PATH removal');
    stub(exe,join(root,'bun/bun.exe'),undefined,true);
    assert.equal(json(ok(invoke())).runtime.id,'tool.node','A new managed Bun does not displace a bound external Node');
    const unicodeBin=join(f.root,'runtime \u4e2d\u6587');stub(exe,join(unicodeBin,'node.exe'));
    rmSync(join(root,'node.link.cmd'));ok(invoke({runtime:'node'},unicodeBin));
    const link=join(root,readdirSync(root).find(n=>n.startsWith('.runtime-path-')));rmSync(link);
    assert.match(invoke({reinstall:true,runtime:'node'}).stderr,/https:\/\/nodejs.org\/dist\/index.json/,'Force identifies Node even when its path junction is missing');
    write(join(root,'node.link.cmd'),'unknown launcher');
    assert.equal(json(ok(invoke())).runtime.id,'tool.bun','Unknown launcher data is not executed');
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
      write(config,'schema_version = 1\n');
      const spec={action:'bootstrap',repositoryRoot:f.root,responses,downloads,yes:true,node:name==='node'}, env={PATH:'',USERPROFILE:home};
      const invoke=(extra={})=>adapter(f.root,{...spec,...extra},{env});
      const before=hash(config), result=json(ok(invoke())), root=toolsRoot(home), target=join(root,name), launcher=join(root,name+'.link.cmd');
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
      assert.equal(json(ok(invoke({reinstall:true,node:false}))).runtime.id,`tool.${name}`,'Force retains the bound runtime kind without a selector');
      const beforeInterruption=snapshot(target);
      const definition=json(ok(adapter(f.root,{action:'release',name,version,source:name==='bun'?'https://github.com/oven-sh/bun/releases':'https://nodejs.org/dist',pinnedPath:'',responses})));
      const definitionPath=join(f.root,`${name}-definition.json`); write(definitionPath,JSON.stringify(definition));
      if(name==='bun') write(join(f.root,`bun-${version}-LICENSE.md`),readFileSync(license,'utf8'));
      const interrupted=adapter(f.root,{action:'install',root,definitionPath,fixtureDirectory:f.root,stopAt:'backed_up',replace:true},{env});
      assert.notEqual(interrupted.status,0); assert.equal(existsSync(target),false);
      assert.equal(existsSync(join(root,`.cache/previous-${name}`)),true);
      const interruptedTree=snapshot(root);
      assert.equal(json(ok(invoke({yes:false}))).status,'needs_bootstrap');
      assert.deepEqual(snapshot(root),interruptedTree,'Read-only bootstrap must not recover or discard a backup');
      ok(invoke({responses:{},downloads:{}}));
      assert.deepEqual(snapshot(target),beforeInterruption); assert.equal(hash(launcher),launcherHash);
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
    for(const tool of ['gh'])stub(join(f.root,'tool.exe'),join(bin,tool+'.exe'));
    const env={USERPROFILE:home,PATH:[bin,dirname(findGit())].join(';'),GIDD_PATH_SENTINEL:'unexpected-expansion'};
    const report=json(ok(s.ensure([],env)));
    assert.equal(report.runtime.details.source,'path');
    const launcher=join(toolsRoot(home),runtimeLink), previous=hash(launcher);
    assert.doesNotMatch(readFileSync(launcher,'utf8'), /chcp|[^\x00-\x7f]/i);
    const root=toolsRoot(home), binding=join(root,readdirSync(root).find(n=>n.startsWith('.runtime-path-')));
    assert.equal(lstatSync(binding).isSymbolicLink(),true); sameDirectory(binding,bin);
    assert.equal(json(ok(s.ensure(['--check'],env))).launcher_matches,true);
    rmSync(binding); // Remove the junction itself, never its external contents.
    assert.equal(existsSync(join(bin,`${name}.exe`)),true);
    assert.equal(json(s.ensure(['--check'],env)).launcher_matches,false);
    assert.equal(existsSync(binding),false,'Read-only checks must not repair a missing link');
    write(binding,'unknown file');
    assert.equal(json(s.ensure([],env)).reason,'occupied_runtime_binding');
    assert.equal(readFileSync(binding,'utf8'),'unknown file'); assert.equal(hash(launcher),previous);
    rmSync(binding);
    const wrong=join(f.root,'wrong target'); mkdirSync(wrong); symlinkSync(wrong,binding,'junction');
    assert.equal(json(s.ensure([],env)).reason,'occupied_runtime_binding');
    sameDirectory(binding,wrong); assert.equal(hash(launcher),previous); rmSync(binding);
    assert.equal(json(ok(s.ensure([],env))).launcher_action,'reused');
    sameDirectory(binding,bin);
    write(join(bin,'SKILL.md'),'external content, not GIDD storage');
    assert.equal(json(s.invoke(['doctor'],{...env,PATH:''})).schema,'gidd.doctor/v1');
    const nextBin=join(f.root,'另一个 runtime'); mkdirSync(nextBin); stub(process.execPath,join(nextBin,`${name}.exe`));
    const failed=adapter(f.root,{action:'bootstrap',repositoryRoot:s.target,responses:{},downloads:{},yes:true,failPublish:true},
      {env:{...env,PATH:nextBin}});
    assert.notEqual(failed.status,0); assert.equal(hash(launcher),previous);
    assert.match(ok(s.invoke(['help','en'],{...env,PATH:''})).stdout,/Check tools, repository and GitHub identity/);

    const log=join(f.root,'unexpected-probe.log'), fake=compile(f.root);
    stub(fake,join(toolsRoot(home),'bun/bun.exe'),undefined,true);
    assert.match(ok(s.invoke(['help','en'],{...env,PATH:'',GIDD_TEST_PROBE_LOG:log})).stdout,/Check tools, repository and GitHub identity/);
    assert.equal(hash(launcher),previous); assert.equal(existsSync(log),false);
    rmSync(join(bin,`${name}.exe`));
    assert.notEqual(s.invoke(['help','en'],{...env,GIDD_TEST_PROBE_LOG:log}).status,0);
    assert.equal(existsSync(log),false,'A missing bound runtime must not fall back to managed Bun');
    rmSync(join(root,'bun'),{recursive:true});
    stub(process.execPath,join(root,name,`${name}.exe`),undefined,true);
    assert.equal(json(ok(s.ensure([],{...env,PATH:''}))).runtime.details.source,'managed');
    assert.doesNotMatch(readFileSync(launcher,'utf8'),/chcp|[^\x00-\x7f]/i);
    assert.match(ok(s.invoke(['--help','en'],{...env,PATH:''})).stdout,/Check tools, repository and GitHub identity/);

  } finally {f.dispose();}
});

test('installed shell entry provides help and doctor reuse a PATH runtime without writes', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), before = snapshot(f.root);
    assert.match(ok(s.invoke(['help','zh'])).stdout, /显示中文帮助/);
    for (const alias of ['--help','-h']) {
      assert.equal(ok(s.invoke([alias,'zh'])).stdout, ok(s.invoke(['help','zh'])).stdout);
    }
    assert.match(ok(s.invoke([])).stdout, /Check tools, repository and GitHub identity/);
    assert.match(ok(s.invoke([], { GIDD_LANG: 'zh' })).stdout, /显示中文帮助/);
    assert.match(ok(s.invoke(['help','en'], { GIDD_LANG: 'zh' })).stdout, /Check tools, repository and GitHub identity/);
    for (const language of ['en', 'zh']) {
      const help = ok(s.invoke(['help', language])).stdout;
      assert.equal(help.trim(), readFileSync(join(s.skill, `references/gidd.link.help.${language === 'zh' ? 'zh-CN' : 'en'}.md`), 'utf8').trim());
      assert.match(help, /gidd\.link \.gh\.auth/);
      assert.doesNotMatch(help, /gidd\.link auth\b/);
    }
    for (const args of [['auth'], ['auth', '--account', 'Octocat']]) {
      const removed = s.invoke(args);
      assert.equal(removed.status, 2);
      assert.equal(json(removed).reason, 'unknown_command');
    }
    for (const args of [['unknown'], ['identity'], ['doctor','--offline','--offline'], ['doctor','--offline=true'], ['.gh.auth','--offline'], ['help','fr'], ['help','en','extra'], ['doctor','--repository','.'],
      ['doctor','--repository',s.target], ['doctor','--account','x'], ['setup','python'],
      ['setup','bun','--offline','x'], ['.gh.auth','Octocat']]) {
      const result = s.invoke(args);
      assert.equal(result.status, 2, args.join(' '));
      assert.ok(['gidd.cli/v1','gidd.repository-entry/v1'].includes(json(result).schema));
    }
    const result = s.invoke(['doctor']);
    assert.equal(result.status, 1);
    const report = json(result);
    assert.equal(report.schema, 'gidd.doctor/v1');
    sameDirectory(report.folder, s.target);
    assert.equal(report.checks.find(c => c.id === 'tool.js_runtime').status, 'ready');
    for (const command of [['.gh.auth']]) {
      const missing = s.invoke([...command]);
      assert.equal(missing.status, 2);
      assert.equal(json(missing).reason, 'config_missing_repo_remote_url');
    }
    assert.deepEqual(snapshot(f.root), before, 'Help, invalid commands and missing dependencies must not write or install');
  } finally { f.dispose(); }
});

test('removed runtime setup commands fail without changing configuration or tools', () => {
  const f = fixture();
  try {
    const s = installation(f);
    write(join(s.target,'.agents/skills/gidd/config.toml'),'invalid configuration');
    const before = snapshot(f.root);
    for (const name of ['bun','node','git','gh']) {
      const result = s.invoke(['setup',name],{PATH:''});
      assert.equal(result.status,2);
      assert.equal(json(result).reason,'unknown_command');
      assert.equal(existsSync(join(s.skill,'scripts.powershell/setup-tools.ps1')),false);
    }
    assert.deepEqual(snapshot(f.root),before,'Rejected commands must not read invalid config, install, or switch the launcher');
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
    ok(adapter(f.root,{action:'bootstrap',repositoryRoot:f.root,responses:{},downloads:{},yes:true},{env:{PATH:dirname(process.execPath)}}));
    for (const root of [target,worktree]) {
      const skill = join(root,'.agents/skills/gidd');
      copySkill(skill);
      write(join(skill,'config.toml'),'schema_version = 1\n');
      publishRepositoryEntry(root,join(skill,'scripts.js/gidd.mjs'));
      const before = snapshot(root);
      const result = runRepositoryCommand(root,['doctor','--offline'],{cwd:f.root,env:{PATH:''}});
      assert.equal(result.status,1);
      sameDirectory(json(result).folder,root);
      const override = runRepositoryCommand(root,['doctor','--repository',f.root],{cwd:f.root,env:{PATH:''}});
      assert.equal(override.status,2);
      assert.equal(json(override).reason,'repository_override_forbidden');
      assert.deepEqual(snapshot(root),before);
    }
  } finally { f.dispose(); }
});

test('shell doctor and .gh.auth preserve JavaScript results, events and exit codes', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), git = findGit();
    const config = join(s.target,'.agents/skills/gidd/config.toml');
    const configured = 'schema_version = 1\n[git]\nuser.mode = "inherit"\ncredential.mode = "inherit"\n[spec]\ncurrent = "issue-direct"\n[repo]\nremote.account = "Octocat"\nremote.name = "fixture"\nremote.url = "https://github.com/owner/repo"\n';
    write(config,configured);
    for (const args of [['init'], ['config','user.name','Fixture Author'], ['config','user.email','author@example.test'],
      ['remote','add','fixture','git@github.com:owner/repo.git']]) ok(run(git, ['-C',s.target,...args]));
    const compiled = compile(f.root,'auth-gh.cs'), gh = join(f.root,'bin/gh.exe');
    stub(compiled, gh, 'existing');
    bindFixture(f.root,{gh,git});
    const env = { PATH: [dirname(process.execPath),dirname(git),dirname(gh)].join(';'), GH_CONFIG_DIR: join(f.root,'credentials'),
      GH_TOKEN:'', GITHUB_TOKEN:'', GH_ENTERPRISE_TOKEN:'', GITHUB_ENTERPRISE_TOKEN:'' };
    const before = snapshot(s.target);
    const diagnosis = s.invoke(['doctor'],env);
    assert.equal(diagnosis.status, 0);
    const report = json(diagnosis);
    assert.equal(report.schema,'gidd.doctor/v1');
    assert.equal(report.checks.find(c => c.id === 'config.repo.remote.account..online').status,'ready');
    assert.equal(report.checks.find(c => c.id === 'folder.git.author').details.email,'author@example.test');
    assert.equal(report.checks.find(c => c.id === 'config.repo.remote.url..online').reason,'online_incomplete');
    assert.equal(report.status,'checks_incomplete');
    assert.equal(report.checks.find(c => c.id === 'config.repo.remote.url..online').severity,'warning');
    assert.equal(report.checks.find(c => c.id === 'folder.git.worktree').severity,'warning');
    assert.ok(report.checks.every(c => c.severity !== 'error'));
    assert.equal(json(ok(s.invoke(['.gh.auth'],env))).reason,'already_authenticated');
    write(config,configured.replace('remote.name = "fixture"\n',''));
    assert.equal(json(ok(s.invoke(['.gh.auth'],env))).reason,'already_authenticated');
    assert.equal(json(s.invoke(['doctor'],env)).checks.find(c=>c.id==='config.repo.remote.name').reason,'config_missing_repo_remote_name');
    for (const [text,reason] of [
      [configured.replace('remote.url = "https://github.com/owner/repo"\n',''),'config_missing_repo_remote_url'],
      [configured.replace('remote.account = "Octocat"\n',''),'config_missing_repo_remote_account'],
      [configured.replace('https://github.com/owner/repo','invalid-url'),'config_invalid_repo_remote_url'],
      [configured.replace('"Octocat"','"bad account"'),'config_invalid_repo_remote_account'],
    ]) {
      write(config,text);
      assert.equal(json(s.invoke(['.gh.auth'],env)).reason,reason);
      assert.equal(existsSync(gh + '.started'),false,'Invalid configuration must never start login');
    }
    write(config,configured.replace('https://github.com/owner/repo','https://github.com/other/repo'));
    assert.equal(json(ok(s.invoke(['.gh.auth'],env))).reason,'already_authenticated');
    assert.equal(json(s.invoke(['doctor','--offline'],env)).checks.find(c=>c.id==='config.repo.remote.url').reason,'repository_address_mismatch');
    write(config,configured.replace('remote.name = "fixture"','remote.name = "absent"'));
    assert.equal(json(ok(s.invoke(['.gh.auth'],env))).reason,'already_authenticated');
    assert.equal(json(s.invoke(['doctor','--offline'],env)).checks.find(c=>c.id==='config.repo.remote.name').reason,'configured_remote_missing');
    write(config,configured.replace('"Octocat"','"OtherAccount"'));
    const mismatch = s.invoke(['.gh.auth'],env);
    assert.equal(mismatch.status,1);
    assert.equal(json(mismatch).reason,'unexpected_account');
    write(config,configured);
    write(gh + '.mode','success');
    const auth = ok(s.invoke(['.gh.auth'],env));
    assert.equal(json(auth).schema, 'gidd.auth/v1');
    assert.equal(json(auth).reason,'authenticated');
    assert.equal(JSON.parse(auth.stderr.trim()).schema, 'gidd.auth.event/v1');
    assert.equal(JSON.parse(auth.stderr.trim()).type,'authorization_required');
    assert.deepEqual(snapshot(s.target),before, 'Only the fake gh may write login state');
  } finally { f.dispose(); }
});

test('shell .gh.auth needs only URL, account and gh even without a usable Git repository', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), config = join(s.target,'.agents/skills/gidd/config.toml');
    const gh = compile(f.root,'auth-gh.cs');
    write(gh + '.mode','existing');
    bindFixture(f.root,{gh});
    const env = { PATH: dirname(process.execPath), GH_CONFIG_DIR: join(f.root,'credentials') };
    const minimal = 'schema_version = 1\n[repo]\nremote.url = "https://GHE.example.test/Another/Project.git"\nremote.account = "Octocat"\n';
    // The fixture rejects token/API calls sent to any other host or account.
    write(gh + '.hostname','ghe.example.test');
    write(gh + '.account','Octocat');
    rmSync(join(s.target,'.git'),{recursive:true});
    for (const extra of ['', 'remote.name = "bad remote name"\n[git]\nuser.mode = "invalid"\ncredential.mode = "invalid"\n']) {
      write(config,minimal + extra);
      const before = snapshot(s.target);
      const report = json(ok(s.invoke(['.gh.auth'],env)));
      assert.equal(report.reason,'already_authenticated');
      assert.equal(report.hostname,'ghe.example.test');
      assert.equal(report.expected_account,'Octocat');
      assert.deepEqual(snapshot(s.target),before);
    }
    // Even a recorded but obsolete/unavailable Git must not block gh authorization.
    const binding = join(toolsRoot(f.root),'tool-bindings.json');
    const record = JSON.parse(readFileSync(binding,'utf8'));
    record.tools.git = { path: join(f.root,'missing/git.exe'), source: 'path', version: '2.0.0' };
    write(binding,JSON.stringify(record));
    write(join(s.target,'.git'),'not a worktree');
    assert.equal(json(ok(s.invoke(['.gh.auth'],env))).reason,'already_authenticated');
    // Device authorization also works before Git is ready.
    write(config,minimal.replace('GHE.example.test','github.com'));
    write(gh + '.hostname','github.com');
    write(gh + '.mode','success');
    const auth = ok(s.invoke(['.gh.auth'],env));
    assert.equal(json(auth).reason,'authenticated');
    assert.equal(JSON.parse(auth.stderr.trim()).type,'authorization_required');
    record.tools.gh.version = '2.97.0';
    write(binding,JSON.stringify(record));
    assert.equal(json(s.invoke(['.gh.auth'],env)).reason,'tool_binding_incompatible:gh');
  } finally { f.dispose(); }
});

test('top-level configuration commands create and edit defaults; .gh.auth rejects missing config and overrides', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), env = { PATH: dirname(process.execPath) };
    const config = join(s.target,'.agents/skills/gidd/config.toml');
    const original = readFileSync(config,'utf8');
    const missing = s.invoke(['.gh.auth'],env);
    assert.equal(json(missing).reason,'config_missing_repo_remote_url');
    for (const args of [['.gh.auth','--account','Octocat'],['.gh.auth','--hostname','github.com'],['.gh.auth','--remote','origin'],['.gh.auth','Octocat']]) {
      assert.equal(json(s.invoke([...args],env)).reason,'github_parameters_moved_to_config');
    }
    for (const [key,value] of [['account','Octocat'],['name','upstream'],['url','https://github.com/owner/repo']]) {
      const result = json(ok(s.invoke(['set',`repo.remote.${key}`,value],env)));
      assert.equal(result.schema, 'gidd.config/v1');
      assert.equal(result.action, 'set');
      assert.equal(result.key,`repo.remote.${key}`);
    }
    assert.ok(readFileSync(config,'utf8').startsWith(original));
    ok(s.invoke(['set','git.user.mode','inherit'],env));
    ok(s.invoke(['set','git.credential.mode','inherit'],env));
    const shown = json(ok(s.invoke(['set.show'],env)));
    assert.equal(shown.schema, 'gidd.config/v1');
    assert.equal(shown.content,readFileSync(config,'utf8'));
    const before = snapshot(s.target);
    for (const [key,value] of [['repo.remote.account','bad name'],['github.token','secret'],['schema_version','2']]) {
      assert.equal(s.invoke(['set',key,value],env).status,2);
    }
    assert.deepEqual(snapshot(s.target),before);
    rmSync(config);
    const created = s.invoke(['set','repo.remote.account','Octocat'],env);
    ok(created);
    const text = readFileSync(config,'utf8');
    assert.doesNotMatch(text,/hostname/); assert.match(text,/remote.name = "origin"/);
    assert.match(text,/remote.account = "Octocat"/);
    // All tool settings are internal; only repository business settings are editable.
    for (const key of ['tools.node.version','tools.bun.version','tools.node.source']) {
      assert.equal(s.invoke(['set',key,'999.0.0'],env).status,2);
    }
    assert.equal(s.invoke(['set','tools.directory','custom'],env).status,2);
    const direct = s.invoke(['set','repo.remote.url','https://github.example.test/owner/repo'],env);
    assert.equal(json(ok(direct)).value,'https://github.example.test/owner/repo');
    ok(s.invoke(['set','git.user.mode','inherit'],env));
    ok(s.invoke(['set','git.credential.mode','inherit'],env));
    ok(s.invoke(['set.show'],env));
  } finally { f.dispose(); }
});

test('bare set shares main bilingual help without configuration; old commands and malformed arguments do not mutate files', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), config = join(s.target, '.agents/skills/gidd/config.toml');
    const fields = ['repo.remote.name', 'repo.remote.url', 'repo.remote.account', 'git.user.mode',
      'git.user.name', 'git.user.email', 'git.credential.mode', 'spec.current'];
    for (const content of ['invalid TOML', null]) {
      if (content === null) rmSync(config); else write(config, content);
      const before = snapshot(f.root);
      const stat = content === null ? undefined : statSync(config, { bigint: true });
      for (const language of ['en', 'zh']) {
        const help = ok(s.invoke(['set'], { GIDD_LANG: language })).stdout;
        assert.equal(help, ok(s.invoke(['help'], { GIDD_LANG: language })).stdout);
        for (const field of fields) assert.ok(help.includes(field));
        for (const syntax of ['managed', 'inherit', 'gh|inherit', 'gidd.link set.show', 'gidd.link set', 'gidd.link clear']) assert.ok(help.includes(syntax));
        assert.doesNotMatch(help, /^\s*gidd\.link set\s*(?:#.*)?$/m);
        assert.doesNotMatch(help, /gidd\.link config/);
      }
      for (const args of [['show'], ['config'], ['config', 'show'], ['config', 'set', 'git.user.mode', 'inherit'],
        ['config', 'clear', 'git.user.name'], ['del', 'git.user.name'], ['delete', 'git.user.name'],
        ['set', 'show'], ['set', 'git.user.name'], ['set', 'git.user.name', 'Name', 'extra'],
        ['set.show', 'extra'], ['clear'], ['clear', 'git.user.name', 'extra']]) {
        const result = s.invoke(args);
        assert.equal(result.status, 2);
        assert.equal(json(result).reason, ['show', 'config', 'del', 'delete'].includes(args[0]) ? 'unknown_command' : 'invalid_arguments');
      }
      assert.deepEqual(snapshot(f.root), before);
      if (stat) {
        const after = statSync(config, { bigint: true });
        assert.equal(after.mtimeNs, stat.mtimeNs); assert.equal(after.ino, stat.ino);
      }
    }
  } finally { f.dispose(); }
});
