import { test } from 'node:test';
import { symlinkSync, unlinkSync } from 'node:fs';
import { resolveGitRelease, extractPayload } from '../.agents/skills/gidd/scripts/install.mjs';
import { managedToolValid } from '../.agents/skills/gidd/scripts/storage.mjs';
import { findTool, toolEnvironment } from '../.agents/skills/gidd/scripts/tools.mjs';
import { checkIdentity } from '../.agents/skills/gidd/scripts/github.mjs';
import { product, jsAdapter, toolsRoot, adapter as shellAdapter, assert, code, compile, dirname, existsSync, fixture, hash, installSpec, join, json, makeZip, mkdirSync, ok, ps, readFileSync, startAdapter as startShellAdapter, stub, until, write } from './support/helpers.mjs';

test('MinGit release selection requires the official regular ZIP and asset digest', async () => {
  for (const revision of [1,5]) {
    const name = `MinGit-2.55.0${revision === 1 ? '' : '.' + revision}-64-bit.zip`;
    const tag = `v2.55.0.windows.${revision}`;
    const asset = { name, size: 100, digest: 'sha256:' + 'a'.repeat(64),
      browser_download_url: `https://github.com/git-for-windows/git/releases/download/${tag}/${name}` };
    const release = { tag_name: tag, draft: false, prerelease: false, assets: [asset] };
    const read = data => async url => {
      assert.equal(url,'https://api.github.com/repos/git-for-windows/git/releases/latest'); return JSON.stringify(data);
    };
    const definition = await resolveGitRelease(read(release));
    assert.equal(definition.archive,name); assert.equal(definition.sha256,'a'.repeat(64));
    assert.equal(definition.reported_version,`2.55.0.windows.${revision}`);
    for (const bad of [ { ...release, prerelease:true }, { ...release, assets:[] }, { ...release, assets:[asset,asset] },
      ...[{digest:null},{name:name.replace('-64-bit','-busybox-64-bit')},{browser_download_url:'https://example.invalid/git.zip'}]
        .map(change => ({...release,assets:[{...asset,...change}]})) ]) await assert.rejects(resolveGitRelease(read(bad)));
  }
});

test('MinGit nested installation, integrity, recovery, managed selection and external reuse', { timeout: 120000 }, async () => {
  const f = fixture();
  try {
    const exe = compile(f.root), archive = join(f.root,'git.zip'), license = join(f.root,'license'), empty = join(f.root,'empty');
    write(license,'upstream license'); write(empty,'');
    const entries = [{name:'cmd/git.exe',source:exe},{name:'mingw64/bin/git.exe',source:exe},
      {name:'mingw64/bin/dependency.dll',source:license},{name:'LICENSE.txt',source:license},{name:'etc/empty',source:empty}];
    makeZip(f.root,archive,entries);
    const definition = {name:'git',version:'2.55.0',reported_version:'2.55.0.windows.5',release_tag:'v2.55.0.windows.5',
      archive:'git.zip',url:'https://example.invalid/git.zip',sha256:hash(archive)};
    const definitionPath = join(f.root,'git.json'); write(definitionPath,JSON.stringify(definition));
    const root = toolsRoot(f.root), target = join(root,'git');
    const install = where => jsAdapter(f.root,installSpec(where,definitionPath,f.root));
    assert.equal(json(ok(install(root))).action,'installed');
    assert.equal(managedToolValid(target,'git'),true);
    assert.equal(readFileSync(join(target,'etc/empty')).length,0);
    assert.equal(JSON.parse(readFileSync(join(target,'install.json'))).schema,'gidd.install/v2');
    assert.equal((await findTool('git',{root,source:'managed'})).details.path,join(target,'cmd/git.exe'));
    assert.equal(json(ok(jsAdapter(f.root,installSpec(root,definitionPath,join(f.root,'no-download'))))).action,'reused');
    const configured = ['setup','git','--repository',f.root];
    assert.equal(json(ok(product(configured,{env:{PATH:''}}))).tools[0].action,'reused');
    const doctor = json(product(['doctor','--repository',f.root],{env:{PATH:''}}));
    assert.equal(doctor.checks.find(item=>item.id==='tool.git').details.source,'managed');
    for (const phase of ['downloaded','extracted','verified','published']) {
      const where = join(f.root,'interrupted-'+phase);
      const killed = await startShellAdapter(f.root,installSpec(where,definitionPath,f.root,phase),{javascript:true}).result;
      assert.notEqual(killed.status,0); assert.equal(existsSync(join(where,'git')),phase==='published');
      ok(install(where)); assert.equal(managedToolValid(join(where,'git'),'git'),true);
      assert.equal(existsSync(join(where,'.cache/git')),false);
    }
    const dependency = join(target,'mingw64/bin/dependency.dll'); write(dependency,'corrupt dependency');
    assert.equal(managedToolValid(target,'git'),false);
    for (const searchPath of [join(target,'cmd'),join(target,'mingw64/bin')]) {
      const report=json(product(configured,{env:{PATH:searchPath}}));
      assert.equal(report.reason,'occupied_or_version_conflicting_target:git');
    }
    assert.equal(readFileSync(dependency,'utf8'),'corrupt dependency');
    const outside = join(f.root,'external'), home = join(f.root,'external-home');
    stub(exe,join(outside,'git.exe'));
    assert.deepEqual(json(ok(product(configured,{env:{PATH:outside,USERPROFILE:home}}))).tools,
      [{name:'git',action:'reused',path:join(outside,'git.exe')}]);
    assert.equal(existsSync(toolsRoot(home)),false);
    for (const name of ['../escape','cmd/GIT.exe','cmd/CON.exe','etc/config.toml']) {
      const bad = join(f.root,'bad-'+name.replace(/\W/g,'_')+'.zip'), destination = join(f.root,'bad-'+name.replace(/\W/g,'_'));
      makeZip(f.root,bad,[...entries,{name,source:license}]); mkdirSync(destination);
      assert.throws(()=>extractPayload(readFileSync(bad),destination,definition));
    }
    const linked = Buffer.from(readFileSync(archive));
    const central = linked.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    linked.writeUInt32LE(0xa1ff0000,central+38);
    const linkedDestination=join(f.root,'zip-link'); mkdirSync(linkedDestination);
    assert.throws(()=>extractPayload(linked,linkedDestination,definition),/unsupported_zip_entry_type/);
    const badHash = {...definition,sha256:'0'.repeat(64)}; write(definitionPath,JSON.stringify(badHash));
    assert.match(install(join(f.root,'bad-hash')).stderr,/download_hash_mismatch/);
    write(definitionPath,JSON.stringify({...definition,reported_version:'2.55.0.windows.1'}));
    assert.match(install(join(f.root,'bad-version')).stderr,/installed_version_mismatch/);
    write(join(f.root,'unknown/git/user.txt'),'keep');
    assert.match(install(join(f.root,'unknown')).stderr,/occupied_or_invalid_target:git/);
    assert.equal(readFileSync(join(f.root,'unknown/git/user.txt'),'utf8'),'keep');
  } finally { f.dispose(); }
});

test('Git and gh share selected PATH without changing the parent environment', async () => {
  const f = fixture();
  try {
    const git=join(f.root,'git/cmd/git.exe'), gh=join(f.root,'gh.exe');
    const original={Path:'external',GIT_EXEC_PATH:'another-git',git_template_dir:'another-template',KEEP:'value'};
    const env=toolEnvironment(git,original);
    assert.equal(env.PATH,dirname(git)+';external'); assert.equal(env.KEEP,'value');
    assert.equal(env.GIT_EXEC_PATH,undefined); assert.equal(env.git_template_dir,'another-template');
    assert.equal(original.Path,'external'); assert.equal(original.GIT_EXEC_PATH,'another-git');
    const calls=[];
    await checkIdentity({repository:f.root,git,gh,hostname:'github.com',account:'Octocat',remote:'origin'},async (exe,args,options)=>{
      calls.push(exe); assert.equal(options.env,env); return {ok:false,reason:'test_unavailable',text:''};
    },env);
    assert.ok(calls.includes(git)); assert.ok(calls.includes(gh));
  } finally {f.dispose();}
});

test('Shell and JS installers exclude each other and reclaim a killed owner', { timeout: 60000 }, async () => {
  const f = fixture();
  try {
    const exe = compile(f.root), archive = join(f.root,'bun.zip'), definitionPath = join(f.root,'definition.json');
    makeZip(f.root,archive,[{ name: 'bun/bun.exe', source: exe }]);
    write(definitionPath,JSON.stringify({ name: 'bun', version: '1.4.2', archive: 'bun.zip', url: 'https://fixture.invalid/bun.zip', sha256: hash(archive), files: [{ entry: 'bun/bun.exe', name: 'bun.exe' }], supplements: [] }));
    for (const javascript of [false,true]) {
      const root = join(f.root,`lock-${javascript}`), spec = installSpec(root,definitionPath,f.root);
      const owner = startShellAdapter(f.root,{ ...spec, stopAt: 'locked' },{ javascript });
      try {
        await until(() => existsSync(owner.marker));
        const competing = (javascript ? shellAdapter : jsAdapter)(f.root,spec);
        assert.notEqual(competing.status,0); assert.match(competing.stderr,/install_locked/);
      } finally { owner.child.kill(); await owner.result; }
      ok((javascript ? shellAdapter : jsAdapter)(f.root,spec));
      assert.equal(existsSync(join(root,'bun/install.json')),true);
    }
    // Retire the old unlocked empty file without accepting an unknown file.
    const root = join(f.root,'legacy'); write(join(root,'.cache/install.lock'),'');
    ok(jsAdapter(f.root,{ action: 'guide', root }));
    write(join(root,'.cache/install.lock'),'unknown owner data');
    assert.match(jsAdapter(f.root,{ action: 'guide', root }).stderr,/install_locked/);
    assert.equal(readFileSync(join(root,'.cache/install.lock'),'utf8'),'unknown owner data');
    const legacyRoot = join(f.root,'legacy-running');
    const old = startShellAdapter(f.root,{ action: 'legacy-lock', root: legacyRoot });
    try {
      await until(() => existsSync(old.marker));
      for (const invoke of [shellAdapter,jsAdapter]) assert.notEqual(invoke(f.root,{ action: 'guide', root: legacyRoot }).status,0,'Never retire a live legacy OS lock');
      assert.equal(existsSync(join(legacyRoot,'.cache/install.lock')),true);
    } finally { old.child.kill(); await old.result; }
    ok(jsAdapter(f.root,{ action: 'guide', root: legacyRoot }));
  } finally { f.dispose(); }
});

for (const engine of ['shell','javascript']) {
const adapter = engine === 'shell' ? shellAdapter : jsAdapter;
const startAdapter = (root,spec) => startShellAdapter(root,spec,{ javascript: engine === 'javascript' });
test(`setup ${engine}: install, integrity, interrupted publication, locks, preservation and reuse`, { timeout: 120000 }, async () => {
  const f = fixture();
  try {
    const exe = compile(f.root), archive = join(f.root,'bun.zip');
    makeZip(f.root,archive,[{name:'bun-windows-x64/bun.exe',source:exe}]);
    const definition = {name:'bun',version:'1.4.2',archive:'bun.zip',url:'https://example.invalid/bun.zip',sha256:hash(archive),files:[{entry:'bun-windows-x64/bun.exe',name:'bun.exe'}],supplements:[]};
    const definitionPath = join(f.root,'definition.json'); write(definitionPath,JSON.stringify(definition));
    const install = (root, path = definitionPath, archives = f.root) => adapter(f.root,installSpec(root,path,archives));
    const valid = root => json(ok(adapter(f.root,{action:'validate',root:join(root,'bun'),name:'bun'})));
    const tools = join(f.root,'技能 space/gidd.tools');
    ok(adapter(f.root,{action:'guide',root:tools}));
    write(join(tools,'INSTALLATION.md'),'old guide'); ok(adapter(f.root,{action:'guide',root:tools}));
    assert.ok(readFileSync(join(tools,'INSTALLATION.md'),'utf8').startsWith('# GIDD-managed tools'));
    assert.equal(json(ok(install(tools))).action,'installed'); assert.equal(valid(tools),true);
    assert.equal(existsSync(join(tools,'.cache/bun')),false,'Successful install must remove downloads and extraction');
    assert.equal(existsSync(join(tools,'.cache/install.lock')),false,'Finished installer releases its lock');
    const recordPath=join(tools,'bun/install.json'), recordHash=hash(recordPath), recordText=readFileSync(recordPath,'utf8');
    assert.equal(json(ok(install(tools,definitionPath,join(f.root,'missing')))).action,'reused'); assert.equal(hash(recordPath),recordHash);
    const managedBin=join(tools,'bun'), managedExe=join(managedBin,'bun.exe');
    for (const searchPath of [managedBin,managedBin.replaceAll('\\','/'),managedBin+'\\..\\bun',managedBin.toUpperCase()]) {
      for (const managedPath of [managedExe,managedExe.replaceAll('\\','/')]) {
        const spec={action:'find',name:'bun',minimum:'1.2',pattern:'^(\\d+\\.\\d+\\.\\d+)$',managedPath};
        write(recordPath,recordText);
        assert.equal(json(ok(adapter(f.root,spec,{env:{PATH:searchPath}}))).status,'ready');
        write(recordPath,'incomplete manifest');
        const check=json(ok(adapter(f.root,spec,{env:{PATH:searchPath}})));
        assert.equal(check.status,'invalid'); assert.ok(check.details.rejected.length>=2);
        assert.ok(check.details.rejected.every(x=>x.reason==='managed_integrity_failed'));
      }
    }
    write(recordPath,recordText);
    for (const phase of ['downloaded','extracted','verified','published']) {
      const root=join(f.root,`kill-${phase}/gidd.tools`);
      const killed=await startAdapter(f.root,installSpec(root,definitionPath,f.root,phase)).result;
      assert.notEqual(killed.status,0); assert.equal(existsSync(join(root,'bun')),phase==='published');
      ok(install(root)); assert.equal(valid(root),true); assert.equal(existsSync(join(root,'.cache/bun')),false);
    }
    const concurrent=join(f.root,'concurrent/gidd.tools');
    const owner=startAdapter(f.root,installSpec(concurrent,definitionPath,f.root,'locked'));
    try {
      await until(()=>existsSync(owner.marker));
      assert.equal(existsSync(join(concurrent,'.cache/install.lock')),true);
      const other=await startAdapter(f.root,installSpec(concurrent,definitionPath,f.root)).result;
      assert.notEqual(other.status,0); assert.match(other.stderr,/install_locked/);
    } finally { owner.child.kill(); await owner.result; }
    ok(install(concurrent));
    const partial=join(f.root,'partial/gidd.tools');
    write(join(partial,'.cache/bun/download.part'),'truncated download'); write(join(partial,'.cache/bun/payload/bun.exe'),'partial extraction');
    ok(install(partial)); assert.equal(valid(partial),true);
    write(managedExe,'corrupted'); const corruptHash=hash(managedExe);
    assert.notEqual(install(tools).status,0); assert.equal(hash(managedExe),corruptHash);
    const rejected=json(ok(adapter(f.root,{action:'find',name:'bun',minimum:'1.2',pattern:'^(\\d+\\.\\d+\\.\\d+)$',managedPath:managedExe},{env:{PATH:''}})));
    assert.equal(rejected.details.rejected.at(-1).reason,'managed_integrity_failed');
    const unknown=join(f.root,'unknown/gidd.tools'); write(join(unknown,'bun/user.txt'),'keep');
    assert.notEqual(install(unknown).status,0); assert.equal(readFileSync(join(unknown,'bun/user.txt'),'utf8'),'keep');
    const pair=join(f.root,'pair/gidd.tools'); ok(install(pair));
    const ghPath=join(f.root,'gh.json'); write(ghPath,JSON.stringify({...definition,name:'gh',archive:'absent-gh.zip',version:'2.98.0'}));
    assert.notEqual(install(pair,ghPath).status,0); assert.equal(valid(pair),true); assert.equal(existsSync(join(pair,'gh')),false);
    for (const scenario of ['hash','zip','traversal','version']) {
      const bad=structuredClone(definition), root=join(f.root,`${scenario}/gidd.tools`);
      if (scenario==='hash') bad.sha256='0'.repeat(64);
      if (scenario==='zip') { bad.archive='broken.zip'; write(join(f.root,bad.archive),'not zip'); bad.sha256=hash(join(f.root,bad.archive)); }
      if (scenario==='traversal') { bad.archive='traversal.zip'; makeZip(f.root,join(f.root,bad.archive),[{name:'../escape.exe',source:exe}]); bad.sha256=hash(join(f.root,bad.archive)); }
      if (scenario==='version') bad.version='1.9.9';
      const path=join(f.root,`${scenario}.json`); write(path,JSON.stringify(bad));
      assert.notEqual(install(root,path).status,0); assert.equal(existsSync(join(root,'bun')),false);
    }
    const outside=join(f.root,'outside'); write(join(outside,'keep.txt'),'keep');
    const linked=join(f.root,'linked'), stage=join(f.root,'junction-stage/gidd.tools/.cache/bun');
    const cacheTools=join(f.root,'junction-cache/gidd.tools'), cache=join(cacheTools,'.cache');
    mkdirSync(cacheTools,{recursive:true}); symlinkSync(outside,cache,'junction');
    mkdirSync(dirname(stage),{recursive:true}); symlinkSync(outside,linked,'junction'); symlinkSync(outside,stage,'junction');
    try {
      assert.notEqual(install(join(linked,'gidd.tools')).status,0);
      assert.notEqual(install(cacheTools).status,0,'Lock creation must reject a redirected cache directory');
      assert.equal(existsSync(join(outside,'install.lock')),false);
      assert.notEqual(adapter(f.root,{action:'stage',root:join(f.root,'junction-stage/gidd.tools'),name:'bun'}).status,0);
      assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'keep');
    } finally { unlinkSync(linked); unlinkSync(stage); unlinkSync(cache); }
    const external=join(f.root,'external'); stub(exe,join(external,'gh.exe'));
    const home=join(f.root,'gh-home');
    for (const existing of [false,true]) {
      if (existing) mkdirSync(toolsRoot(home),{recursive:true});
      write(join(f.root,'.agents/skills/gidd/config.toml'),'schema_version = 1\n[tools]\n');
      const report=json(ok(product(['setup','--repository',f.root],{env:{PATH:external,USERPROFILE:home}})));
      assert.equal(report.status,'ready');
      assert.deepEqual(report.tools,[{ name:'gh', action:'reused', path:join(external,'gh.exe') }]);
      if (!existing) assert.equal(existsSync(toolsRoot(home)),false);
    }
  } finally { f.dispose(); }
});

test(`setup ${engine}: Node archive version, integrity and reuse without downloads`, { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const exe=compile(f.root), archive=join(f.root,'node.zip'), root=join(f.root,'node-storage');
    makeZip(f.root,archive,[{name:'node/node.exe',source:exe}]);
    const definition={name:'node',version:'24.19.0',archive:'node.zip',url:'https://example.invalid/node.zip',sha256:hash(archive),files:[{entry:'node/node.exe',name:'node.exe'}],supplements:[]};
    const path=join(f.root,'node.json'); write(path,JSON.stringify(definition));
    assert.equal(json(ok(adapter(f.root,installSpec(root,path,f.root)))).action,'installed');
    assert.equal(existsSync(join(root,'.cache/node')),false);
    assert.equal(json(ok(adapter(f.root,installSpec(root,path,join(f.root,'missing'))))).action,'reused');
    write(path,JSON.stringify({...definition,version:'24.1.0'}));
    const installedHash=hash(join(root,'node/node.exe'));
    assert.match(adapter(f.root,installSpec(root,path,f.root)).stderr,/installed_version_conflict/);
    assert.equal(hash(join(root,'node/node.exe')),installedHash);
    assert.match(adapter(f.root,installSpec(join(f.root,'wrong-version'),path,f.root)).stderr,/installed_version_mismatch/);
    write(join(root,'node/node.exe'),'corrupt');
    assert.match(adapter(f.root,installSpec(root,path,f.root)).stderr,/occupied_or_invalid_target/);
  } finally { f.dispose(); }
});

}
