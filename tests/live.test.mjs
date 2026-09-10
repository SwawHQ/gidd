import { test } from 'node:test';
import { product, toolsRoot, assert, code, existsSync, fixture, join, json, ok, ps, repo, run, write } from './support/helpers.mjs';

const live = process.env.GIDD_LIVE_TEST === '1' ? test : test.skip;
live('official Bun/gh downloads, post-install doctor and reuse', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    const preferred = process.versions.bun ? 'bun' : 'node';
    write(join(f.root,'.agents/skills/gidd/config.toml'),'schema_version = 1\n[tools]\n');
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const prepared=run(cmd,['/d','/s','/c',`""${join(repo,'.agents/skills/gidd/gidd.cmd')}" bootstrap --yes ${preferred==='node'?'--node':''} --repository "${f.root}""`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    assert.equal(json(ok(prepared)).runtime.id,`tool.${preferred}`);
    const invoke=tool => run(cmd,['/d','/s','/c',`""${join(repo,'.agents/skills/gidd/gidd.cmd')}" setup ${tool} --repository "${f.root}""`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    for (const tool of ['gh','bun']) {
      const report=json(ok(invoke(tool)));
      assert.equal(report.status,'ready');
      assert.deepEqual(report.tools.map(t=>[t.name,t.action]),[[tool,tool === preferred ? 'reused' : 'installed']]);
      assert.equal(existsSync(join(toolsRoot(f.root),'node')),preferred === 'node');
      if (tool==='gh') assert.equal(existsSync(join(toolsRoot(f.root),preferred)),true,'stage0 supplies the runtime before JS installs gh');
    }
    const diagnosis=json(ps(join(code,'doctor.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}}));
    for (const id of ['tool.bun','tool.gh','runtime']) assert.equal(diagnosis.checks.find(x=>x.id===id).status,'ready');
    const again=json(ok(ps(join(code,'setup-tools.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}})));
    assert.ok(again.tools.every(x=>x.action==='reused'));
  } finally { f.dispose(); }
});

live('JavaScript installs an official Node archive under the test runtime', { timeout: 300000 }, () => {
  const f = fixture();
  try {
    write(join(f.root,'.agents/skills/gidd/config.toml'),'schema_version = 1\n[tools]\n');
    const invoke = () => product(['setup','node','--repository',f.root],{ env: { PATH: '' }, timeout: 300000 });
    assert.deepEqual(json(ok(invoke())).tools.map(tool => [tool.name,tool.action]),[['node','installed']]);
    assert.equal(existsSync(join(toolsRoot(f.root),'node/npm.cmd')),false);
    assert.deepEqual(json(ok(invoke())).tools.map(tool => [tool.name,tool.action]),[['node','reused']]);
  } finally { f.dispose(); }
});

live('official Node download and reuse through the public shell entry', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    const root=toolsRoot(f.root);
    write(join(f.root,'.agents/skills/gidd/config.toml'),'schema_version = 1\n[tools]\n');
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const bootstrap=()=>run(cmd,['/d','/s','/c',`""${join(repo,'.agents/skills/gidd/gidd.cmd')}" bootstrap --node --yes --repository "${f.root}""`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    assert.equal(json(ok(bootstrap())).runtime.id,'tool.node');
    const invoke=() => run(cmd,['/d','/s','/c',`""${join(repo,'.agents/skills/gidd/gidd.cmd')}" setup node --repository "${f.root}""`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    assert.deepEqual(json(ok(invoke())).tools.map(t=>[t.name,t.action]),[['node','reused']]);
    assert.equal(json(ok(bootstrap())).launcher_action,'reused');
    assert.equal(existsSync(join(root,'bun')),false);
    assert.equal(existsSync(join(root,'gh')),false);
    assert.equal(existsSync(join(root,'node/npm.cmd')),false);
    const diagnosis=json(ps(join(code,'doctor.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}}));
    assert.equal(diagnosis.checks.find(c=>c.id==='tool.node').status,'ready');
    assert.deepEqual(json(ok(invoke())).tools.map(t=>[t.name,t.action]),[['node','reused']]);
  } finally { f.dispose(); }
});
