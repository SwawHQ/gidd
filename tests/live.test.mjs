import { test } from 'node:test';
import { runRepositoryCommand } from './support/repository.mjs';
import { toolsRoot, assert, copySkill, existsSync, fixture, join, json, ok, run, write, mkdirSync, dirname, findGit } from './support/helpers.mjs';
import { toolEnvironment } from '../skills/gidd/scripts.js/shared/tools.mjs';

function createRepository(root) {
  const git = findGit();
  ok(run(git, ['-C',root,'init','--quiet']));
  ok(run(git, ['-C',root,'remote','add','origin','https://github.com/Team/Repo.git']));
  copySkill(join(root,'.agents/skills/gidd'));
}
const live = process.env.GIDD_LIVE_TEST === '1' ? test : test.skip;
live('official single-tool Git and gh preparation without a runtime', {timeout:300000},()=>{
  const f=fixture();
  try {
    const skill=join(f.root,'skill');copySkill(skill);
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const invoke=(name,extra='')=>run(cmd,['/d','/s','/c',`""${join(skill,'tools.ensure.cmd')}" ${name} ${extra}"`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:180000});
    const selected={};
    for(const name of ['git','gh']) {
      const report=json(ok(invoke(name)));assert.equal(report.tools[0].action,'installed');
      selected[name]=report.tools[0].path;
      assert.equal(json(ok(invoke(name,'--check'))).status,'ready');
      assert.equal(json(ok(invoke(name))).tools[0].action,'reused');
    }
    const root=toolsRoot(f.root);
    for(const name of ['bun','node']) {assert.equal(existsSync(join(root,name)),false);assert.equal(existsSync(join(root,name+'.link.cmd')),false);}
    const env=toolEnvironment(selected.git,{PATH:'',HOME:f.root,USERPROFILE:f.root,GH_CONFIG_DIR:join(f.root,'gh-config'),
      GH_TOKEN:'offline-fixture',GITHUB_TOKEN:'',GH_ENTERPRISE_TOKEN:'',GITHUB_ENTERPRISE_TOKEN:'',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',
      HTTPS_PROXY:'http://127.0.0.1:1',HTTP_PROXY:'http://127.0.0.1:1'});
    const source=join(f.root,'local-source'),clone=join(f.root,'local-clone');mkdirSync(source);
    const git=args=>ok(run(selected.git,args,{cwd:source,env}));
    git(['init']);write(join(source,'hello.txt'),'hello\n');git(['add','.']);
    git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','initial']);
    git(['clone',source,clone]);ok(run(selected.git,['fetch','origin'],{cwd:clone,env}));
    git(['remote','add','origin','https://github.com/example/gidd-fixture.git']);git(['config','remote.origin.gh-resolved','base']);
    assert.equal(ok(run(cmd,['/d','/s','/c',`""${join(root,'gh.link.cmd')}" repo set-default --view"`],
      {windowsVerbatimArguments:true,cwd:source,env:{...env,PATH:''}})).stdout.trim(),'example/gidd-fixture');
  } finally {f.dispose();}
});
live('official unified bootstrap, local commit clone fetch and gh Git discovery', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    createRepository(f.root);
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const bootstrap=(extra='')=>json(ok(run(cmd,['/d','/s','/c',`""${join(f.root,'.agents/skills/gidd/tools.ensure.cmd')}" ${extra}"`],
      {windowsVerbatimArguments:true,env:{PATH:dirname(process.execPath)},timeout:180000})));
    const prepared=bootstrap(),git=prepared.tools.find(t=>t.name==='git'),gh=prepared.tools.find(t=>t.name==='gh');
    assert.equal(git.action,'installed');assert.equal(gh.action,'installed');
    assert.equal(bootstrap().tools.find(t=>t.name==='git').action,'reused');
    const name=process.versions.bun?'bun':'node';
    for (const tool of [name,'git','gh']) {
      assert.equal(bootstrap(tool+' --check').status,'ready');
      const forced=bootstrap(tool+' --force');
      if(tool===name) { assert.equal(forced.tools[0].action,'installed'); assert.equal(forced.tools[0].path,join(toolsRoot(f.root),name,name+'.exe')); }
      else assert.equal(forced.tools[0].action,'reinstalled');
      assert.equal(bootstrap(tool+' --check').status,'ready');
    }
    assert.equal(existsSync(process.execPath),true,'Force preserves the external runtime');
    assert.equal(existsSync(join(toolsRoot(f.root),(process.versions.bun?'bun':'node')+'.link.cmd')),true);
    const env=toolEnvironment(git.path,{PATH:'',HOME:f.root,USERPROFILE:f.root,GH_CONFIG_DIR:join(f.root,'gh-profile'),
      GH_TOKEN:'offline-fixture',GITHUB_TOKEN:'',GH_ENTERPRISE_TOKEN:'',GITHUB_ENTERPRISE_TOKEN:'',
      GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',HTTPS_PROXY:'http://127.0.0.1:1',HTTP_PROXY:'http://127.0.0.1:1'});
    const source=join(f.root,'local-source'),clone=join(f.root,'local-clone'); mkdirSync(source);
    const invoke=(args,cwd=source)=>ok(run(git.path,args,{env,cwd}));
    invoke(['init']); write(join(source,'hello.txt'),'hello\n'); invoke(['add','.']);
    invoke(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','initial']);
    invoke(['clone',source,clone]);
    write(join(source,'hello.txt'),'updated\n'); invoke(['add','.']);
    invoke(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','second']);
    invoke(['fetch','origin'],clone);
    assert.equal(invoke(['rev-parse','FETCH_HEAD'],clone).stdout,invoke(['rev-parse','HEAD']).stdout);
    invoke(['remote','add','origin','https://github.com/example/gidd-fixture.git']);
    invoke(['config','remote.origin.gh-resolved','base']);
    assert.equal(ok(run(gh.path,['repo','set-default','--view'],{env,cwd:source})).stdout.trim(),'example/gidd-fixture');
    copySkill(join(source,'.agents/skills/gidd'));
    const diagnosis=json(runRepositoryCommand(source,['doctor','--offline'],{env:{PATH:''}}));
    assert.equal(diagnosis.checks.find(item=>item.id==='tool.git').details.path,git.path);
    assert.equal(diagnosis.checks.find(item=>item.id==='folder.git.worktree').status,'ready');
  } finally {f.dispose();}
});

live('official gidd cold startup, post-install doctor and reuse', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    createRepository(f.root);
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const prepared=ok(runRepositoryCommand(f.root,['help','zh'],{env:{PATH:''},timeout:300000}));
    assert.match(prepared.stdout,/^GIDD（Windows x64/);
    const installed=JSON.parse(prepared.stderr.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(installed.tools.map(t=>[t.name,t.action]),[['bun','installed'],['git','installed'],['gh','installed']]);
    const reused=ok(runRepositoryCommand(f.root,['help','zh'],{env:{PATH:''}}));
    assert.equal(reused.stdout,prepared.stdout);
    assert.equal(reused.stderr,'');
    const invoke=() => run(cmd,['/d','/s','/c',`""${join(f.root,'.agents/skills/gidd/tools.ensure.cmd')}""`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    const report=json(ok(invoke()));
    assert.deepEqual(report.tools.map(t=>[t.name,t.action]),[['bun','reused'],['git','reused'],['gh','reused']]);
    assert.equal(existsSync(join(toolsRoot(f.root),'node')),false);
    assert.equal(existsSync(join(toolsRoot(f.root),'bun')),true,'PowerShell prepares the runtime and native tools');
    const diagnosis=json(runRepositoryCommand(f.root,['doctor','--offline'],{env:{PATH:''}}));
    for (const id of ['tool.js_runtime','tool.gh']) assert.equal(diagnosis.checks.find(x=>x.id===id).status,'ready');
    const again=json(ok(invoke()));
    assert.deepEqual(again.tools.map(t=>[t.name,t.action]),[['bun','reused'],['git','reused'],['gh','reused']]);
  } finally { f.dispose(); }
});

live('official Node download and reuse through bootstrap', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    createRepository(f.root);
    const root=toolsRoot(f.root);
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const bootstrap=()=>run(cmd,['/d','/s','/c',`""${join(f.root,'.agents/skills/gidd/tools.ensure.cmd')}" node"`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    const prepared=json(ok(bootstrap()));
    assert.equal(prepared.tools[0].name,'node');
    assert.equal(prepared.tools[0].action,'installed');
    const reused=json(ok(bootstrap()));
    assert.equal(reused.tools[0].action,'reused');
    assert.equal(existsSync(join(root,'bun')),false);
    assert.equal(existsSync(join(root,'gh')),false); assert.equal(existsSync(join(root,'git')),false);
    assert.equal(existsSync(join(root,'node/npm.cmd')),false);
    const diagnosis=json(runRepositoryCommand(f.root,['doctor','--offline'],{env:{PATH:''}}));
    assert.equal(diagnosis.checks.find(c=>c.id==='tool.js_runtime').status,'ready');
  } finally { f.dispose(); }
});
