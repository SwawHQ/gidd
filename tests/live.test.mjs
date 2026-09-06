import { test } from 'node:test';
import { adapter, assert, code, fixture, installSpec, join, json, ok, ps, run, write } from './support/helpers.mjs';

const live = process.env.GIDD_LIVE_TEST === '1' ? test : test.skip;
live('official Bun/gh downloads, post-install doctor and reuse', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    const skills=join(f.root,'技能 tools');
    write(join(f.root,'.agents/skills/gidd/config.toml'),`schema_version = 1\n[tools]\ndirectory = ${JSON.stringify(join(skills,'gidd.tools').replaceAll('\\','/'))}\n`);
    const args=['-RepositoryPath',f.root];
    const report=json(ok(ps(join(code,'setup-tools.ps1'),args,{env:{PATH:''},timeout:300000})));
    assert.equal(report.status,'ready'); assert.equal(report.tools.filter(x=>x.action==='installed').length,2);
    const diagnosis=json(ps(join(code,'doctor.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}}));
    for (const id of ['tool.bun','tool.gh','runtime']) assert.equal(diagnosis.checks.find(x=>x.id===id).status,'ready');
    const again=json(ok(ps(join(code,'setup-tools.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}})));
    assert.ok(again.tools.every(x=>x.action==='reused'));
  } finally { f.dispose(); }
});

live('official development Node download and reuse', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    const definition=json(ok(adapter(f.root,{action:'release',name:'node',version:'lts',source:'https://nodejs.org/dist',pinnedPath:'',responses:null},{timeout:120000})));
    const path=join(f.root,'node.json'); write(path,JSON.stringify(definition));
    const root=join(f.root,'.dev');
    const spec=installSpec(root,path);
    assert.equal(json(ok(adapter(f.root,spec,{timeout:300000}))).action,'installed');
    assert.equal(ok(run(join(root,'node/node.exe'),['--version'])).stdout.trim(),`v${definition.version}`);
    assert.equal(json(ok(adapter(f.root,installSpec(root,path,join(f.root,'missing'))))).action,'reused');
  } finally { f.dispose(); }
});
