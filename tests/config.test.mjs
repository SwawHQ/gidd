import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { statSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { configure, editConfiguration, editGitHub, parseGitHub, readGitHubConfiguration } from '../.agents/skills/gidd/scripts/config.mjs';
import { diagnosis as runDiagnosis, product, jsAdapter, toolsRoot, adapter as shellAdapter, assert, code, compile, existsSync, findGit, fixture, hash, join, json, mkdirSync, ok, ps, readFileSync, repo, run, stub, write } from './support/helpers.mjs';

const configText = () => `# preserved comment\nschema_version = 1\n[tools]\n`;

test('retired runtime configuration is rejected without writes; sources remain editable', () => {
  const f=fixture();
  try {
    const path=join(f.root,'.agents/skills/gidd/config.toml');
    write(path,configText());
    for(const key of ['bootstrap.runtime','tools.bun.version','tools.node.version']) {
      assert.throws(()=>configure(f.root,'set',key,'node'),/config_unknown_key/);
      assert.equal(readFileSync(path,'utf8'),configText());
    }
    for(const text of ['schema_version = 1\n[bootstrap]\nruntime="bun"\n',
      configText()+'bun = { version="latest", source="https://github.com/oven-sh/bun/releases" }\n',
      configText()+'node = { version="lts", source="https://nodejs.org/dist" }\n']) {
      write(path,text);
      assert.throws(()=>configure(f.root,'show'),/config_retired_field/);
      assert.match(shellAdapter(f.root,{action:'configuration',repositoryRoot:f.root}).stderr,/config_retired_field/);
      assert.equal(readFileSync(path,'utf8'),text);
    }
    assert.equal(existsSync(toolsRoot(f.root)),false);
  } finally {f.dispose();}
});

for (const engine of ['shell','javascript']) {
// gh metadata is JavaScript-only; native stage0 prepares Bun/Node only.
const adapter = (root, spec, options) => (engine === 'shell' && !(spec.action === 'release' && spec.name === 'gh') ? shellAdapter : jsAdapter)(root,spec,options);
test('config set edits tool fields without changing companions or installing tools', { timeout: 120000 }, () => {
  const f = fixture();
  try {
    const fresh = join(f.root,'fresh'); mkdirSync(fresh);
    assert.throws(() => configure(fresh,'set','tools.directory','.agents/skills/gidd'),/config_unknown_key/);
    assert.equal(existsSync(join(fresh,'.agents/skills/gidd/config.toml')),false);
    const path = join(f.root,'.agents/skills/gidd/config.toml');
    const original = '\uFEFF' + configText().replaceAll('\n','\r\n') +
      "  gh = { source = 'https://github.com/cli/cli/releases' , version = 'latest' } # keep gh comment\r\n" +
      '[github]\r\nhostname = "github.com"\r\naccount = "Octocat"\r\nremote = "origin"\r\n';
    write(path,original);
    configure(f.root,'set','tools.gh.version','2.98.0');
    assert.equal(readFileSync(path,'utf8'),original.replace("'latest'",'"2.98.0"'));
    assert.throws(() => configure(f.root,'set','tools.gh.source','https://mirror.example/node,a#bad'),/config_invalid_tool_source/);
    configure(f.root,'set','tools.gh.source','https://mirror.example/node,a');
    assert.match(readFileSync(path,'utf8'),/source = "https:\/\/mirror.example\/node,a" , version = "2.98.0" \} # keep gh comment/);
    for (const tool of ['bun','node']) {
      configure(f.root,'set',`tools.${tool}.source`,`https://mirror.example/${tool}`);
    }
    assert.throws(() => configure(f.root,'set','tools.directory','new tools'),/config_unknown_key/);
    assert.equal(existsSync(toolsRoot(f.root)),false);
    assert.deepEqual(readGitHubConfiguration(f.root,['account']),{hostname:'github.com',account:'Octocat',remote:'origin'});
    const before = readFileSync(path,'utf8');
    for (const [key,value] of [['tools.node.version','01.2.3'],['tools.bun.version','lts'],['tools.gh.source','http://example.test'],
      ['tools.gh.source','https://user:secret@example.test'],
      ['schema_version','2'],['tools.node.unknown','value']]) {
      assert.throws(() => configure(f.root,'set',key,value),/config_/);
      assert.equal(readFileSync(path,'utf8'),before);
      assert.equal(existsSync(path+'.lock'),false);
    }
    assert.throws(() => editConfiguration(configText()+'node = { source = "https://nodejs.org/dist", other = "x" }\n','tools.node.source','https://example.test'),/config_invalid_tool_table/);
  } finally { f.dispose(); }
});

test('GitHub config editing preserves comments, BOM, line endings and unrelated settings', () => {
  const f = fixture();
  try {
    const path = join(f.root,'.agents/skills/gidd/config.toml');
    assert.throws(() => configure(f.root,'show'),/config_missing/);
    assert.equal(existsSync(dirname(path)),false);
    assert.throws(() => configure(f.root,'set','github.token','secret'),/config_unknown_key/);
    assert.equal(existsSync(dirname(path)),false);
    configure(f.root,'set','github.account','Octocat');
    assert.deepEqual(readGitHubConfiguration(f.root,['hostname','account','remote']),{hostname:'github.com',account:'Octocat',remote:'origin'});
    for (const newline of ['\n','\r\n']) {
      const original = '\uFEFF' + ['# 顶部注释','schema_version = 1','[github] # identity',"  account = 'OldAccount' # 保留此注释",'hostname = "github.com"','[tools] # 工具段','# untouched tools comment',''].join(newline);
      write(path,original);
      configure(f.root,'set','github.account','Octocat');
      const replaced = original.replace("'OldAccount'",'"Octocat"');
      assert.equal(readFileSync(path,'utf8'),replaced);
      configure(f.root,'set','github.remote','upstream');
      const updated = readFileSync(path,'utf8');
      assert.equal(updated,replaced.replace('[tools] # 工具段',`remote = "upstream"${newline}[tools] # 工具段`));
      assert.equal(configure(f.root,'show').content,updated);
      const before = hash(path);
      for (const [key,value] of [['hostname','https://github.com'],['account','a b'],['account','Octocat\n'],['remote','--upload-pack=bad']]) {
        assert.throws(() => configure(f.root,'set',`github.${key}`,value),/config_invalid_github/);
        assert.equal(hash(path),before);
      }
      // Both bootstrap and JavaScript accept the same section order and string syntax.
      ok(adapter(f.root,{action:'configuration',repositoryRoot:f.root}));
    }
    assert.throws(() => parseGitHub('[github]\naccount="a"\naccount="b"'),/duplicate/);
    assert.throws(() => parseGitHub('[github]\n[tools]\n[github]'),/duplicate/);
    assert.throws(() => parseGitHub('[github]\ntoken="secret"'),/syntax/);
    assert.equal(parseGitHub(editGitHub('[github]\naccount="bad name"','account','Octocat')).github.account,'Octocat');
    const before = readFileSync(path,'utf8');
    write(path+'.lock','another editor');
    assert.throws(() => configure(f.root,'set','github.account','Other'),/config_locked/);
    assert.equal(readFileSync(path,'utf8'),before);
    assert.equal(readFileSync(path+'.lock','utf8'),'another editor');
    unlinkSync(path+'.lock');
    const outside = join(f.root,'outside'), linked = join(f.root,'linked'); mkdirSync(outside); mkdirSync(linked);
    symlinkSync(outside,join(linked,'.agents'),'junction');
    assert.throws(() => configure(linked,'set','github.account','Octocat'),/config_reparse_path/);
    assert.equal(existsSync(join(outside,'skills')),false);
  } finally { f.dispose(); }
});
function samePath(actual, expected) {
  while (!existsSync(expected)) {
    assert.equal(basename(actual),basename(expected)); actual=dirname(actual); expected=dirname(expected);
  }
  const a=statSync(actual,{bigint:true}), b=statSync(expected,{bigint:true});
  assert.notEqual(b.ino,0n); assert.equal(a.ino,b.ino); assert.equal(a.dev,b.dev);
}

test('configuration: fixed shared home, repository independence and read-only validation', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const repositoryRoot=join(f.root,'仓库 space'), other=join(f.root,'other repo');
    mkdirSync(repositoryRoot); mkdirSync(other);
    const path=join(repositoryRoot,'.agents/skills/gidd/config.toml'), root=toolsRoot(f.root);
    const resolve=(target=repositoryRoot,env={}) => adapter(f.root,{action:'configuration',repositoryRoot:target},{env:{PATH:'',...env}});
    samePath(json(ok(resolve())).tools_root,root);
    samePath(json(ok(resolve(other))).tools_root,root);
    assert.equal(existsSync(root),false); assert.equal(existsSync(path),false);
    write(join(f.root,'.agents/skills/gidd/config.toml'),'invalid user config must not be inherited');
    assert.equal(json(ok(resolve())).configured,false);
    for (const text of [configText(),'\uFEFF'+configText(),configText().replaceAll('\n','\r\n')]) {
      write(path,text); const before=hash(path), result=json(ok(resolve()));
      samePath(result.tools_root,root); assert.equal(result.configured,true);
      assert.equal('directory' in result,false); assert.equal('scope' in result,false);
      assert.equal(hash(path),before); assert.equal(existsSync(root),false);
    }
    write(path,readFileSync(join(repo,'.agents/skills/gidd/assets/config.example.toml'),'utf8'));
    samePath(json(ok(resolve())).tools_root,root);
    samePath(json(ok(resolve(other,{USERPROFILE:join(f.root,'separate home')}))).tools_root,toolsRoot(join(f.root,'separate home')));
    assert.notEqual(resolve(other,{USERPROFILE:'relative'}).status,0);
    for (const text of ['',configText().replace('= 1','= 2'),configText().replace('schema_version','Schema_version'),
      configText()+'directory="other"\n',configText()+'[tools]\n',configText()+'scope="repository"\n',
      configText()+'unexpected=true\n',configText().replace('[tools]','[other]')+'node="bad"\n']) {
      write(path,text); assert.notEqual(resolve().status,0,text);
    }
    write(path,Buffer.from([0xff,0xfe,0x01])); assert.match(resolve().stderr,/config_invalid_utf8/);
    write(path,'#'.repeat(16385)); assert.match(resolve().stderr,/config_too_large/);
    write(path,configText());
    const outside=join(f.root,'outside'); mkdirSync(outside); mkdirSync(dirname(root),{recursive:true});
    symlinkSync(outside,root,'junction');
    try { assert.notEqual(resolve().status,0); } finally { unlinkSync(root); }
    write(join(root,'nested/SKILL.md'),'keep'); assert.match(resolve().stderr,/tools_directory_contains_project_or_skill/);
  } finally { f.dispose(); }
});

test('configured setup reuses Node/gh without knowing a skill installation directory', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const path=join(f.root,'.agents/skills/gidd/config.toml'), tools=toolsRoot(f.root);
    write(path,configText()); const before=hash(path), exe=compile(f.root);
    stub(exe,join(tools,'node/node.exe'),undefined,true); stub(exe,join(tools,'gh/gh.exe'),undefined,true);
    const invoke=() => product(['setup','--repository',f.root],{env:{PATH:''}});
    assert.notEqual(ps(join(code,'setup-tools.ps1'),['-RepositoryPath',f.root,'-ArchiveDirectory',f.root],{env:{PATH:''}}).status,0);
    const report=json(ok(invoke())); samePath(report.tools_root,tools);
    assert.deepEqual(report.tools.map(x=>x.name),[process.versions.bun?'bun':'node','gh']); assert.ok(report.tools.every(x=>x.action==='reused'));
    assert.equal(existsSync(join(tools,'bun')),false); assert.equal(hash(path),before);
    assert.match(readFileSync(join(tools,'INSTALLATION.md'),'utf8'),/independent of the skill installation directory/);
    const git=findGit(); ok(run(git,['-C',f.root,'init','--quiet']));
    const diagnosis=json(runDiagnosis(f.root,{env:{PATH:dirname(git)}}));
    samePath(diagnosis.checks.find(x=>x.id==='tools.storage').details.tools_root,tools);
    assert.equal(diagnosis.checks.find(x=>x.id==='runtime').details.selected,process.versions.bun?'tool.bun':'tool.node');
    assert.equal(diagnosis.checks.find(x=>x.id==='repository.config.validation').status,'ready');
    assert.equal(diagnosis.checks.find(x=>x.id==='github.identity').status,'not_checked');
    write(path,configText()+'directory = "../outside"\n'); assert.notEqual(invoke().status,0);
  } finally { f.dispose(); }
});

test('inline tool configuration validates versions and visible sources without network or writes', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const path=join(f.root,'.agents/skills/gidd/config.toml');
    const resolve=() => adapter(f.root,{action:'configuration',repositoryRoot:f.root},{env:{PATH:''}});
    const line='gh = { version = "latest", source = "https://nodejs.org/dist" }';
    for (const input of [line, line+' # comment with {braces}', 'gh = { source = \'https://nodejs.org/dist/\', version = \'2.98.0\' } # comment']) {
      write(path,configText()+input+'\n'); const before=hash(path);
      const storage=json(ok(resolve()));
      assert.equal(storage.tools.gh.source,'https://nodejs.org/dist');
      assert.equal(storage.tools.bun.version,'latest');
      assert.equal(hash(path),before);
    }
    for (const invalid of [
      line+'\n'+line, line.replace('"latest"','"canary"'), line.replace('"latest"','"24"'),
      line.replace('"latest"','"024.1.0"'), line.replace('"latest"','"24.19.0-beta"'),
      line.replace('https:','http:'), line.replace('nodejs.org','user:secret@nodejs.org'),
      line.replace('/dist','/dist?token=secret'), line.replace('/dist','/dist#fragment'),
      line.replace('version =','Version ='), line.replace('source =','url ='),
      'node = {}', 'node = { version = "latest" }', line.replace(' }',', }'),
      line.replace(' }',', version = "latest" }'), line.replace('"latest"','true'),
      line.replace('gh =','bun ='), line.replace('gh =','node ='),
    ]) {
      write(path,configText()+invalid+'\n'); assert.notEqual(resolve().status,0,invalid);
    }
    assert.equal(existsSync(toolsRoot(f.root)),false);
  } finally { f.dispose(); }
});

test('release resolution selects stable versions, verifies upstream hashes and preserves mirror paths', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const sha='a'.repeat(64), source='https://mirror.example/releases';
    const resolve=(name,version,responses={},extra={}) => adapter(f.root,{action:'release',name,version,source,pinnedPath:'',responses,...extra});
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
    const pinned=JSON.parse(readFileSync(join(repo,'.agents/skills/gidd/assets/runtimes.json'),'utf8')).tools[0];
    const pinnedPath=join(f.root,'pinned.json'); write(pinnedPath,JSON.stringify(pinned));
    const original=hash(pinnedPath);
    const verified=json(ok(resolve('bun',pinned.version,{}, {pinnedPath})));
    assert.equal(verified.sha256,pinned.sha256); assert.equal(verified.url,`${source}/download/bun-v${pinned.version}/${pinned.archive}`);
    assert.equal(hash(pinnedPath),original);
    assert.match(resolve('bun','latest',{}, {pinnedPath}).stderr,/unexpected_metadata_request/);
  } finally { f.dispose(); }
});

}
