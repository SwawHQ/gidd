import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { statSync, readFileSync, readdirSync, lstatSync, symlinkSync } from 'node:fs';
import { bindFixture, bindNodeFixture, adapter, code, hash, installRequest, makeZip, rmSync, toolsRoot, assert, compile, copySkill, dirname, existsSync, fixture, findGit, join, json, mkdirSync, ok, ps, run, snapshot, stub, support, write, executionFailure } from './support/helpers.mjs';

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

  const entryBin=join(f.root,'entry-tools'), entryExe=compile(f.root);
  stub(entryExe,join(entryBin,'gh.exe'));
  const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
  const invoke = (args, env = {}, options = {}, entry) => {
    const executable = entry ? join(skill, entry) : join(skill,'gidd.cmd');
    const forwarded = args;
    return run(cmd, ['/d','/s','/c', `""${executable}" ${forwarded.map(quote).join(' ')}"`], {
      cwd: target, windowsVerbatimArguments: true, ...options,
      env: { PATH: [dirname(process.execPath),dirname(git),entryBin].join(';'), LC_ALL: 'en_US.UTF-8', ...env },
    });
  };
  const ensure = (args = [], env = {}) => invoke(args,env,{},'tools.ensure.cmd');
  if (prepare) ok(ensure());
  return { skill, target, invoke, ensure };
}

function sameDirectory(actual, expected) {
  const a = statSync(actual, { bigint: true }), b = statSync(expected, { bigint: true });
  assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino);
}

test('single-tool preparation needs neither repository configuration nor JavaScript', () => {
  const f=fixture();
  try {
    const s=installation(f,false), bin=join(f.root,'only-tools'), exe=join(f.root,'tool.exe');
    write(join(s.skill,'config.toml'),'invalid repository configuration');
    const bootstrap=join(s.skill,'scripts.powershell/bootstrap.ps1');
    // Exercise different UI and regional cultures regardless of the test host.
    write(bootstrap,'[Globalization.CultureInfo]::CurrentUICulture = [Globalization.CultureInfo]::GetCultureInfo("en-US")\n[Globalization.CultureInfo]::CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo("zh-CN")\n'+readFileSync(bootstrap,'utf8'));
    const invoke=(args)=>s.invoke(args,{PATH:bin},{},'tools.ensure.cmd');
    const root=toolsRoot(f.root), initial=snapshot(f.root);
    const systemHelp=ok(invoke(['help','zh'])).stdout;
    for (const locale of ['en_US.UTF-8','zh_CN.UTF-8','C.UTF-8']) {
      assert.equal(ok(s.ensure(['help'],{PATH:'',LC_ALL:locale,LC_MESSAGES:locale,LANG:locale})).stdout,systemHelp);
    }
    for(const name of ['git','gh','bun','node']) {
      const report=json(invoke([name,'--check']));
      assert.equal(report.status,'needs_tools');assert.equal(report.tools[0].name,name);
    }
    assert.deepEqual(snapshot(f.root),initial);
    for(const args of [['--tools-only'],['--tools-only=bad'],['--tools-only=git','--tools-only=gh'],
      ['--tools-only=git','--repo',s.target],['--tools-only=git','--jsruntime=bun'],['--tools-only=git','--check','--force']]) {
      assert.equal(invoke(args).status,2);
    }
    const published=new Map();
    for(const name of ['git','gh','bun','node']) {
      stub(exe,join(bin,name+'.exe'));
      const report=json(ok(invoke([name])));
      assert.equal(report.tools[0].name,name);assert.equal(report.status,'ready');
      assert.deepEqual(Object.keys(report).sort(),['schema','status','tools']);
      assert.deepEqual(Object.keys(report.tools[0]).sort(),['action','launcher','name','path','status','version']);
      assert.equal(report.tools[0].action,'reused');
      assert.equal(report.tools[0].launcher,join(root,name+'.link.cmd'));
      assert.equal(json(ok(invoke([name.toUpperCase(),'--check']))).tools[0].name,name);
      assert.equal(existsSync(join(root,name)),false,'External tools are reused');
      for(const [other,digest] of published) assert.equal(hash(join(root,other+'.link.cmd')),digest);
      published.set(name,hash(join(root,name+'.link.cmd')));
      const before=snapshot(f.root);
      const checked=json(ok(invoke([name,'--check'])));
      assert.equal(checked.status,'ready');
      assert.deepEqual(Object.keys(checked.tools[0]).sort(),['launcher','name','path','status','version']);
      assert.deepEqual(snapshot(f.root),before);
      const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
      assert.match(ok(run(cmd,['/d','/s','/c',`""${join(root,name+'.link.cmd')}" --version"`],{windowsVerbatimArguments:true,env:{PATH:''}})).stdout,/\d+\.\d+\.\d+/);
    }
    assert.equal(existsSync(join(root,'js_exec.cmd')),false);
    assert.equal(existsSync(join(s.target,'.agents/skills/gidd/gidd.link.cmd')),false);
  } finally {f.dispose();}
});

test('ensure reports rejected versions, missing bindings and partial preparation without internal probes', () => {
  const f=fixture();
  try {
    const s=installation(f,false),bin=join(f.root,'candidates'),root=toolsRoot(f.root);
    for(const name of ['bun','git']) {
      const path=join(bin,name+'.exe');stub(join(f.root,'tool.exe'),path,name==='git'?'git version 1.0.0':'1.0.0');
      const before=snapshot(f.root),result=s.ensure([name,'--check'],{PATH:bin});
      assert.equal(result.status,1);
      const report=json(result),tool=report.tools[0];
      assert.equal(report.status,'needs_tools');assert.equal(tool.status,'invalid');
      assert.equal(tool.details.code,'no_usable_candidate');
      assert.ok(tool.details.minimum);
      assert.equal(tool.details.candidates[0].path,path);
      assert.equal(tool.details.candidates[0].version,'1.0.0');
      assert.ok(tool.details.candidates[0].code);
      assert.deepEqual(snapshot(f.root),before);
    }
    const runtime=process.versions.bun?'bun':'node';
    const unbound=json(s.ensure([runtime,'--check'],{PATH:dirname(process.execPath)}));
    assert.equal(unbound.tools[0].details.code,'bootstrap_required');
    assert.equal(unbound.tools[0].path,process.execPath);
    write(join(root,'gh/user.txt'),'keep');
    const partial=s.ensure([],{PATH:[dirname(process.execPath),dirname(findGit())].join(';')});
    assert.equal(partial.status,1);
    const report=json(partial);
    assert.deepEqual(report.tools.map(t=>[t.name,t.status]),[[runtime,'ready'],['git','ready'],['gh','invalid']]);
    assert.equal(report.tools[2].details.code,'unknown_tool_ownership:gh');
    assert.equal(readFileSync(join(root,'gh/user.txt'),'utf8'),'keep');
    const recovery=json(adapter(f.root,{action:'prepare',root,names:['git'],responses:{},downloads:{},failRecovery:true,publicReport:true}));
    assert.equal(recovery.status,'needs_tools');
    assert.equal(recovery.tools[0].details.code,'fixture_recovery_failed');
    assert.equal(recovery.tools[0].details.recovery.code,'tool_recovery_failed');
    const invalid=json(s.ensure(['--check']));
    assert.equal(invalid.status,'error');assert.equal(invalid.details.code,'invalid_arguments');
    assert.equal(invalid.reason,undefined);
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
    const missing=json(s.ensure(['bun','--check'],{PATH:''}));
    assert.equal(missing.status,'needs_tools'); assert.equal(missing.tools[0].status,'missing');
    assert.equal(missing.tools[0].action,undefined); assert.deepEqual(snapshot(f.root),before);
    const checked=json(s.ensure([process.versions.bun?'bun':'node','--check']));
    assert.equal(checked.status,'needs_tools'); assert.deepEqual(snapshot(f.root),before);
    for(const args of [['--check'],['--force'],['git','--check','--force'],['git','gh'],['--yes'],['--check','--check'],['--check','--ensure'],['--check','--force'],['--check','--jsruntime=node'],['--jsruntime=bad'],['--jsruntime=bun','--jsruntime=node'],['--node'],['--reinstall'],['--unknown'],['--repository']])
      assert.equal(s.ensure(args).status,2);
    const prepared=json(ok(s.ensure()));
    assert.deepEqual(prepared.tools.map(t=>t.name),[process.versions.bun?'bun':'node','git','gh']);
    assert.equal(prepared.repository, undefined);
    assert.equal(prepared.entry, undefined);
    assert.equal(existsSync(join(s.target, '.agents')), false);
    assert.equal(existsSync(s.target + '.gidd'), false);
    assert.equal(existsSync(join(toolsRoot(f.root), 'config.toml')), false);
    assert.equal(json(ok(s.ensure([process.versions.bun?'bun':'node']))).tools[0].name,process.versions.bun?'bun':'node');
    const installed=snapshot(toolsRoot(f.root));
    const ready=json(ok(s.ensure([process.versions.bun?'bun':'node','--check'])));assert.equal(ready.status,'ready');
    for (const args of [['tools'],['bootstrap'],['setup']]) {
      assert.equal(json(s.invoke(args)).details.code,'unknown_command');
    }
    assert.doesNotMatch(ok(s.invoke(['help','en'])).stdout,/External tools|gidd\.pre\.ensure|gidd tools/);
    assert.doesNotMatch(ok(s.invoke(['help','zh'])).stdout,/外部工具|gidd\.pre\.ensure|gidd tools/);
    assert.deepEqual(snapshot(toolsRoot(f.root)),installed);
    assert.equal(json(ok(s.ensure())).tools[0].action,'reused');
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

test('native tool routes keep argv, streams, cwd and exit status outside a repository', () => {
  const f=fixture();
  try {
    const s=installation(f), root=toolsRoot(f.root), caller=join(f.root,'caller & spaces'), node=bindNodeFixture(f.root); mkdirSync(caller);
    const echo=compile(f.root,'wrapper-gh.cs'), script=join(f.root,'echo args.mjs');
    write(script, "import {readFileSync} from 'node:fs';console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),input:readFileSync(0,'utf8')}));process.stderr.write('native stderr\\n');process.exitCode=23;");
    for (const name of ['git','gh','bun','node']) {
      const relative=name==='git'?'git/cmd/git.exe':name+'/'+name+'.exe';
      stub(name==='node'?node:name==='bun'?process.execPath:echo,join(root,relative));
      write(join(root,name+'.link.cmd'),'@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "GIDD_JS_EXEC=%~dp0'+relative.replaceAll('/','\\')+'"\r\n"%GIDD_JS_EXEC%" %*\r\nexit /b %ERRORLEVEL%\r\n');
    }
    // Native tools must not load the GIDD language setting or register tasks.
    write(join(root,'config.toml'),'invalid configuration');
    const before=snapshot(root), args=['two words','','--help','tail\\','a & b','a^b','!literal!','two "quotes"','中文 😀','--','a|b','<in>','a(b)','last'];
    for (const name of ['git','gh','bun','node']) {
      const runtime=['bun','node'].includes(name), forwarded=runtime?[script,...args]:['--test-profile',...args];
      const result=s.invoke([name,...forwarded],{GH_PROMPT_DISABLED:'caller',GH_EDITOR:'caller editor'},{cwd:caller,input:'native stdin 中文'});
      assert.equal(result.status,23,JSON.stringify(result)); assert.equal(result.stderr,'native stderr\n');
      if (runtime) {
        const report=json(result); assert.deepEqual(report.args,args);
        assert.equal(report.input,'native stdin 中文'); sameDirectory(report.cwd,caller);
      } else {
        const rows=result.stdout.trim().split(/\r?\n/).map(row=>{const i=row.indexOf('=');return [row.slice(0,i),Buffer.from(row.slice(i+1),'base64').toString('utf8')];});
        const values=Object.fromEntries(rows);
        assert.deepEqual(rows.filter(([key])=>key==='arg').map(([,value])=>value),forwarded);
        assert.equal(values.input,'native stdin 中文'); sameDirectory(values.cwd,caller);
        assert.equal(values.GH_PROMPT_DISABLED,'caller'); assert.equal(values.GH_EDITOR,'caller editor');
      }
    }
    assert.equal(s.invoke(['node','-e','process.exit(300)'],{},{cwd:caller}).status,300);
    assert.deepEqual(snapshot(root),before); assert.equal(existsSync(caller+'.gidd'),false);
  } finally {f.dispose();}
});

test('native launcher failures keep stdout empty and do not repair or fall back', () => {
  const f=fixture();
  try {
    const s=installation(f), root=toolsRoot(f.root), launcher=join(root,'git.link.cmd'); bindNodeFixture(f.root);
    rmSync(launcher);
    let before=snapshot(root);
    const missing=s.invoke(['git','--version']);
    assert.equal(executionFailure(missing).code,'tool_launcher_missing:git');
    assert.match(missing.stderr,/tools\.ensure\.cmd git/);
    assert.deepEqual(snapshot(root),before);
    for (const text of ['unknown launcher','set "GIDD_JS_EXEC=%~dp0../git.exe"','set "GIDD_JS_EXEC='+join(f.root,'missing/git.exe')+'"']) {
      write(launcher,text); before=snapshot(root);
      const failure=executionFailure(s.invoke(['git','--version']));
      assert.equal(failure.code,text.startsWith('set "GIDD_JS_EXEC='+f.root)?'process_start_failed':'tool_launcher_invalid:git');
      assert.deepEqual(snapshot(root),before);
    }
    rmSync(join(root,'node.link.cmd')); before=snapshot(root);
    for (const name of ['git','gh','bun','node']) {
      const result=s.invoke([name,'--version']);
      assert.equal(executionFailure(result).code,'runtime_unavailable');
      assert.match(result.stderr,/tools\.ensure\.cmd node/);
    }
    assert.deepEqual(snapshot(root),before);
  } finally {f.dispose();}
});

test('runtime failures report repair commands and only an available counterpart without replacing tools', () => {
  const f=fixture();
  try {
    const skill=join(f.root,'installed skill & spaces'), root=toolsRoot(f.root), fake=compile(f.root);
    copySkill(skill);
    const invoke=name=>{
      const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
      return run(cmd,['/d','/s','/c',`""${join(skill,'gidd.cmd')}" ${name} --version"`],{windowsVerbatimArguments:true});
    };
    const launcher=name=>'@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "GIDD_JS_EXEC=%~dp0'+name+'\\'+name+'.exe"\r\n"%GIDD_JS_EXEC%" %*\r\nexit /b %ERRORLEVEL%\r\n';
    const bun=join(root,'bun/bun.exe'), nodeLink=join(root,'node.link.cmd'), node=join(root,'node/node.exe');
    stub(fake,bun); write(join(root,'bun.link.cmd'),launcher('bun'));
    for (const state of ['missing launcher','malformed launcher','missing executable','failed executable']) {
      if (state==='malformed launcher') write(nodeLink,'unknown launcher');
      if (['missing executable','failed executable'].includes(state)) write(nodeLink,launcher('node'));
      if (state==='failed executable') stub(fake,node,'fail');
      const before=snapshot(root), result=invoke('git');
      assert.equal(executionFailure(result).code,'runtime_unavailable');
      assert.match(result.stderr,/tools\.ensure\.cmd node/);
      assert.match(result.stderr,/bun: available\. Use bun\.link\.cmd directly/);
      assert.doesNotMatch(result.stderr,/private-test-secret/);
      assert.deepEqual(snapshot(root),before);
    }
    rmSync(bun);
    let before=snapshot(root), result;
    for (const name of ['node','bun']) {
      result=invoke(name);
      assert.equal(executionFailure(result).code,'runtime_unavailable');
      assert.match(result.stderr,/tools\.ensure\.cmd node/);
      assert.doesNotMatch(result.stderr,/bun:|tools\.ensure\.cmd bun/);
    }
    result=ps(join(skill,'scripts.powershell/tool-runtime.ps1'),['-Unavailable','bun']);
    assert.equal(result.status,2);
    assert.equal(result.stdout,'');
    assert.equal(result.stderr,'');
    assert.deepEqual(snapshot(root),before);
    bindNodeFixture(f.root);
    for (const state of ['missing launcher','missing executable','malformed launcher']) {
      if (state==='missing launcher') rmSync(join(root,'bun.link.cmd'));
      if (state==='missing executable') write(join(root,'bun.link.cmd'),launcher('bun'));
      if (state==='malformed launcher') write(join(root,'bun.link.cmd'),'unknown launcher');
      before=snapshot(root); result=invoke('bun');
      assert.equal(executionFailure(result).code,state==='missing launcher'?'tool_launcher_missing:bun':state==='missing executable'?'process_start_failed':'tool_launcher_invalid:bun');
      assert.match(result.stderr,/tools\.ensure\.cmd bun/);
      assert.match(result.stderr,/node: available\. Use gidd node/);
      assert.deepEqual(snapshot(root),before);
    }
  } finally {f.dispose();}
});

test('native route cancellation stops the tool and its child processes', () => {
  const f=fixture();
  try {
    const s=installation(f), root=toolsRoot(f.root), marker=join(f.root,'native-running'), node=bindNodeFixture(f.root);
    write(join(root,'git.link.cmd'),'set "GIDD_JS_EXEC='+node.replaceAll('%','%%')+'"');
    const entry=pathToFileURL(join(s.skill,'scripts.js/gidd.mjs')).href;
    const driver=join(f.root,'cancel.mjs');
    write(driver,`import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
const {main}=await import(${JSON.stringify(entry)});
const marker=${JSON.stringify(marker)}, deadline=Date.now()+10000;
const pending=main(['git',${JSON.stringify(join(support,'fixture-worker.mjs'))},'parent',marker]);
while(!existsSync(marker+'.locked')) {
  if(Date.now()>deadline) throw new Error('tool_did_not_start');
  await new Promise(resolve=>setTimeout(resolve,25));
}
process.emit('SIGINT');
process.exitCode=await pending;
const pid=Number(readFileSync(marker+'.pid','utf8'));
assert.throws(()=>process.kill(pid,0),'Cancellation must stop descendants before returning');
`);
    const result=run(node,[driver]);
    assert.equal(result.status,130,result.stderr); assert.equal(result.stdout,'');
    rmSync(marker);
  } finally {f.dispose();}
});

test('bootstrap prefers PATH runtimes over unbound portable copies and validates candidates', () => {
  const f=fixture();
  try {
    const exe=compile(f.root), root=toolsRoot(f.root), bin=join(f.root,'bin'), log=join(f.root,'probes.log');
    const invoke=(extra={},path=bin)=>adapter(f.root,{action:'bootstrap',repositoryRoot:f.root,responses:{},downloads:{},...extra},{env:{PATH:path,GIDD_TEST_PROBE_LOG:log}});
    const expect=(name,source,extra={})=>{
      rmSync(log,{force:true}); const r=json(ok(invoke(extra))).runtime;
      assert.equal(r.id,`tool.${name}`); assert.equal(r.details.source,source); return readFileSync(log,'utf8');
    };
    stub(exe,join(root,'node/node.exe'),undefined,true); stub(exe,join(bin,'bun.exe'));
    expect('bun','path');
    stub(exe,join(root,'bun/bun.exe'),undefined,true);
    expect('bun','path');
    assert.ok(!expect('node','managed',{node:true}).includes('bun.exe'));
    write(join(root,'bun/install.json'),'corrupt');
    expect('bun','path');
    rmSync(root,{recursive:true}); stub(exe,join(bin,'node.exe'));
    expect('bun','path'); expect('node','path',{node:true});
    write(join(bin,'bun.exe.mode'),'1.0.0'); expect('node','path');
    stub(exe,join(root,'bun/bun.exe'),undefined,true); write(join(root,'bun/install.json'),'corrupt');
    assert.equal(json(ok(invoke({},join(root,'bun')))).runtime,null,'Managed candidates found through PATH still need integrity validation');
    assert.match(invoke({yes:true},join(root,'bun')).stderr,/occupied_or_unknown_target:bun/);
  } finally {f.dispose();}
});

test('runtime selection prioritizes usable bindings and removes a stale preferred launcher',()=>{
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
    write(join(root,'bun/bun.exe.mode'),'1.0.0');
    assert.equal(json(ok(invoke())).runtime.id,'tool.node','An unusable bound Bun does not hide a usable bound Node');
    assert.equal(existsSync(join(root,'bun.link.cmd')),false,'The entry must reach the selected Node');
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
      makeZip(archive,[{name:entry,source:exe},...(name==='node'?[{name:`node-v${version}-win-x64/LICENSE`,source:license}]:[])]);
      const checksum=name==='bun'?`https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt`:`https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
      const url=name==='bun'?`https://github.com/oven-sh/bun/releases/download/bun-v${version}/${archiveName}`:`https://nodejs.org/dist/v${version}/${archiveName}`;
      const licenseUrl=`https://raw.githubusercontent.com/oven-sh/bun/bun-v${version}/LICENSE.md`;
      const metadata=name==='bun'?{'https://api.github.com/repos/oven-sh/bun/releases/latest':JSON.stringify({tag_name:`bun-v${version}`,draft:false,prerelease:false})}:
        {'https://nodejs.org/dist/index.json':JSON.stringify([{version:`v${version}`,lts:'Fixture',files:['win-x64-zip']}])};
      const responses={...metadata,[checksum]:`${hash(archive)}  ${archiveName}\n`,[licenseUrl]:readFileSync(license,'utf8')}, downloads={[url]:archive,[licenseUrl]:license};
      write(config,'schema_version = 1\n');
      const requestData={action:'bootstrap',repositoryRoot:f.root,responses,downloads,yes:true,node:name==='node'}, env={PATH:'',USERPROFILE:home};
      const invoke=(extra={})=>adapter(f.root,{...requestData,...extra},{env});
      const first = ok(invoke(name === 'node' ? {node:false} : {}));
      if (name === 'node') assert.match(first.stderr, /trying Node/);
      const before=hash(config), result=json(first), root=toolsRoot(home), target=join(root,name), launcher=join(root,name+'.link.cmd');
      assert.equal(result.runtime.id,`tool.${name}`); assert.equal(hash(config),before); assert.equal(existsSync(join(root,name==='bun'?'node':'bun')),false);
      const healthy=snapshot(home); assert.equal(json(ok(invoke({responses:{},downloads:{}}))).runtime_action,'reused');
      assert.deepEqual(snapshot(home),healthy);
      const launcherHash=hash(launcher), executable=join(target,`${name}.exe`);
      write(executable,'damaged GIDD executable');
      assert.equal(json(ok(invoke())).runtime_action,'repaired'); assert.equal(hash(executable),hash(exe));
      assert.equal(hash(launcher),launcherHash); assert.equal(existsSync(join(root,`.cache/previous-${name}`)),false);
      write(executable,'damaged before committed cleanup failure');
      const committed=json(ok(invoke({failCleanup:true,publicReport:true})));
      assert.equal(committed.tools[0].status,'ready');
      assert.equal(committed.tools[0].details.code,'installation_cleanup_pending');
      assert.equal(committed.tools[0].details.path,join(root,'.cache'));
      assert.equal(hash(executable),hash(exe),'Post-publication cleanup must not restore the damaged executable');
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
      const forced=json(ok(invoke({reinstall:true,node:false,publicReport:true})));
      assert.equal(forced.tools[0].name,name,'Force retains the bound runtime kind without a selector');
      assert.equal(forced.tools[0].action,'reinstalled');
      assert.equal(forced.tools[0].path,executable);
      const beforeInterruption=snapshot(target);
      const definition=json(ok(adapter(f.root,{action:'release',name,version,source:name==='bun'?'https://github.com/oven-sh/bun/releases':'https://nodejs.org/dist',pinnedPath:'',responses})));
      const definitionPath=join(f.root,`${name}-definition.json`); write(definitionPath,JSON.stringify(definition));
      if(name==='bun') write(join(f.root,`bun-${version}-LICENSE.md`),readFileSync(license,'utf8'));
      const interrupted=adapter(f.root,{...installRequest(root,definitionPath,f.root,'backed_up'),replace:true},{env});
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
    assert.equal(report.tools[0].path,join(bin,`${name}.exe`));
    const launcher=join(toolsRoot(home),runtimeLink), previous=hash(launcher);
    assert.doesNotMatch(readFileSync(launcher,'utf8'), /chcp|[^\x00-\x7f]/i);
    const root=toolsRoot(home), binding=join(root,readdirSync(root).find(n=>n.startsWith('.runtime-path-')));
    assert.equal(lstatSync(binding).isSymbolicLink(),true); sameDirectory(binding,bin);
    assert.equal(json(ok(s.ensure([process.versions.bun?'bun':'node','--check'],env))).tools[0].status,'ready');
    rmSync(binding); // Remove the junction itself, never its external contents.
    assert.equal(existsSync(join(bin,`${name}.exe`)),true);
    assert.equal(json(s.ensure([process.versions.bun?'bun':'node','--check'],env)).tools[0].details.code,'bootstrap_required');
    assert.equal(existsSync(binding),false,'Read-only checks must not repair a missing link');
    write(binding,'unknown file');
    assert.equal(json(s.ensure([],env)).details.code,'occupied_runtime_binding');
    assert.equal(readFileSync(binding,'utf8'),'unknown file'); assert.equal(hash(launcher),previous);
    rmSync(binding);
    const wrong=join(f.root,'wrong target'); mkdirSync(wrong); symlinkSync(wrong,binding,'junction');
    assert.equal(json(s.ensure([],env)).details.code,'occupied_runtime_binding');
    sameDirectory(binding,wrong); assert.equal(hash(launcher),previous); rmSync(binding);
    assert.equal(json(ok(s.ensure([],env))).tools[0].action,'reused');
    sameDirectory(binding,bin);
    write(join(bin,'SKILL.md'),'external content, not GIDD storage');
    assert.equal(json(s.invoke(['doctor'],{...env,PATH:''})).schema,'gidd.doctor/v1');
    const nextBin=join(f.root,'另一个 runtime'); mkdirSync(nextBin); stub(process.execPath,join(nextBin,`${name}.exe`));
    const failed=adapter(f.root,{action:'bootstrap',repositoryRoot:s.target,responses:{},downloads:{},yes:true,failPublish:true},
      {env:{...env,PATH:nextBin}});
    assert.notEqual(failed.status,0); assert.equal(hash(launcher),previous);
    assert.match(ok(s.invoke(['help','en'],{...env,PATH:''})).stdout,/GIDD \(Windows x64/);

    const log=join(f.root,'unexpected-probe.log'), fake=compile(f.root);
    stub(fake,join(toolsRoot(home),'bun/bun.exe'),undefined,true);
    assert.match(ok(s.invoke(['help','en'],{...env,PATH:'',GIDD_TEST_PROBE_LOG:log})).stdout,/GIDD \(Windows x64/);
    assert.equal(hash(launcher),previous); assert.equal(existsSync(log),false);
    rmSync(join(bin,`${name}.exe`));
    assert.notEqual(s.invoke(['help','en'],{...env,GIDD_TEST_PROBE_LOG:log}).status,0);
    assert.equal(existsSync(log),false,'A missing bound runtime must not fall back to managed Bun');
    rmSync(join(root,'bun'),{recursive:true});
    stub(process.execPath,join(root,name,`${name}.exe`),undefined,true);
    assert.equal(json(ok(s.ensure([],{...env,PATH:''}))).tools[0].path,join(root,name,`${name}.exe`));
    assert.doesNotMatch(readFileSync(launcher,'utf8'),/chcp|[^\x00-\x7f]/i);
    assert.match(ok(s.invoke(['--help','en'],{...env,PATH:''})).stdout,/GIDD \(Windows x64/);

  } finally {f.dispose();}
});

test('installed shell entry provides help and doctor reuse a PATH runtime without writes', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f);
    const systemLanguage = /^zh(?:$|[-_])/.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en';
    assert.equal(ok(s.invoke([])).stdout, ok(s.invoke(['help',systemLanguage])).stdout);
    write(join(toolsRoot(f.root), 'config.toml'), 'schema_version = 1\n[ui]\nlanguage = "zh"\n');
    const before = snapshot(f.root), help = {};
    for (const language of ['en', 'zh']) {
      help[language] = ok(s.invoke(['help', language])).stdout;
      assert.equal(help[language].trim(), readFileSync(join(s.skill, 'references/gidd.help.' + (language === 'zh' ? 'zh-CN' : 'en') + '.md'), 'utf8').trim());
      assert.match(help[language], /gidd gh\.auth/);
      assert.doesNotMatch(help[language], /gidd auth\b/);
    }
    assert.match(help.zh, /^GIDD（Windows x64/);
    assert.match(help.en, /GIDD \(Windows x64/);
    for (const alias of ['--help','-h']) assert.equal(ok(s.invoke([alias,'zh'])).stdout, help.zh);
    assert.equal(ok(s.invoke([])).stdout, help.zh);
    for (const args of [['unknown'], ['identity'], ['doctor','--offline','--offline'], ['doctor','--offline=true'],
      ['help','fr'], ['help','en','extra'], ['doctor','--repository','.'], ['doctor','--repository',s.target], ['doctor','--account','x']]) {
      const result = s.invoke(args);
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(json(result).schema, 'gidd.cli/v1');
    }
    const result = s.invoke(['doctor']);
    assert.equal(result.status, 1);
    const report = json(result);
    assert.equal(report.schema, 'gidd.doctor/v1');
    sameDirectory(report.folder, s.target);
    assert.equal(report.checks.find(c => c.id === 'tool.js_runtime').status, 'ready');
    assert.deepEqual(snapshot(f.root), before, 'Help, invalid commands and missing dependencies must not write or install');
  } finally { f.dispose(); }
});

test('removed runtime setup commands fail without changing configuration or tools', () => {
  const f = fixture();
  try {
    const s = installation(f);
    write(join(toolsRoot(f.root), 'config.toml'),'invalid configuration');
    const before = snapshot(f.root), result = s.invoke(['setup','node'],{PATH:''});
    assert.equal(result.status,2);
    assert.equal(json(result).details.code,'unknown_command');
    assert.equal(existsSync(join(s.skill,'scripts.powershell/setup-tools.ps1')),false);
    assert.deepEqual(snapshot(f.root),before,'Rejected commands must not read invalid config, install, or switch the launcher');
  } finally { f.dispose(); }
});

test('language commands edit shared preferences and preserve configuration display', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), env = { PATH: dirname(process.execPath) };
    const config = join(toolsRoot(f.root), 'config.toml');
    const original = 'schema_version = 1';
    for (const value of ['zh', 'en']) {
      const result = json(ok(s.invoke(['lang.set',value],env)));
      assert.equal(result.schema, 'gidd.config/v1');
      assert.equal(result.action, 'set');
      assert.equal(result.key,'ui.language');
    }
    assert.ok(readFileSync(config,'utf8').startsWith(original));
    const shown = ok(s.invoke(['set.show'],env));
    assert.equal(shown.stderr, '');
    assert.equal(shown.stdout,readFileSync(config,'utf8'));
    const cleared = json(ok(s.invoke(['lang.clear'],env)));
    assert.equal(cleared.action, 'clear'); assert.equal(cleared.changed, true);
    assert.equal(json(ok(s.invoke(['lang.clear'],env))).changed, false);
    assert.doesNotMatch(readFileSync(config,'utf8'), /language\s*=/);
    const before = snapshot(f.root);
    assert.equal(json(s.invoke(['lang.set','fr'],env)).details.code, 'config_invalid_ui_language');
    assert.deepEqual(snapshot(f.root),before);
    rmSync(config);
    ok(s.invoke(['lang.set','zh'],env));
    const text = readFileSync(config,'utf8');
    assert.doesNotMatch(text,/hostname/); assert.doesNotMatch(text,/remote.name|remote.url/);
    assert.match(text,/language = "zh"/);
  } finally { f.dispose(); }
});

test('set.show prints exact TOML including invalid configuration and reports read errors only on stderr', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), config = join(toolsRoot(f.root), 'config.toml');
    for (const content of ['', 'schema_version = 1\n', 'broken TOML',
      '\uFEFF# 中文注释\r\n[git]\r\nuser.mode = "invalid"\r\n',
      '# comment\n[repo]\nremote.url = "bad url"\nremote.account = "bad account"']) {
      write(config, content);
      const before = snapshot(f.root), stat = statSync(config, { bigint: true });
      const result = ok(s.invoke(['set.show']));
      assert.equal(result.stdout, content); assert.equal(result.stderr, '');
      assert.deepEqual(snapshot(f.root), before);
      assert.equal(statSync(config, { bigint: true }).mtimeNs, stat.mtimeNs);
    }
    for (const [content, reason] of [[null, 'config_missing'], [Buffer.from([255]), 'config_invalid_utf8'],
      ['#'.repeat(16385), 'config_too_large']]) {
      if (content === null) rmSync(config); else write(config, content);
      const before = snapshot(f.root), result = s.invoke(['set.show']);
      assert.equal(result.status, 2); assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1)).details.code, reason);
      assert.deepEqual(snapshot(f.root), before);
    }
    rmSync(config); mkdirSync(config);
    const result = s.invoke(['set.show']);
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, /config_not_a_file/);
  } finally { f.dispose(); }
});

test('help exposes language commands; removed setters and malformed arguments do not mutate files', { timeout: 30000 }, () => {
  const f = fixture();
  try {
    const s = installation(f), config = join(toolsRoot(f.root), 'config.toml');
    const systemLanguage = /^zh(?:$|[-_])/.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en';
    const rejected = [['show'], ['config', 'show'], ['del', 'git.user.name'], ['delete', 'git.user.name'],
      ['set', 'ui.language', 'zh'], ['clear', 'ui.language'], ['auth'], ['.gh.auth'],
      ['set.show', 'extra'], ['lang.set'], ['lang.set', 'zh', 'extra'], ['lang.clear', 'zh'], ['lang.unknown']];
    // Locale independence is covered in config.test.mjs; avoid a second cross product.
    for (const [index, content] of ['invalid TOML', 'schema_version = 1\n[ui]\nlanguage = "fr"\n', null].entries()) {
      if (content === null) rmSync(config); else write(config, content);
      const before = snapshot(f.root);
      const stat = content === null ? undefined : statSync(config, { bigint: true });
      const locale = ['en_US.UTF-8', 'zh_CN.UTF-8', 'C.UTF-8'][index];
      const env = { LC_ALL: locale, LC_MESSAGES: locale, LANG: locale };
      const help = ok(s.invoke(['help'], env)).stdout;
      assert.equal(help, ok(s.invoke(['help',systemLanguage], env)).stdout);
      assert.equal(/^GIDD（/.test(help), systemLanguage === 'zh');
      for (const syntax of ['gidd lang.set', 'gidd lang.clear']) assert.ok(help.includes(syntax));
      assert.doesNotMatch(help, /gidd set\s|gidd clear/);
      assert.doesNotMatch(help, /gidd config/);
      const cases = index === 0 ? rejected : [['set', 'ui.language', 'zh'], ['set.show', 'extra'], ['lang.set']];
      for (const args of cases) {
        const result = s.invoke(args);
        assert.equal(result.status, 2, args.join(' '));
        const report = args[0] === 'set.show' ? JSON.parse(result.stderr) : json(result);
        if (args[0] === 'set.show') assert.equal(result.stdout, '');
        assert.equal(report.details.code, ['show', 'config', 'del', 'delete', 'set', 'clear', 'auth', '.gh.auth'].includes(args[0]) ? 'unknown_command' : 'invalid_arguments');
      }
      assert.deepEqual(snapshot(f.root), before);
      if (stat) {
        const after = statSync(config, { bigint: true });
        assert.equal(after.mtimeNs, stat.mtimeNs); assert.equal(after.ino, stat.ino);
      }
    }
  } finally { f.dispose(); }
});
