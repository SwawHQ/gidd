import { test } from 'node:test';
import { toolsRoot, assert, code, existsSync, fixture, join, json, ok, ps, repo, run, write, product, mkdirSync } from './support/helpers.mjs';
import { toolEnvironment } from '../.agents/skills/gidd/scripts/tools.mjs';

const live = process.env.GIDD_LIVE_TEST === '1' ? test : test.skip;
live('official MinGit setup, local commit clone fetch and gh Git discovery', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    const setup=name=>json(ok(product(['setup',name,'--repository',f.root],{env:{PATH:''},timeout:120000})));
    const git=setup('git').tools[0]; assert.equal(git.action,'installed');
    const gh=setup('gh').tools[0]; assert.equal(gh.action,'installed');
    assert.equal(setup('git').tools[0].action,'reused');
    assert.equal(existsSync(join(toolsRoot(f.root),'js_exec.cmd')),false);
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
    const diagnosis=json(product(['doctor','--repository',source],{env:{PATH:''}}));
    assert.equal(diagnosis.checks.find(item=>item.id==='tool.git').details.path,git.path);
    assert.equal(diagnosis.checks.find(item=>item.id==='repository').status,'ready');
  } finally {f.dispose();}
});

live('official Bun bootstrap and gh setup, post-install doctor and reuse', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    write(join(f.root,'.agents/skills/gidd/config.toml'),'schema_version = 1\n[tools]\n');
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const prepared=run(cmd,['/d','/s','/c',`""${join(repo,'.agents/skills/gidd/gidd.cmd')}" bootstrap --yes --repository "${f.root}""`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    assert.equal(json(ok(prepared)).runtime.id,'tool.bun');
    const invoke=() => run(cmd,['/d','/s','/c',`""${join(repo,'.agents/skills/gidd/gidd.cmd')}" setup gh --repository "${f.root}""`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    const report=json(ok(invoke()));
    assert.deepEqual(report.tools.map(t=>[t.name,t.action]),[['gh','installed']]);
    assert.equal(existsSync(join(toolsRoot(f.root),'node')),false);
    assert.equal(existsSync(join(toolsRoot(f.root),'bun')),true,'stage0 supplies the runtime before JS installs gh');
    const diagnosis=json(ps(join(code,'doctor.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}}));
    for (const id of ['tool.bun','tool.gh','runtime']) assert.equal(diagnosis.checks.find(x=>x.id===id).status,'ready');
    const again=json(ok(ps(join(code,'setup-tools.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}})));
    assert.deepEqual(again.tools.map(t=>[t.name,t.action]),[['gh','reused']]);
  } finally { f.dispose(); }
});

live('official Node download and reuse through bootstrap', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    const root=toolsRoot(f.root);
    write(join(f.root,'.agents/skills/gidd/config.toml'),'schema_version = 1\n[tools]\n');
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const bootstrap=()=>run(cmd,['/d','/s','/c',`""${join(repo,'.agents/skills/gidd/gidd.cmd')}" bootstrap --node --yes --repository "${f.root}""`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    const prepared=json(ok(bootstrap()));
    assert.equal(prepared.runtime.id,'tool.node');
    assert.equal(prepared.runtime_action,'installed');
    const reused=json(ok(bootstrap()));
    assert.equal(reused.runtime_action,'reused');
    assert.equal(reused.launcher_action,'reused');
    assert.equal(existsSync(join(root,'bun')),false);
    assert.equal(existsSync(join(root,'gh')),false);
    assert.equal(existsSync(join(root,'node/npm.cmd')),false);
    const diagnosis=json(ps(join(code,'doctor.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}}));
    assert.equal(diagnosis.checks.find(c=>c.id==='tool.node').status,'ready');
  } finally { f.dispose(); }
});
