import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { symlinkSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { configure, editConfiguration, readRemoteConfiguration, normalizeRepositoryIdentity } from '../.agents/skills/gidd/scripts.js/shared/config.mjs';
import { parseConfiguration } from '../.agents/skills/gidd/scripts.js/shared/storage.mjs';
import { prepare, toolsRoot, adapter, assert, compile, existsSync, fixture, hash, join, json, mkdirSync, ok, readFileSync, repo, snapshot, stub, write } from './support/helpers.mjs';

const configText = 'schema_version = 1\n[git]\nuser.mode = "inherit"\ncredential.mode = "inherit"\n[repo]\nremote.name = "origin"\nremote.url = "https://github.com/owner/repo"\nremote.account = "Octocat"\n';

test('repository config uses three dotted fields and rejects unsupported or conflicting structure without writes', () => {
  const f = fixture();
  try {
    const path = join(f.root, '.agents/skills/gidd/config.toml');
    write(path, configText);
    assert.deepEqual(readRemoteConfiguration(f.root, ['name','url','account']), { name: 'origin', url: 'https://github.com/owner/repo', account: 'Octocat' });
    for (const key of ['github.account','repo.hostname','repo.remote.url.account','tools.node.source','tools.gh.version','bootstrap.runtime']) {
      assert.throws(() => configure(f.root, 'set', key, 'value'), /config_unknown_key/);
      assert.equal(readFileSync(path,'utf8'), configText);
    }
    for (const table of ['github', 'github.auth', 'tools', 'tools.gh', 'bootstrap', 'custom']) {
      const text = 'schema_version = 1\n[' + table + ']\n';
      write(path, text);
      const unsupported = { message: 'config_unsupported_syntax_or_field:2' };
      assert.throws(() => parseConfiguration(text), unsupported);
      assert.equal(configure(f.root,'show').content, text);
      assert.throws(() => configure(f.root, 'set', 'repo.remote.account', 'Octocat'), unsupported);
      assert.throws(() => configure(f.root, 'clear', 'git.user.name'), unsupported);
      assert.equal(readFileSync(path,'utf8'), text);
    }
    for (const suffix of ['remote.url.account = "a"\n','remote.name = "other"\n','hostname = "github.com"\n','[repo]\n','remote.token = "secret"\n']) {
      assert.throws(() => parseConfiguration(configText + suffix), /config_/);
    }
    assert.equal(existsSync(toolsRoot(f.root)),false);
  } finally { f.dispose(); }
});

test('config editing repairs fields independently and preserves comments, BOM, line endings and locks', () => {
  const f = fixture();
  try {
    const path = join(f.root,'.agents/skills/gidd/config.toml');
    assert.throws(() => configure(f.root,'show'),/config_missing/);
    configure(f.root,'set','repo.remote.account','Octocat');
    assert.deepEqual(readRemoteConfiguration(f.root), { name:'origin',account:'Octocat' });
    assert.throws(() => readRemoteConfiguration(f.root,['url']), /config_missing_repo_remote_url/);
    configure(f.root,'set','repo.remote.url','https://GitHub.com/Owner/Repo.git/');
    assert.equal(readRemoteConfiguration(f.root).url,'https://github.com/owner/repo');
    for (const newline of ['\n','\r\n']) {
      const original='\uFEFF'+['# 保留','schema_version = 1','[git]','user.mode = "inherit"','credential.mode = "inherit"','[repo] # target',"  remote.account = 'bad account' # 注释",'remote.url = "bad url"','[spec]','current = "issue.current-worktree.direct-commit/00.auto"',''].join(newline);
      write(path,original);
      configure(f.root,'set','repo.remote.account','Octocat');
      assert.equal(readFileSync(path,'utf8'),original.replace("'bad account'",'"Octocat"'));
      configure(f.root,'set','repo.remote.name','upstream');
      configure(f.root,'set','repo.remote.url','https://github.example.test/Owner/Repo');
      const expected=original.replace("'bad account'",'"Octocat"').replace('bad url','https://github.example.test/owner/repo').replace('[spec]','remote.name = "upstream"'+newline+'[spec]');
      assert.equal(configure(f.root,'show').content,expected);
      for (const [key,value] of [['name','--bad'],['account','a b'],['url','https://u:secret@github.com/a/b'],['url','https://github.com/a/b?token=secret'],['url','https://github.com/a/..'],['url','git@github.com:a/b'],['url','https://github.com/a/b\n']]) {
        assert.throws(() => configure(f.root,'set','repo.remote.'+key,value),/config_invalid_repo_remote_/);
        assert.equal(readFileSync(path,'utf8'),expected);
      }
      write(path+'.lock','another writer');
      assert.throws(() => configure(f.root,'set','repo.remote.account','Other'),/config_locked/);
      assert.equal(readFileSync(path,'utf8'),expected); unlinkSync(path+'.lock');
    }
    const outside=join(f.root,'outside'), linked=join(f.root,'linked');mkdirSync(outside);mkdirSync(linked);
    symlinkSync(outside,join(linked,'.agents'),'junction');
    assert.throws(() => configure(linked,'set','repo.remote.account','Octocat'),/config_reparse_path/);
    assert.equal(existsSync(join(outside,'skills')),false);
    for (const bytes of [Buffer.from([255]),'#'.repeat(16385)]) {
      write(path,bytes);assert.throws(()=>configure(f.root,'show'),/config_(invalid_utf8|too_large)/);
    }
    assert.throws(() => editConfiguration('broken','repo.remote.name','origin'),/config_/);
    assert.equal(normalizeRepositoryIdentity('https://GitHub.com/OWNER/Repo/'),'https://github.com/owner/repo');
  } finally { f.dispose(); }
});

test('clear preserves other bytes and comments and is idempotent for every editable field', () => {
  const f = fixture();
  try {
    const path = join(f.root, '.agents/skills/gidd/config.toml'), before = snapshot(f.root);
    assert.equal(configure(f.root, 'clear', 'git.user.name').changed, false);
    assert.deepEqual(snapshot(f.root), before, 'Missing config must not create files or directories');
    for (const newline of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) {
      for (const value of [JSON.stringify('A # "quoted" \\ name'), "'Literal # name'", '""']) for (const comment of ['', '  # 保留行内注释']) {
        const assignment = '  user.name = ' + value + comment;
        const text = bom + ['schema_version = 1', '[git] # section', '# nearby', assignment,
          'user.email = "keep@example.test"', '[repo]', 'remote.name = "origin"', ''].join(newline);
        write(path, text);
        const result = configure(f.root, 'clear', 'git.user.name');
        assert.equal(result.action, 'clear'); assert.equal(result.key, 'git.user.name');
        assert.equal(result.changed, true); assert.equal(Object.hasOwn(result, 'value'), false);
        const expected = text.replace(assignment + newline, comment ? '  ' + comment.trimStart() + newline : '');
        assert.equal(readFileSync(path, 'utf8'), expected);
        assert.equal(Object.hasOwn(parseConfiguration(expected).git.user, 'name'), false);
        const saved = statSync(path, { bigint: true }), unchanged = snapshot(f.root);
        assert.equal(configure(f.root, 'clear', 'git.user.name').changed, false);
        assert.deepEqual(snapshot(f.root), unchanged);
        assert.equal(statSync(path, { bigint: true }).mtimeNs, saved.mtimeNs);
        assert.equal(statSync(path, { bigint: true }).ino, saved.ino);
      }
      const prefix = bom + ['schema_version = 1', '[git]', ''].join(newline);
      for (const tail of ['user.name = "last"', 'user.name = "last"' + newline]) {
        write(path, prefix + tail);
        configure(f.root, 'clear', 'git.user.name');
        assert.equal(readFileSync(path, 'utf8'), prefix);
      }
      write(path, prefix + 'user.name = "last" # last comment');
      configure(f.root, 'clear', 'git.user.name');
      assert.equal(readFileSync(path, 'utf8'), prefix + '# last comment');
    }
    write(path, 'schema_version = 1\n');
    const fields = { 'repo.remote.name': 'origin', 'repo.remote.url': 'https://github.com/owner/repo',
      'repo.remote.account': 'Octocat', 'git.user.mode': 'managed', 'git.user.name': 'Name',
      'git.user.email': 'name@example.test', 'git.credential.mode': 'gh', 'spec.current': 'issue.current-worktree.direct-commit/00.auto' };
    for (const [key, value] of Object.entries(fields)) configure(f.root, 'set', key, value);
    for (const key of Object.keys(fields)) {
      assert.equal(configure(f.root, 'clear', key).changed, true);
      assert.equal(key.split('.').reduce((object, part) => object?.[part], parseConfiguration(readFileSync(path, 'utf8'))), undefined);
    }
    assert.match(readFileSync(path, 'utf8'), /^schema_version = 1/);
    assert.equal(configure(f.root, 'show').content, readFileSync(path, 'utf8'));
  } finally { f.dispose(); }
});

test('clear rejects invalid requests, unsafe paths and broken files without changing them', () => {
  const f = fixture();
  try {
    const path = join(f.root, '.agents/skills/gidd/config.toml');
    write(path, configText);
    const before = snapshot(f.root);
    for (const key of ['', undefined, 'schema_version', 'git.user', 'git.user.mod', 'repo.remote.unknown']) {
      assert.throws(() => configure(f.root, 'clear', key), /config_unknown_key/);
    }
    assert.throws(() => configure(f.root, 'clear', 'git.user.name', ''), /config_invalid_arguments/);
    assert.deepEqual(snapshot(f.root), before);
    write(path + '.lock', 'another writer');
    assert.throws(() => configure(f.root, 'clear', 'repo.remote.name'), /config_locked/);
    assert.equal(readFileSync(path + '.lock', 'utf8'), 'another writer');
    unlinkSync(path + '.lock');
    assert.deepEqual(snapshot(f.root), before);
    for (const bytes of ['broken TOML', configText + 'remote.name = "duplicate"\n', Buffer.from([255]), '#'.repeat(16385)]) {
      write(path, bytes); const broken = snapshot(f.root);
      assert.throws(() => configure(f.root, 'clear', 'repo.remote.name'), /config_/);
      assert.deepEqual(snapshot(f.root), broken);
    }
    unlinkSync(path); mkdirSync(path);
    assert.throws(() => configure(f.root, 'clear', 'repo.remote.name'), /config_not_a_file/);
    assert.equal(existsSync(path + '.lock'), false);
    const outside = join(f.root, 'outside'), linked = join(f.root, 'linked'); mkdirSync(outside); mkdirSync(linked);
    symlinkSync(outside, join(linked, '.agents'), 'junction');
    assert.throws(() => configure(linked, 'clear', 'git.user.name'), /config_reparse_path/);
    assert.equal(existsSync(join(outside, 'skills')), false);
  } finally { f.dispose(); }
});

test('native tool policy ignores absent, malformed and hostile repository configuration', () => {
  const f=fixture();
  try {
    const path=join(f.root,'.agents/skills/gidd/config.toml');
    const resolve=()=>json(ok(adapter(f.root,{action:'configuration',repositoryRoot:f.root},{env:{PATH:''}})));
    const original=resolve();
    assert.equal(original.tools_root,join(realpathSync.native(f.root),'.agents/skills.tools/gidd'));
    assert.equal(original.tools.node.source,'https://nodejs.org/dist');
    assert.equal(original.tools.bun.source,'https://github.com/oven-sh/bun/releases');
    assert.equal(original.tools.gh.source,'https://github.com/cli/cli/releases');
    assert.equal(Object.hasOwn(original,'config_path'),false);
    for (const bytes of [configText,'broken TOML','[tools]\nnode = { source="https://untrusted.test" }',Buffer.from([255]),'#'.repeat(20000)]) {
      write(path,bytes); const before=readFileSync(path);
      assert.deepEqual(resolve(),original);assert.deepEqual(readFileSync(path),before);
    }
    unlinkSync(path);mkdirSync(path);assert.deepEqual(resolve(),original);
    assert.equal(existsSync(toolsRoot(f.root)),false);
  } finally {f.dispose();}
});

test('shared tool storage retains ownership guards while preparation ignores business configuration', {timeout:120000}, () => {
  const f=fixture();
  try {
    const path=join(f.root,'.agents/skills/gidd/config.toml'), tools=toolsRoot(f.root);
    write(path,'invalid TOML');const before=hash(path), exe=compile(f.root);
    stub(exe,join(tools,'gh/gh.exe'),undefined,true);
    const report=json(ok(prepare(f.root,'gh',{env:{PATH:''}})));
    assert.equal(realpathSync.native(report.tools_root),realpathSync.native(tools));assert.equal(hash(path),before);
    assert.ok(report.tools.every(item=>item.action==='reused'));
    write(join(tools,'nested/SKILL.md'),'keep');
    assert.match(adapter(f.root,{action:'configuration',repositoryRoot:f.root}).stderr,/tools_directory_contains_project_or_skill/);
    assert.notEqual(adapter(f.root,{action:'configuration',repositoryRoot:f.root},{env:{USERPROFILE:'relative'}}).status,0);
  } finally {f.dispose();}
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
    const pinned=JSON.parse(readFileSync(join(repo,'.agents/skills/gidd/scripts.powershell/runtimes.json'),'utf8')).tools[0];
    const pinnedPath=join(f.root,'pinned.json'); write(pinnedPath,JSON.stringify(pinned));
    const original=hash(pinnedPath);
    const verified=json(ok(resolve('bun',pinned.version,{}, {pinnedPath})));
    assert.equal(verified.sha256,pinned.sha256); assert.equal(verified.url,`${source}/download/bun-v${pinned.version}/${pinned.archive}`);
    assert.equal(hash(pinnedPath),original);
    assert.match(resolve('bun','latest',{}, {pinnedPath}).stderr,/unexpected_metadata_request/);
  } finally { f.dispose(); }
});
