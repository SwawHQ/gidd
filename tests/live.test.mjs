import { test } from 'node:test';
import { toolsRoot, assert, code, existsSync, fixture, join, json, ok, ps, repo, run, write } from './support/helpers.mjs';

const live = process.env.GIDD_LIVE_TEST === '1' ? test : test.skip;
live('official Bun/gh downloads, post-install doctor and reuse', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    write(join(f.root,'.agents/skills/gidd/config.toml'),`schema_version = 1\n[tools]\n`);
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const invoke=tool => run(cmd,['/d','/s','/c',`""${join(repo,'.agents/skills/gidd/gidd.cmd')}" setup ${tool} --repository "${f.root}""`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    for (const tool of ['gh','bun']) {
      const report=json(ok(invoke(tool)));
      assert.equal(report.status,'ready');
      assert.deepEqual(report.tools.map(t=>[t.name,t.action]),[[tool,'installed']]);
      assert.equal(existsSync(join(toolsRoot(f.root),'node')),false);
      if (tool==='gh') assert.equal(existsSync(join(toolsRoot(f.root),'bun')),false,'gh setup must not install a runtime');
    }
    const diagnosis=json(ps(join(code,'doctor.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}}));
    for (const id of ['tool.bun','tool.gh','runtime']) assert.equal(diagnosis.checks.find(x=>x.id===id).status,'ready');
    const again=json(ok(ps(join(code,'setup-tools.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}})));
    assert.ok(again.tools.every(x=>x.action==='reused'));
  } finally { f.dispose(); }
});

live('official Node download and reuse through the public shell entry', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    const root=toolsRoot(f.root);
    write(join(f.root,'.agents/skills/gidd/config.toml'),'schema_version = 1\n[tools]\n');
    const cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const invoke=() => run(cmd,['/d','/s','/c',`""${join(repo,'.agents/skills/gidd/gidd.cmd')}" setup node --repository "${f.root}""`],
      {windowsVerbatimArguments:true,env:{PATH:''},timeout:300000});
    assert.deepEqual(json(ok(invoke())).tools.map(t=>[t.name,t.action]),[['node','installed']]);
    assert.equal(existsSync(join(root,'bun')),false);
    assert.equal(existsSync(join(root,'gh')),false);
    assert.equal(existsSync(join(root,'node/npm.cmd')),false);
    const diagnosis=json(ps(join(code,'doctor.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}}));
    assert.equal(diagnosis.checks.find(c=>c.id==='tool.node').status,'ready');
    assert.deepEqual(json(ok(invoke())).tools.map(t=>[t.name,t.action]),[['node','reused']]);
  } finally { f.dispose(); }
});
