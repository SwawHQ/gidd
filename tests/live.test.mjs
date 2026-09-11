import { test } from 'node:test';
import { toolsRoot, assert, code, existsSync, fixture, join, json, ok, ps, repo, run, write } from './support/helpers.mjs';

const live = process.env.GIDD_LIVE_TEST === '1' ? test : test.skip;
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
