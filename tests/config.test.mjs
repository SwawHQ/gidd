import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { statSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { adapter, assert, code, compile, existsSync, findGit, fixture, hash, join, json, mkdirSync, ok, ps, readFileSync, repo, run, stub, write } from './support/helpers.mjs';

const configText = (directory='.devv') => `# preserved comment\nschema_version = 1\n[tools]\ndirectory = ${JSON.stringify(directory.replaceAll('\\','/'))} # inline comment\n`;
function samePath(actual, expected) {
  while (!existsSync(expected)) {
    assert.equal(basename(actual),basename(expected)); actual=dirname(actual); expected=dirname(expected);
  }
  const a=statSync(actual,{bigint:true}), b=statSync(expected,{bigint:true});
  assert.notEqual(b.ino,0n); assert.equal(a.ino,b.ino); assert.equal(a.dev,b.dev);
}

test('configuration: direct paths, home expansion, supported TOML, validation and no writes', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const repositoryRoot=join(f.root,'仓库 space'), userProfilePath=join(f.root,'profile'); mkdirSync(repositoryRoot);
    const path=join(repositoryRoot,'.agents/skills/gidd/config.toml');
    const resolve=(extra={}) => adapter(f.root,{action:'configuration',repositoryRoot,userProfilePath,defaultDirectory:'~/.agents/skills/gidd.tools',...extra},{env:{PATH:''}});
    samePath(json(ok(resolve())).tools_root,join(userProfilePath,'.agents/skills/gidd.tools'));
    samePath(json(ok(resolve({defaultDirectory:'.dev'}))).tools_root,join(repositoryRoot,'.dev'));
    assert.equal(existsSync(userProfilePath),false); assert.equal(existsSync(path),false);
    write(join(userProfilePath,'.agents/skills/gidd/config.toml'),'invalid user config must not be inherited');
    assert.equal(json(ok(resolve())).configured,false);
    const cases=[
      [configText(),join(repositoryRoot,'.devv')],
      ['\uFEFF'+configText(),join(repositoryRoot,'.devv')],
      [configText().replaceAll('\n','\r\n'),join(repositoryRoot,'.devv')],
      [configText('下载 # tools'),join(repositoryRoot,'下载 # tools')],
      [configText('cache/subdir').replace('"cache/subdir"',"'cache\\subdir'"),join(repositoryRoot,'cache/subdir')],
      [configText('./cache/'),join(repositoryRoot,'cache')],
      [configText(join(f.root,'external tools')),join(f.root,'external tools')],
      [configText('~/.agents/skills/gidd.tools'),join(userProfilePath,'.agents/skills/gidd.tools')],
      [configText('~/custom tools'),join(userProfilePath,'custom tools')],
      [configText('cache/subdir').replace('"cache/subdir"','"cache\\\\subdir"'),join(repositoryRoot,'cache/subdir')],
    ];
    for (const [text,expected] of cases) {
      write(path,text); const before=hash(path), result=json(ok(resolve()));
      samePath(result.tools_root,expected); assert.equal(result.configured,true); assert.equal('scope' in result,false);
      assert.equal(hash(path),before,'Reading must preserve comments and formatting');
      assert.equal(existsSync(result.tools_root),false,'Resolving must not create storage');
    }
    write(path,readFileSync(join(repo,'skills/gidd/assets/config.example.toml'),'utf8'));
    samePath(json(ok(resolve())).tools_root,join(userProfilePath,'.agents/skills/gidd.tools'));
    for (const text of ['', configText().replace('= 1','= 2'), configText().replace('schema_version','Schema_version'), configText()+'directory="other"\n', configText()+'[tools]\n', configText()+'scope="repository"\n', configText()+'unexpected=true\n', configText().replace('[tools]','[other]'), configText().replace('".devv"','true'), configText().replace('".devv"','"bad\\npath"'), configText().replace('".devv"','"""multiline"""')]) {
      write(path,text); assert.notEqual(resolve().status,0,`Must reject unsupported config: ${text}`);
    }
    for (const directory of ['.','..','../outside','/outside','a/../b','a//b','.git/data','NUL','CON.txt','trailing.','trailing ','stream:ads','C:relative','C:/','~','~/','~someone/tools','~/../outside','//server/share/tools']) {
      write(path,configText(directory)); assert.notEqual(resolve().status,0,`Unsafe path: ${directory}`);
    }
    write(path,configText('~/tools')); assert.notEqual(resolve({userProfilePath:''}).status,0);
    assert.notEqual(resolve({repositoryRoot:'',defaultDirectory:'.devv'}).status,0);
    write(path,Buffer.from([0xff,0xfe,0x01])); assert.match(resolve().stderr,/config_invalid_utf8/);
    write(path,'#'.repeat(16385)); assert.match(resolve().stderr,/config_too_large/);
    write(path,configText());
    const root=join(repositoryRoot,'.devv'), outside=join(f.root,'outside'); mkdirSync(outside);
    symlinkSync(outside,root,'junction');
    try { assert.notEqual(resolve().status,0); } finally { unlinkSync(root); }
    write(join(root,'nested/SKILL.md'),'keep'); assert.match(resolve().stderr,/tools_directory_contains_project_or_skill/);
  } finally { f.dispose(); }
});

test('configured setup reuses Node/gh without knowing a skill installation directory', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const path=join(f.root,'.agents/skills/gidd/config.toml'), tools=join(f.root,'.devv');
    write(path,configText()); const before=hash(path), exe=compile(f.root);
    stub(exe,join(tools,'node/node.exe'),undefined,true); stub(exe,join(tools,'gh/gh.exe'),undefined,true);
    const invoke=() => ps(join(code,'setup-tools.ps1'),['-RepositoryPath',f.root,'-ArchiveDirectory',join(f.root,'missing')],{env:{PATH:''}});
    const report=json(ok(invoke())); samePath(report.tools_root,tools);
    assert.deepEqual(report.tools.map(x=>x.name),['node','gh']); assert.ok(report.tools.every(x=>x.action==='reused'));
    assert.equal(existsSync(join(tools,'bun')),false); assert.equal(hash(path),before);
    assert.match(readFileSync(join(tools,'INSTALLATION.md'),'utf8'),/independent of the skill installation directory/);
    const git=findGit(); ok(run(git,['-C',f.root,'init','--quiet']));
    const diagnosis=json(ps(join(code,'doctor.ps1'),['-RepositoryPath',f.root],{env:{PATH:dirname(git)}}));
    samePath(diagnosis.checks.find(x=>x.id==='tools.storage').details.tools_root,tools);
    assert.equal(diagnosis.checks.find(x=>x.id==='runtime').details.selected,'tool.node');
    assert.equal(diagnosis.checks.find(x=>x.id==='repository.config.validation').status,'ready');
    assert.equal(diagnosis.checks.find(x=>x.id==='github.identity').status,'not_checked');
    write(path,configText('../outside')); assert.notEqual(invoke().status,0);
  } finally { f.dispose(); }
});

test('inline tool configuration validates versions and visible sources without network or writes', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const path=join(f.root,'.agents/skills/gidd/config.toml');
    const resolve=() => adapter(f.root,{action:'configuration',repositoryRoot:f.root,defaultDirectory:'.dev',userProfilePath:f.root},{env:{PATH:''}});
    const line='node = { version = "lts", source = "https://nodejs.org/dist" }';
    for (const input of [line, line+' # comment with {braces}', 'node = { source = \'https://nodejs.org/dist/\', version = \'24.20.0\' } # comment']) {
      write(path,configText()+input+'\n'); const before=hash(path);
      const storage=json(ok(resolve()));
      assert.equal(storage.tools.node.source,'https://nodejs.org/dist');
      assert.equal(storage.tools.bun.version,'latest');
      assert.equal(hash(path),before);
    }
    for (const invalid of [
      line+'\n'+line, line.replace('"lts"','"canary"'), line.replace('"lts"','"24"'),
      line.replace('"lts"','"024.1.0"'), line.replace('"lts"','"24.0.0-beta"'),
      line.replace('https:','http:'), line.replace('nodejs.org','user:secret@nodejs.org'),
      line.replace('/dist','/dist?token=secret'), line.replace('/dist','/dist#fragment'),
      line.replace('version =','Version ='), line.replace('source =','url ='),
      'node = {}', 'node = { version = "lts" }', line.replace(' }',', }'),
      line.replace(' }',', version = "latest" }'), line.replace('"lts"','true'),
      line.replace('node =','bun ='), line.replace('node =','gh ='),
    ]) {
      write(path,configText()+invalid+'\n'); assert.notEqual(resolve().status,0,invalid);
    }
    assert.equal(existsSync(join(f.root,'.devv')),false);
  } finally { f.dispose(); }
});

test('release resolution selects stable versions, verifies upstream hashes and preserves mirror paths', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const sha='a'.repeat(64), source='https://mirror.example/releases';
    const resolve=(name,version,responses={},extra={}) => adapter(f.root,{action:'release',name,version,source,pinnedPath:'',archiveDirectory:'',responses,...extra});
    const nodeIndex='https://nodejs.org/dist/index.json';
    const nodeChecks='https://nodejs.org/dist/v24.2.0/SHASUMS256.txt';
    const index=JSON.stringify([
      {version:'v26.0.0',lts:false,files:['win-x64-zip']},
      {version:'v24.1.0',lts:'Test',files:['win-x64-zip']},
      {version:'v24.2.0',lts:'Test',files:['win-x64-zip']},
      {version:'v24.3.0',lts:'Test',files:['linux-x64']},
    ]);
    const responses={[nodeIndex]:index,[nodeChecks]:sha+'  node-v24.2.0-win-x64.zip\n'};
    const node=json(ok(resolve('node','lts',responses)));
    assert.equal(node.version,'24.2.0'); assert.equal(node.sha256,sha);
    assert.equal(node.url,source+'/v24.2.0/node-v24.2.0-win-x64.zip');
    assert.equal(node.files[0].entry,'node-v24.2.0-win-x64/node.exe');
    assert.equal(json(ok(resolve('node','24.2.0',{[nodeChecks]:responses[nodeChecks]}))).version,'24.2.0');
    const latestChecks='https://nodejs.org/dist/v26.0.0/SHASUMS256.txt';
    assert.equal(json(ok(resolve('node','latest',{[nodeIndex]:index,[latestChecks]:sha+' *node-v26.0.0-win-x64.zip'}))).version,'26.0.0');
    for (const text of ['','bad hash',responses[nodeChecks]+responses[nodeChecks]]) {
      assert.match(resolve('node','lts',{...responses,[nodeChecks]:text}).stderr,/release_checksum/);
    }
    assert.notEqual(resolve('node','lts',{[nodeIndex]:'not JSON'}).status,0);
    for (const name of ['bun','gh']) {
      const version=name==='bun'?'1.4.0':'2.100.0', tag=name==='bun'?`bun-v${version}`:`v${version}`;
      const repoPath=name==='bun'?'oven-sh/bun':'cli/cli';
      const endpoint=`https://api.github.com/repos/${repoPath}/releases/latest`;
      const archive=name==='bun'?'bun-windows-x64.zip':`gh_${version}_windows_amd64.zip`;
      const checks=`https://github.com/${repoPath}/releases/download/${tag}/${name==='bun'?'SHASUMS256.txt':`gh_${version}_checksums.txt`}`;
      const release={tag_name:tag,draft:false,prerelease:false};
      const data={[endpoint]:JSON.stringify(release),[checks]:sha+'  '+archive};
      const license='Test upstream license\n';
      if (name==='bun') data[`https://raw.githubusercontent.com/oven-sh/bun/${tag}/LICENSE.md`]=license;
      const result=json(ok(resolve(name,'latest',data)));
      assert.equal(result.version,version); assert.equal(result.url,`${source}/download/${tag}/${archive}`);
      assert.equal(result.sha256,sha);
      if (name==='bun') assert.equal(result.supplements[0].sha256,createHash('sha256').update(license).digest('hex'));
      for (const bad of [{...release,prerelease:true},{...release,draft:true},{...release,tag_name:'canary'}]) {
        assert.match(resolve(name,'latest',{...data,[endpoint]:JSON.stringify(bad)}).stderr,/invalid_stable_release/);
      }
    }
    const pinned=JSON.parse(readFileSync(join(repo,'skills/gidd/assets/runtimes.json'),'utf8')).tools[0];
    const pinnedPath=join(f.root,'pinned.json'); write(pinnedPath,JSON.stringify(pinned));
    const original=hash(pinnedPath);
    const offline=json(ok(resolve('bun',pinned.version,{}, {pinnedPath,archiveDirectory:join(f.root,'missing')})));
    assert.equal(offline.sha256,pinned.sha256); assert.equal(offline.url,`${source}/download/bun-v${pinned.version}/${pinned.archive}`);
    assert.equal(hash(pinnedPath),original);
    assert.match(resolve('bun','latest',{}, {pinnedPath,archiveDirectory:join(f.root,'missing')}).stderr,/offline_release_metadata_unavailable/);
  } finally { f.dispose(); }
});
