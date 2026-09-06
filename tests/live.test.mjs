import { test } from 'bun:test';
import { assert, code, fixture, join, json, ok, ps } from './support/helpers.mjs';

const live = process.env.GIDD_LIVE_TEST === '1' ? test : test.skip;
live('official Bun/gh archives, post-install doctor and offline reuse', () => {
  const f=fixture();
  try {
    const skills=join(f.root,'技能 tools');
    const args=['-UserSkillsRoot',skills];
    if (process.env.GIDD_ARCHIVE_DIRECTORY) args.push('-ArchiveDirectory',process.env.GIDD_ARCHIVE_DIRECTORY);
    const report=json(ok(ps(join(code,'setup-tools.ps1'),args,{env:{PATH:''},timeout:300000})));
    assert.equal(report.status,'ready'); assert.equal(report.tools.filter(x=>x.action==='installed').length,2);
    const diagnosis=json(ps(join(code,'doctor.ps1'),['-RepositoryPath',f.root,'-UserSkillsRoot',skills],{env:{PATH:''}}));
    for (const id of ['tool.bun','tool.gh','runtime']) assert.equal(diagnosis.checks.find(x=>x.id===id).status,'ready');
    const again=json(ok(ps(join(code,'setup-tools.ps1'),['-UserSkillsRoot',skills,'-ArchiveDirectory',join(f.root,'missing')],{env:{PATH:''}})));
    assert.ok(again.tools.every(x=>x.action==='reused'));
  } finally { f.dispose(); }
},300000);
