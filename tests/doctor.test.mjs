import { test } from 'node:test';
import { copyFileSync, statSync, symlinkSync } from 'node:fs';
import { doctor } from '../.agents/skills/gidd/scripts/doctor.mjs';
import { configure } from '../.agents/skills/gidd/scripts/config.mjs';
import { bindFixture, diagnosis, toolsRoot, assert, compile, dirname, existsSync, findGit, fixture, join, json, mkdirSync, ok, readFileSync, repo, rmSync, run, snapshot, stub, write } from './support/helpers.mjs';

const configText = 'schema_version = 1\n[tools]\n[github]\nhostname = "github.com"\naccount = "Octocat"\nremote = "origin"\nrepository = "https://github.com/owner/repo"\n';
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
    assert.equal(report.checks.length,12);
    assert.equal(byId(report,'config.github.repository').details.actual,'https://github.com/owner/repo');
    assert.equal(byId(report,'github.identity').details.login,'Octocat');
    assert.equal(byId(report,'git.author').details.email,'author@example.test');
    assert.equal(byId(report,'js_runtime').details.path,process.execPath);
    for (const id of ['js_runtime','git','gh']) {
      assert.equal(byId(report,id).details.gidd_managed,false,'Fixture uses tools outside its managed locations');
      assert.ok(!('source' in byId(report,id).details));
    }
    assert.ok(report.checks.every(c=>!('reason' in c)),'Success omits redundant reasons');
    assert.ok(report.checks.every(c=>c.severity === 'info'));
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
    assert.equal(byId(local,'github.identity').severity,'info');
    assert.match(local.hint,/local checks only/);

    for (const key of ['api','author','read']) {
      const s = scenario({[key]:{ok:false,reason:'process_timeout',text:'PRIVATE_TOKEN'}});
      const result = await doctor(f.root,s);
      assert.equal(result.status,'needs_attention'); assert.equal(s.calls.length,10);
      assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
      assert.equal(byId(result,key==='api'?'github.identity':key==='author'?'git.author':'git.remote_read').reason,'process_timeout');
      const failure = byId(result,key==='api'?'github.identity':key==='author'?'git.author':'git.remote_read');
      assert.equal(failure.severity,'error'); assert.ok(failure.hint);
      if (key === 'api') assert.equal(failure.commands[0].requires_user_authorization,true);
    }
    for (const [login,status] of [['OtherAccount','mismatch'],['token=PRIVATE_TOKEN','failed'],['octocat','ready']]) {
      const result=await doctor(f.root,scenario({api:success(login)}));
      assert.equal(byId(result,'github.identity').status,status);
      assert.equal(byId(result,'git.remote_read').status,'ready');
      assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
    }
    for (const url of ['git@github.com:owner/repo.git','ssh://git@github.com:22/OWNER/Repo.git/']) {
      const s=scenario({url:success(url)}), result=await doctor(f.root,s);
      assert.equal(byId(result,'config.github.remote').status,'ready');
      assert.equal(byId(result,'git.remote_read').reason,'https_remote_required');
      assert.equal(byId(result,'git.remote_read').severity,'warning');
      assert.equal(result.status,'checks_passed'); assert.ok(!s.calls.some(c=>c.key==='read'));
    }
    const renamed = scenario({url:success('https://github.com/another/project.git')});
    const changed = await doctor(f.root,renamed);
    const changedIdentity = byId(changed,'config.github.repository');
    assert.equal(changedIdentity.reason,'repository_identity_changed');
    assert.equal(changedIdentity.severity,'error'); assert.equal(changed.status,'needs_attention');
    assert.deepEqual(changedIdentity.details,{remote:'origin',
      configured:'https://github.com/owner/repo',actual:'https://github.com/another/project'});
    assert.equal(changedIdentity.commands[0].requires_configuration_review,true);
    assert.ok(!renamed.calls.some(c=>c.key==='read'),'Do not access a changed repository before configuration review');
    assert.equal(byId(changed,'git.remote_read').blocked_by,'config.github.repository');
    const anotherCommit=await doctor(f.root,scenario({head:success('b'.repeat(40))}));
    assert.equal(byId(anotherCommit,'config.github.repository').status,'ready','Commits do not change repository identity');
    const changedHost=await doctor(f.root,scenario({url:success('https://elsewhere.test/owner/repo')}));
    assert.equal(byId(changedHost,'config.github.remote').status,'ready');
    assert.equal(byId(changedHost,'config.github.hostname').reason,'remote_hostname_mismatch');
    assert.deepEqual(byId(changedHost,'config.github.hostname').details,{configured:'github.com',actual:'elsewhere.test',remote:'origin'});
    assert.equal(byId(changedHost,'config.github.repository').reason,'repository_identity_changed');
    assert.equal(byId(changedHost,'git.remote_read').blocked_by,'config.github.hostname');
    for (const url of ['https://u:PRIVATE_TOKEN@github.com/owner/repo',
      'https://github.com/owner/repo?PRIVATE_TOKEN','https:github.com/owner/repo','https://github.com\\owner/repo',
      'https://github.com/owner/../repo','https://github.com:443/owner/repo','../local',
      'https://github.com/owner/repo\nhttps://github.com/other/repo']) {
      const s=scenario({url:success(url)}), result=await doctor(f.root,s);
      assert.equal(byId(result,'config.github.remote').status,'invalid');
      assert.equal(byId(result,'git.remote_read').reason,'dependency_unavailable');
      assert.equal(byId(result,'config.github.remote').severity,'error');
      assert.equal(byId(result,'git.remote_read').severity,'info');
      assert.equal(byId(result,'git.remote_read').blocked_by,'config.github.remote');
      assert.ok(!s.calls.some(c=>c.key==='read')); assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
    }
    const broken=scenario({inside:{ok:false,reason:'command_failed',text:''}});
    const brokenReport=await doctor(f.root,broken);
    assert.equal(byId(brokenReport,'git.worktree').reason,'not_readable_worktree');
    assert.equal(byId(brokenReport,'github.identity').status,'ready');
    assert.ok(!broken.calls.some(c=>['author','url','read'].includes(c.key)));
    const unborn=await doctor(f.root,scenario({head:{ok:false,reason:'command_failed',text:''}}));
    assert.equal(byId(unborn,'git.worktree').reason,'unborn_branch');
    assert.equal(byId(unborn,'git.worktree').severity,'warning'); assert.equal(unborn.status,'checks_passed');
    assert.equal(byId(unborn,'git.author').status,'ready'); assert.equal(byId(unborn,'git.remote_read').status,'ready');
    assert.deepEqual(snapshot(f.root),before,'Diagnosis writes no configuration, tools or login state');
    const config=join(f.root,'.agents/skills/gidd/config.toml');
    for (const key of ['hostname','account','remote','repository']) {
      write(config,configText.replace(new RegExp('^'+key+' = .*\\n','m'),''));
      const s=scenario(), result=await doctor(f.root,s);
      assert.equal(byId(result,'config_file').status,'ready');
      const field=byId(result,`config.github.${key}`);
      assert.equal(field.reason,`config_missing_github_${key}`);
      assert.equal(field.severity,'error');
      const action=field.commands.find(c=>c.args[0]==='config');
      assert.deepEqual(action.args,['config','set',`github.${key}`,{hostname:'github.com',repository:'https://github.com/owner/repo'}[key] || '<value>']);
      assert.equal(s.calls.some(c=>c.key==='api'),['remote','repository'].includes(key));
      assert.equal(s.calls.some(c=>c.key==='read'),key==='account');
    }
    rmSync(config);
    const missing = byId(await doctor(f.root,scenario()),'config_file');
    assert.equal(missing.reason,'config_missing');
    assert.equal(missing.commands.length,1);
    for (const action of missing.commands) {
      assert.equal(action.executable,join(f.root,'.agents/skills/gidd/gidd.link.cmd'));
      const [, operation, key] = action.args;
      assert.deepEqual(action.required_inputs,[key]);
      configure(f.root,operation,key,{hostname:'github.com',account:'Octocat',remote:'origin'}[key.slice(7)]);
    }
    const unrecorded = byId(await doctor(f.root,scenario()),'config.github.repository');
    assert.equal(unrecorded.reason,'config_missing_github_repository');
    assert.equal(unrecorded.severity,'error');
    const [, recordAction, recordKey, recordValue] = unrecorded.commands[0].args;
    configure(f.root,recordAction,recordKey,recordValue);
    assert.equal((await doctor(f.root,scenario())).status,'checks_passed','Suggested commands resolve configuration and identity');
    write(config,'invalid TOML');
    const malformedReport=await doctor(f.root,scenario());
    const malformed = byId(malformedReport,'config_file');
    assert.equal(malformed.severity,'error'); assert.ok(!malformed.commands,'Do not overwrite malformed config through guessed commands');
    assert.match(malformed.hint,/preserving unrelated/);
    for (const key of ['remote','hostname','repository','account']) {
      const field=byId(malformedReport,`config.github.${key}`);
      assert.equal(field.status,'not_checked'); assert.equal(field.blocked_by,'config_file');
    }
    write(config,configText.replace('https://github.com/owner/repo','https://user:PRIVATE_TOKEN@github.com/owner/repo'));
    const invalidIdentity = await doctor(f.root,scenario());
    assert.equal(byId(invalidIdentity,'config_file').status,'ready');
    assert.equal(byId(invalidIdentity,'config.github.repository').reason,'config_invalid_github_repository');
    assert.equal(byId(invalidIdentity,'config.github.remote').status,'ready');
    assert.equal(byId(invalidIdentity,'config.github.hostname').status,'ready');
    assert.ok(!JSON.stringify(invalidIdentity).includes('PRIVATE_TOKEN'));
    write(config,configText.replace('hostname = "github.com"','hostname = "PRIVATE_TOKEN:bad"').replace('repository = "https://github.com/owner/repo"',''));
    for (const overrides of [{remotes:success('other')},{inside:{ok:false,reason:'command_failed',text:''}}]) {
      const result=await doctor(f.root,scenario(overrides));
      assert.equal(byId(result,'config.github.hostname').reason,'config_invalid_github_hostname');
      assert.equal(byId(result,'config.github.repository').reason,'config_missing_github_repository');
      for (const key of ['hostname','repository']) {
        assert.equal(byId(result,`config.github.${key}`).severity,'error');
        assert.equal(byId(result,`config.github.${key}`).blocked_by,'config.github.remote');
      }
      assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
    }
    write(config,configText);
    const bindingPath=join(toolsRoot(f.root),'tool-bindings.json');
    const bindings=JSON.parse(readFileSync(bindingPath,'utf8'));
    delete bindings.tools.git; write(bindingPath,JSON.stringify(bindings));
    const ghOnly=await doctor(f.root,scenario());
    assert.equal(byId(ghOnly,'git').status,'missing');
    assert.deepEqual(byId(ghOnly,'git').commands[0].args,['--repo',f.root]);
    assert.equal(byId(ghOnly,'git.worktree').blocked_by,'git');
    assert.equal(ghOnly.status,'needs_attention');
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

test('doctor offline validates real worktrees, config, authors and selected remotes without writes', {timeout:120000}, async () => {
  const worktreeConfig = configText.replace('owner/repo', 'swawhq/gidd');
  const f=fixture();
  try {
    const git=findGit(), gh=join(f.root,'bound/gh.exe'); stub(compile(f.root),gh); bindFixture(f.root,{git,gh});
    const repository=join(f.root,'repo 中文 & spaces'); mkdirSync(repository);
    const config=join(repository,'.agents/skills/gidd/config.toml');
    write(config,worktreeConfig);
    const invoke=(args,target=repository)=>ok(run(git,['-C',target,...args]));
    const diagnose=(target=repository)=>{
      const before=snapshot(f.root), output=diagnosis(target,{env:{PATH:''}}), report=json(output);
      assert.deepEqual(snapshot(f.root),before);
      assert.equal(output.status,report.status==='local_ready'?0:1);
      return report;
    };
    assert.equal(byId(diagnose(),'git.worktree').reason,'not_git_repository');
    invoke(['init','--quiet']);
    invoke(['config','user.name','Fixture']); invoke(['config','user.email','fixture@example.test']);
    assert.equal(byId(diagnose(),'git.worktree').reason,'unborn_branch');
    invoke(['-c','commit.gpgsign=false','commit','--allow-empty','--quiet','-m','fixture']);
    assert.equal(byId(diagnose(),'config.github.remote').reason,'configured_remote_missing');
    invoke(['remote','add','origin','https://github.com/SwawHQ/gidd.git']);
    invoke(['remote','add','unrelated','https://u:PRIVATE_TOKEN@elsewhere.test/private']);
    assert.equal(diagnose().status,'local_ready');
    // Only the selected fetch target is the repository identity, not pushurl.
    invoke(['remote','set-url','--push','origin','https://github.com/different/push-target.git']);
    assert.equal(byId(diagnose(),'config.github.repository').status,'ready');
    invoke(['remote','set-url','origin','https://github.com/Other/Fork.git']);
    assert.equal(byId(diagnose(),'config.github.repository').reason,'repository_identity_changed');
    assert.equal(readFileSync(config,'utf8'),worktreeConfig);
    invoke(['remote','set-url','origin','git@GITHUB.COM:SwawHQ/gidd.git']);
    assert.equal(diagnose().status,'local_ready');
    invoke(['remote','rename','origin','upstream']);
    configure(repository,'set','github.remote','upstream');
    assert.equal(byId(diagnose(),'config.github.repository').status,'ready','Use the configured remote, not hardcoded origin');
    invoke(['remote','rename','upstream','origin']);
    for (const key of ['hostname','account','remote','repository']) {
      write(config,worktreeConfig.replace(new RegExp('^'+key+' = .*\\n','m'),''));
      assert.equal(byId(diagnose(),`config.github.${key}`).reason,`config_missing_github_${key}`);
      write(config,worktreeConfig.replace(new RegExp('^'+key+' = .*','m'),key+' = "PRIVATE_TOKEN:invalid"'));
      const r=diagnose(); assert.equal(byId(r,`config.github.${key}`).reason,`config_invalid_github_${key}`);
      assert.equal(byId(r,'config_file').status,'ready');
      assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
    }
    write(config,worktreeConfig);
    for (const [url,reason] of [['https://GitHub.com/SwawHQ/gidd.git/',undefined],
      ['git@github.com:SwawHQ/gidd.git',undefined],['ssh://git@github.com:22/SwawHQ/gidd',undefined],
      ['https://elsewhere.test/SwawHQ/gidd','remote_hostname_mismatch'],
      ['https://u:PRIVATE_TOKEN@github.com/SwawHQ/gidd','unsupported_remote_url']]) {
      invoke(['remote','set-url','origin',url]);
      const r=diagnose(); assert.equal(byId(r,reason==='remote_hostname_mismatch'?'config.github.hostname':'config.github.remote').reason,reason);
      assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
    }
    invoke(['remote','set-url','origin','https://github.com/SwawHQ/gidd.git']);
    invoke(['config','--add','remote.origin.url','https://github.com/Other/Repo.git']);
    assert.equal(byId(diagnose(),'config.github.remote').reason,'remote_url_ambiguous');
    invoke(['config','--replace-all','remote.origin.url','https://github.com/SwawHQ/gidd.git']);
    // The selected URL uses Git's insteadOf expansion, not a second remote lookup.
    invoke(['config','url.https://elsewhere.test/.insteadOf','https://github.com/']);
    assert.equal(byId(diagnose(),'config.github.hostname').reason,'remote_hostname_mismatch');
    invoke(['config','--unset','url.https://elsewhere.test/.insteadOf']);
    const nested=join(repository,'nested');mkdirSync(nested);
    assert.equal(statSync(byId(diagnose(nested),'config_file').details.path,{bigint:true}).ino,statSync(config,{bigint:true}).ino);
    const fixed = await doctor(nested,{offline:true,fixedRepository:true});
    assert.equal(byId(fixed,'config_file').details.path,join(nested,'.agents/skills/gidd/config.toml'));
    assert.equal(byId(fixed,'config_file').reason,'config_missing','A bound target must not inherit parent config');
    assert.equal(byId(fixed,'git.worktree').reason,'not_git_repository');
    write(config,worktreeConfig.replace('github.com','github.example.invalid'));
    invoke(['remote','set-url','origin','ssh://git@github.example.invalid/Team/Repo.git']);
    const movedIdentity=byId(diagnose(),'config.github.repository');
    assert.equal(movedIdentity.reason,'repository_identity_changed');
    assert.equal(movedIdentity.details.actual,'https://github.example.invalid/team/repo');
    const [, action, key, value] = movedIdentity.commands[0].args;
    configure(repository,action,key,value);
    assert.equal(diagnose().status,'local_ready');
    rmSync(config);assert.equal(byId(diagnose(),'config_file').reason,'config_missing');
    mkdirSync(config);assert.equal(byId(diagnose(),'config_file').reason,'config_not_a_file');
    const bare=join(f.root,'bare.git');ok(run(git,['init','--bare','--quiet',bare]));
    assert.equal(byId(diagnose(bare),'git.worktree').reason,'not_worktree');
    const broken=join(f.root,'broken');write(join(broken,'.git'),'gitdir: nowhere\n');
    assert.equal(byId(diagnose(broken),'git.worktree').reason,'not_readable_worktree');
    assert.equal(byId(diagnose(join(f.root,'absent')),'git.worktree').reason,'directory_missing');
  } finally {f.dispose();}
});
