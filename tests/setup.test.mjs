import { test } from 'node:test';
import { symlinkSync, unlinkSync } from 'node:fs';
import { product, jsAdapter, toolsRoot, adapter as shellAdapter, assert, code, compile, dirname, existsSync, fixture, hash, installSpec, join, json, makeZip, mkdirSync, ok, ps, readFileSync, startAdapter as startShellAdapter, stub, until, write } from './support/helpers.mjs';

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
    const external=join(f.root,'external'); stub(exe,join(external,'node.exe')); stub(exe,join(external,'gh.exe'));
    for (const runtime of ['node','bun']) {
      if (runtime==='bun') stub(exe,join(external,'bun.exe'));
      const home=join(f.root,`home-${runtime}`);
      for (const existing of [false,true]) {
        if (existing) mkdirSync(toolsRoot(home),{recursive:true});
        write(join(f.root,'.agents/skills/gidd/config.toml'),`schema_version = 1\n[tools]\n`);
        const report=json(ok(product(['setup','--repository',f.root],{env:{PATH:external,USERPROFILE:home}})));
        assert.equal(report.status,'ready'); assert.equal(report.tools.length,2);
        for (const name of [runtime,'gh']) {
          const matches=report.tools.filter(tool=>tool.name===name); assert.equal(matches.length,1);
          assert.equal(matches[0].action,'reused'); assert.equal(matches[0].path,join(external,`${name}.exe`));
        }
        if (!existing) assert.equal(existsSync(toolsRoot(home)),false);
      }
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
