import { test } from 'node:test';
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
