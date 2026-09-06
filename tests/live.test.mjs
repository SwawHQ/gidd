import { test } from 'node:test';
import { adapter, assert, code, fixture, installSpec, join, json, ok, ps, readFileSync, repo, run, write } from './support/helpers.mjs';

const live = process.env.GIDD_LIVE_TEST === '1' ? test : test.skip;
live('official Bun/gh archives, post-install doctor and offline reuse', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    const skills=join(f.root,'技能 tools');
    write(join(f.root,'.agents/skills/gidd/config.toml'),`schema_version = 1\n[tools]\ndirectory = ${JSON.stringify(join(skills,'gidd.tools').replaceAll('\\','/'))}\n`);
    const args=['-RepositoryPath',f.root];
    if (process.env.GIDD_ARCHIVE_DIRECTORY) args.push('-ArchiveDirectory',process.env.GIDD_ARCHIVE_DIRECTORY);
    const report=json(ok(ps(join(code,'setup-tools.ps1'),args,{env:{PATH:''},timeout:300000})));
    assert.equal(report.status,'ready'); assert.equal(report.tools.filter(x=>x.action==='installed').length,2);
    const diagnosis=json(ps(join(code,'doctor.ps1'),['-RepositoryPath',f.root],{env:{PATH:''}}));
    for (const id of ['tool.bun','tool.gh','runtime']) assert.equal(diagnosis.checks.find(x=>x.id===id).status,'ready');
    const again=json(ok(ps(join(code,'setup-tools.ps1'),['-RepositoryPath',f.root,'-ArchiveDirectory',join(f.root,'missing')],{env:{PATH:''}})));
    assert.ok(again.tools.every(x=>x.action==='reused'));
  } finally { f.dispose(); }
});

live('official development Node archive and offline reuse', { timeout: 300000 }, () => {
  const f=fixture();
  try {
    const definition=JSON.parse(readFileSync(join(repo,'scripts/dev/runtimes.json'),'utf8')).tools[0];
    const path=join(f.root,'node.json'); write(path,JSON.stringify(definition));
    const root=join(f.root,'.dev');
    const spec=installSpec(root,path,process.env.GIDD_ARCHIVE_DIRECTORY || '');
    assert.equal(json(ok(adapter(f.root,spec,{timeout:300000}))).action,'installed');
    assert.equal(ok(run(join(root,'node/node.exe'),['--version'])).stdout.trim(),`v${definition.version}`);
    assert.equal(json(ok(adapter(f.root,installSpec(root,path,join(f.root,'missing'))))).action,'reused');
  } finally { f.dispose(); }
});
