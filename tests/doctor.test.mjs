import { test } from 'node:test';
import { copyFileSync, statSync, symlinkSync } from 'node:fs';
import { doctor } from '../.agents/skills/gidd/scripts/doctor.mjs';
import { bindFixture, diagnosis, toolsRoot, assert, compile, dirname, existsSync, findGit, fixture, join, json, mkdirSync, ok, readFileSync, repo, rmSync, run, snapshot, stub, write } from './support/helpers.mjs';

const configText = 'schema_version = 1\n[tools]\n[github]\nhostname = "github.com"\naccount = "Octocat"\nremote = "origin"\n';
const byId = (report, id) => {
  const matches = report.checks.filter(item => item.id === id);
  assert.equal(matches.length, 1, id);
  return matches[0];
};
const success = text => ({ ok: true, reason: 'process_exit', text });

test('doctor combines independent checks once; offline never invokes network or authentication', async () => {
  const f = fixture();
  try {
    write(join(f.root,'.agents/skills/gidd/config.toml'),configText);
    mkdirSync(join(f.root,'.git'));
    const git = join(f.root,'bound/git.exe'), gh = join(f.root,'bound/gh.exe');
    write(join(toolsRoot(f.root),'tool-bindings.json'),JSON.stringify({
      schema:'gidd.tool-bindings/v1',platform:'windows-x64',
      tools:{git:{path:git,source:'path',version:'2.55.0'},gh:{path:gh,source:'path',version:'2.98.0'}},
    }));
    const scenario = (overrides = {}) => {
      const calls = [];
      return { calls, execute: async (exe, args, options) => {
        const key = args[0] === '--version' ? exe === git ? 'git' : 'gh' :
          args[0] === 'api' ? 'api' : args.includes('--is-inside-work-tree') ? 'inside' :
          args.includes('--show-toplevel') ? 'root' : args.includes('--verify') ? 'head' :
          args.includes('symbolic-ref') ? 'symbolic' : args.includes('var') ? 'author' :
          args.includes('get-url') ? 'url' : args.includes('remote') ? 'remotes' : 'read';
        calls.push({key,exe,args,options});
        assert.ok([git,gh].includes(exe),'Only bound executables');
        assert.ok(!args.some(x=>['login','switch','setup-git','push','fetch'].includes(x)));
        return overrides[key] || success({git:'git version 2.55.0.windows.5',gh:'gh version 2.98.0',api:'Octocat',
          inside:'true',root:f.root,head:'a'.repeat(40),symbolic:'refs/heads/main',
          author:'Local Author <author@example.test> 1234567890 +0800',remotes:'origin',
          url:'https://github.com/owner/repo.git',read:''}[key]);
      }};
    };
    const before = snapshot(f.root);
    const online = scenario(), report = await doctor(f.root,online);
    assert.equal(report.schema,'gidd.doctor/v1'); assert.equal(report.mode,'online'); assert.equal(report.status,'checks_passed');
    assert.equal(report.checks.length,9);
    assert.equal(byId(report,'github.identity').details.login,'Octocat');
    assert.equal(byId(report,'git.author').details.email,'author@example.test');
    assert.equal(byId(report,'js_runtime').details.path,process.execPath);
    for (const id of ['js_runtime','git','gh']) {
      assert.equal(byId(report,id).details.gidd_managed,false,'Fixture uses tools outside its managed locations');
      assert.ok(!('source' in byId(report,id).details));
    }
    assert.ok(report.checks.every(c=>!('reason' in c)),'Success omits redundant reasons');
    assert.equal(online.calls.length,10);
    assert.equal(new Set(online.calls.map(c=>c.key)).size,10,'No duplicate checks');
    const api = online.calls.find(c=>c.key==='api'), read = online.calls.find(c=>c.key==='read');
    assert.deepEqual(api.args,['api','--hostname','github.com','--method','GET','user','--jq','.login']);
    assert.deepEqual(read.args,['-C',f.root,'-c','credential.interactive=false','-c','core.askPass=','ls-remote','--','origin','HEAD']);
    assert.ok(api.options.env.PATH.startsWith(dirname(git)));
    assert.equal(api.options.timeoutMs,15000); assert.equal(read.options.timeoutMs,15000);
    const offline = scenario(), local = await doctor(f.root,{...offline,offline:true});
    assert.equal(local.status,'local_ready'); assert.equal(local.mode,'offline');
    assert.ok(offline.calls.every(c=>!['api','read'].includes(c.key)));
    assert.equal(byId(local,'github.identity').reason,'offline'); assert.equal(byId(local,'git.remote_read').reason,'offline');

    for (const key of ['api','author','read']) {
      const s = scenario({[key]:{ok:false,reason:'process_timeout',text:'PRIVATE_TOKEN'}});
      const result = await doctor(f.root,s);
      assert.equal(result.status,'needs_attention'); assert.equal(s.calls.length,10);
      assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
      assert.equal(byId(result,key==='api'?'github.identity':key==='author'?'git.author':'git.remote_read').reason,'process_timeout');
    }
    for (const [login,status] of [['OtherAccount','mismatch'],['token=PRIVATE_TOKEN','failed'],['octocat','ready']]) {
      const result=await doctor(f.root,scenario({api:success(login)}));
      assert.equal(byId(result,'github.identity').status,status);
      assert.equal(byId(result,'git.remote_read').status,'ready');
      assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
    }
    for (const url of ['git@github.com:owner/repo.git','ssh://git@github.com:22/owner/repo']) {
      const s=scenario({url:success(url)}), result=await doctor(f.root,s);
      assert.equal(byId(result,'repository.remote').status,'ready');
      assert.equal(byId(result,'git.remote_read').reason,'https_remote_required');
      assert.equal(result.status,'needs_attention'); assert.ok(!s.calls.some(c=>c.key==='read'));
    }
    for (const url of ['https://elsewhere.test/owner/repo','https://u:PRIVATE_TOKEN@github.com/owner/repo',
      'https://github.com/owner/repo?PRIVATE_TOKEN','https:github.com/owner/repo','https://github.com\\owner/repo',
      'https://github.com/owner/../repo','https://github.com:443/owner/repo','../local',
      'https://github.com/owner/repo\nhttps://github.com/other/repo']) {
      const s=scenario({url:success(url)}), result=await doctor(f.root,s);
      assert.equal(byId(result,'repository.remote').status,'invalid');
      assert.equal(byId(result,'git.remote_read').reason,'remote_unavailable');
      assert.ok(!s.calls.some(c=>c.key==='read')); assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
    }
    const broken=scenario({inside:{ok:false,reason:'command_failed',text:''}});
    const brokenReport=await doctor(f.root,broken);
    assert.equal(byId(brokenReport,'repository').reason,'not_readable_worktree');
    assert.equal(byId(brokenReport,'github.identity').status,'ready');
    assert.ok(!broken.calls.some(c=>['author','url','read'].includes(c.key)));
    const unborn=await doctor(f.root,scenario({head:{ok:false,reason:'command_failed',text:''}}));
    assert.equal(byId(unborn,'repository').reason,'unborn_branch');
    assert.equal(byId(unborn,'git.author').status,'ready'); assert.equal(byId(unborn,'git.remote_read').status,'ready');
    assert.deepEqual(snapshot(f.root),before,'Diagnosis writes no configuration, tools or login state');
    const config=join(f.root,'.agents/skills/gidd/config.toml');
    for (const key of ['hostname','account','remote']) {
      write(config,configText.replace(new RegExp('^'+key+' = .*\\n','m'),''));
      const s=scenario(), result=await doctor(f.root,s);
      assert.deepEqual(byId(result,'config').details.missing_fields,[key]);
      assert.equal(s.calls.some(c=>c.key==='api'),key==='remote');
      assert.equal(s.calls.some(c=>c.key==='read'),key==='account');
    }
    write(config,configText);
    const bindingPath=join(toolsRoot(f.root),'tool-bindings.json');
    const bindings=JSON.parse(readFileSync(bindingPath,'utf8'));
    delete bindings.tools.git; write(bindingPath,JSON.stringify(bindings));
    const ghOnly=await doctor(f.root,scenario());
    assert.equal(byId(ghOnly,'git').status,'missing');
    assert.equal(byId(ghOnly,'github.identity').status,'ready');
    assert.equal(byId(ghOnly,'git.remote_read').status,'not_checked');
    await assert.rejects(doctor('.'),/repository_must_be_absolute/);
  } finally { f.dispose(); }
});

test('doctor probes only published tools and reports minimal repair hints without fallback', {timeout:60000}, () => {
  const f=fixture();
  try {
    const exe=compile(f.root), git=findGit(), gh=join(f.root,'bound/gh.exe'), decoy=join(f.root,'path/gh.exe');
    stub(exe,gh); stub(exe,decoy,'fail');
    write(join(f.root,'.agents/skills/gidd/config.toml'),configText);
    const invoke=()=>json(diagnosis(f.root,{env:{PATH:dirname(decoy)}}));
    assert.equal(byId(invoke(),'gh').reason,'tool_bindings_missing');
    bindFixture(f.root,{git,gh});
    // Unrelated runtimes and corrupt installation metadata must not enter doctor.
    write(join(toolsRoot(f.root),'bun/bun.exe'),'not executable');
    write(join(toolsRoot(f.root),'node/install.json'),'invalid');
    write(join(toolsRoot(f.root),'unrelated/SKILL.md'),'ignored');
    write(join(toolsRoot(f.root),'.cache/previous-gh/unknown'),'not a doctor concern');
    const before=snapshot(f.root), good=invoke();
    assert.equal(byId(good,'gh').details.path,gh); assert.equal(byId(good,'git').status,'ready');
    assert.equal(good.checks.filter(c=>['js_runtime','git','gh'].includes(c.id)).length,3);
    assert.deepEqual(snapshot(f.root),before);
    for (const [mode,reason] of [['fail','command_failed'],['not gh','unrecognized_version'],
      ['gh version 2.97.0','version_below_minimum'],['gh version 2.99.0','tool_binding_version_changed'],['hang','process_timeout']]) {
      write(gh+'.mode',mode);
      const report=invoke();
      assert.equal(byId(report,'gh').reason,reason); assert.match(byId(report,'gh').hint,/gidd\.pre\.ensure/);
      assert.equal(byId(report,'git').status,'ready');
    }
    rmSync(gh);
    assert.equal(byId(invoke(),'gh').reason,'process_start_failed');
    const binding=join(toolsRoot(f.root),'tool-bindings.json');
    write(binding,'broken');
    assert.equal(byId(invoke(),'git').reason,'tool_bindings_invalid');
    assert.equal(byId(invoke(),'gh').reason,'tool_bindings_invalid');
    bindFixture(f.root,{git});
    assert.equal(byId(invoke(),'git').status,'ready'); assert.equal(byId(invoke(),'gh').reason,'tool_binding_missing');
    write(join(f.root,'.agents/skills/gidd/config.toml'),'invalid TOML');
    assert.equal(byId(invoke(),'git').status,'ready','Broken repo config does not hide bound tools');
    const managedGh=join(toolsRoot(f.root),'gh/gh.exe'); stub(exe,managedGh);
    bindFixture(f.root,{git,gh:managedGh});
    const record=JSON.parse(readFileSync(binding,'utf8'));
    Object.assign(record.tools.gh,{source:'managed',record_sha256:'0'.repeat(64)});
    write(binding,JSON.stringify(record));
    const managed=invoke();
    assert.equal(byId(managed,'gh').details.gidd_managed,true);
    assert.equal(byId(managed,'git').details.gidd_managed,false);
  } finally {f.dispose();}
});

test('doctor distinguishes managed runtimes from external runtimes reached through junctions', () => {
  const f=fixture();
  try {
    const name=process.versions.bun?'bun':'node', root=toolsRoot(f.root);
    const managed=join(root,name,name+'.exe');
    mkdirSync(dirname(managed),{recursive:true}); copyFileSync(process.execPath,managed);
    const invoke=executable=>byId(json(run(executable,[join(repo,'.agents/skills/gidd/scripts/gidd.mjs'),
      'doctor','--offline','--repository',f.root])),'js_runtime').details;
    assert.equal(invoke(managed).gidd_managed,true);
    const alias=join(root,'.runtime-path-fixture');
    symlinkSync(dirname(process.execPath),alias,'junction');
    assert.equal(invoke(join(alias,name+'.exe')).gidd_managed,false);
    // Even the expected directory name must not disguise an external target.
    rmSync(managed); rmSync(dirname(managed),{recursive:true});
    symlinkSync(dirname(process.execPath),dirname(managed),'junction');
    assert.equal(invoke(managed).gidd_managed,false);
  } finally {f.dispose();}
});

test('doctor offline validates real worktrees, config, authors and selected remotes without writes', {timeout:120000}, () => {
  const f=fixture();
  try {
    const git=findGit(), gh=join(f.root,'bound/gh.exe'); stub(compile(f.root),gh); bindFixture(f.root,{git,gh});
    const repository=join(f.root,'repo 中文 & spaces'); mkdirSync(repository);
    const config=join(repository,'.agents/skills/gidd/config.toml');
    write(config,configText);
    const invoke=(args,target=repository)=>ok(run(git,['-C',target,...args]));
    const diagnose=(target=repository)=>{
      const before=snapshot(f.root), output=diagnosis(target,{env:{PATH:''}}), report=json(output);
      assert.deepEqual(snapshot(f.root),before);
      assert.equal(output.status,report.status==='local_ready'?0:1);
      return report;
    };
    assert.equal(byId(diagnose(),'repository').reason,'not_git_repository');
    invoke(['init','--quiet']);
    invoke(['config','user.name','Fixture']); invoke(['config','user.email','fixture@example.test']);
    assert.equal(byId(diagnose(),'repository').reason,'unborn_branch');
    invoke(['-c','commit.gpgsign=false','commit','--allow-empty','--quiet','-m','fixture']);
    assert.equal(byId(diagnose(),'repository.remote').reason,'configured_remote_missing');
    invoke(['remote','add','origin','https://github.com/SwawHQ/gidd.git']);
    invoke(['remote','add','unrelated','https://u:PRIVATE_TOKEN@elsewhere.test/private']);
    assert.equal(diagnose().status,'local_ready');
    for (const key of ['hostname','account','remote']) {
      write(config,configText.replace(new RegExp('^'+key+' = .*\\n','m'),''));
      assert.deepEqual(byId(diagnose(),'config').details.missing_fields,[key]);
      write(config,configText.replace(new RegExp('^'+key+' = .*','m'),key+' = "PRIVATE_TOKEN:invalid"'));
      const r=diagnose(); assert.deepEqual(byId(r,'config').details.invalid_fields,[key]);
      assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
    }
    write(config,configText);
    for (const [url,reason] of [['https://GitHub.com/SwawHQ/gidd.git/',undefined],
      ['git@github.com:SwawHQ/gidd.git',undefined],['ssh://git@github.com:22/SwawHQ/gidd',undefined],
      ['https://elsewhere.test/SwawHQ/gidd','remote_hostname_mismatch'],
      ['https://u:PRIVATE_TOKEN@github.com/SwawHQ/gidd','unsupported_remote_url']]) {
      invoke(['remote','set-url','origin',url]);
      const r=diagnose(); assert.equal(byId(r,'repository.remote').reason,reason);
      assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
    }
    invoke(['remote','set-url','origin','https://github.com/SwawHQ/gidd.git']);
    invoke(['config','--add','remote.origin.url','https://github.com/Other/Repo.git']);
    assert.equal(byId(diagnose(),'repository.remote').reason,'remote_url_ambiguous');
    invoke(['config','--replace-all','remote.origin.url','https://github.com/SwawHQ/gidd.git']);
    // The selected URL uses Git's insteadOf expansion, not a second remote lookup.
    invoke(['config','url.https://elsewhere.test/.insteadOf','https://github.com/']);
    assert.equal(byId(diagnose(),'repository.remote').reason,'remote_hostname_mismatch');
    invoke(['config','--unset','url.https://elsewhere.test/.insteadOf']);
    const nested=join(repository,'nested');mkdirSync(nested);
    assert.equal(statSync(byId(diagnose(nested),'config').details.path,{bigint:true}).ino,statSync(config,{bigint:true}).ino);
    write(config,configText.replace('github.com','github.example.invalid'));
    invoke(['remote','set-url','origin','ssh://git@github.example.invalid/Team/Repo.git']);
    assert.equal(diagnose().status,'local_ready');
    rmSync(config);assert.equal(byId(diagnose(),'config').reason,'config_missing');
    mkdirSync(config);assert.equal(byId(diagnose(),'config').reason,'config_not_a_file');
    const bare=join(f.root,'bare.git');ok(run(git,['init','--bare','--quiet',bare]));
    assert.equal(byId(diagnose(bare),'repository').reason,'not_worktree');
    const broken=join(f.root,'broken');write(join(broken,'.git'),'gitdir: nowhere\n');
    assert.equal(byId(diagnose(broken),'repository').reason,'not_readable_worktree');
    assert.equal(byId(diagnose(join(f.root,'absent')),'repository').reason,'directory_missing');
  } finally {f.dispose();}
});
