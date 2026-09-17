import { test } from 'node:test';
import { copyFileSync, statSync, symlinkSync } from 'node:fs';
import { doctor } from '../.agents/skills/gidd/scripts.js/doctor.mjs';
import { configure } from '../.agents/skills/gidd/scripts.js/config.mjs';
import { bindFixture, diagnosis, toolsRoot, assert, compile, dirname, existsSync, findGit, fixture, join, json, mkdirSync, ok, readFileSync, repo, rmSync, run, snapshot, stub, write } from './support/helpers.mjs';

const configText = 'schema_version = 1\n[git]\nuser.mode = "inherit"\ncredential.mode = "inherit"\n[spec]\ncurrent = "issue-direct"\n[repo]\nremote.account = "Octocat"\nremote.name = "origin"\nremote.url = "https://github.com/owner/repo"\n';
const checkOrder = [
  'tool.platform', 'tool.js_runtime', 'tool.git', 'tool.gh',
  'folder.git.worktree', 'folder.git.identity',
  'config.toml', 'config.repo.remote.name', 'config.repo.remote.url', 'config.repo.remote.account',
  'config.git.user.mode', 'config.git.user.name', 'config.git.user.email', 'config.git.credential.mode', 'config.spec.current',
  'config.repo.remote.account..online', 'config.repo.remote.url..online',
];
const byId = (report, id) => {
  const ids = report.checks.map(item => item.id);
  assert.equal(report.hint.includes('severity "error"'), report.checks.some(item => item.severity === 'error'));
  assert.equal(report.hint.includes('severity "warning"'), report.checks.some(item => item.severity === 'warning'));
  assert.equal(report.hint.includes('Online checks were not run.'), report.mode === 'offline');
  assert.deepEqual(ids, checkOrder.filter(key => ids.includes(key)), 'Stable groups and order in every diagnostic state');
  for (const item of report.checks) if (item.blocked_by) assert.ok(ids.includes(item.blocked_by), 'Blockers reference current IDs');
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
          args[0] === 'auth' ? 'token' : args[0] === 'api' ? 'api' : args[0] === 'repo' ? 'gh_repo' : args.includes('--is-inside-work-tree') ? 'inside' :
          args.includes('--show-toplevel') ? 'root' : args.includes('--verify') ? 'head' :
          args.includes('symbolic-ref') ? 'symbolic' : args.includes('GIT_AUTHOR_IDENT') ? 'author' :
          args.includes('GIT_COMMITTER_IDENT') ? 'committer' :
          args.includes('get-url') ? 'url' : args.includes('remote') ? 'remotes' : 'read';
        calls.push({key,exe,args,options});
        assert.ok([git,gh].includes(exe),'Only bound executables');
        assert.ok(!args.some(x=>['login','switch','setup-git','push','fetch'].includes(x)));
        return overrides[key] || success({git:'git version 2.55.0.windows.5',gh:'gh version 2.98.0',api:'Octocat',token:'fixture-token',
          inside:'true',root:f.root,head:'a'.repeat(40),symbolic:'refs/heads/main',
          author:'Local Author <author@example.test> 1234567890 +0800',
          committer:'Local Committer <committer@example.test> 1234567890 +0800',remotes:'origin',
          url:'https://github.com/owner/repo.git',read:'',gh_repo:JSON.stringify({url:'https://github.com/owner/repo'})}[key]);
      }};
    };
    const accountId='config.repo.remote.account..online', urlId='config.repo.remote.url..online';
    const before=snapshot(f.root), online=scenario(), report=await doctor(f.root,online);
    assert.equal(report.status,'checks_passed');assert.equal(report.checks.length,16);
    assert.deepEqual(byId(report, 'folder.git.identity').details, {
      author: { name: 'Local Author', email: 'author@example.test' },
      committer: { name: 'Local Committer', email: 'committer@example.test' },
    });
    for (const role of ['author', 'committer']) {
      for (const [response, reason] of [[success('malformed identity'), 'invalid_identity_response'],
        [{ ok: false, reason: 'command_failed', text: '' }, 'command_failed']]) {
        const failed = await doctor(f.root, { ...scenario({ [role]: response }), offline: true });
        const identity = byId(failed, 'folder.git.identity');
        assert.equal(identity.status, 'failed'); assert.equal(identity.reason, reason);
        assert.equal(failed.status, 'needs_attention');
        assert.match(identity.hint, /author and committer/);
      }
    }
    assert.deepEqual(byId(report, 'config.git.user.mode').details, { mode: 'inherit', source: 'git' });
    for (const field of ['name', 'email']) {
      assert.equal(byId(report, 'config.git.user.' + field).status, 'ready');
      assert.deepEqual(byId(report, 'config.git.user.' + field).details, { omitted: true });
    }
    assert.equal(report.folder, f.root); assert.equal(Object.hasOwn(report, 'repository'), false);
    assert.equal(report.hint, 'No errors found in local or online checks. Push permission is not checked.');
    assert.deepEqual(report.checks.filter(c=>c.id.startsWith('config.repo.remote')).map(c=>c.id),
      ['config.repo.remote.name','config.repo.remote.url','config.repo.remote.account',accountId,urlId]);
    assert.equal(byId(report,'config.repo.remote.url').details.actual,'https://github.com/owner/repo');
    assert.equal(byId(report,accountId).details.actual,'Octocat');
    const onlineUrl = byId(report,urlId);
    assert.equal(Object.hasOwn(onlineUrl, 'checks'), false);
    assert.deepEqual(onlineUrl.details.gh_remote_read, { status: 'ready' });
    assert.deepEqual(onlineUrl.details.git_remote_read, { status: 'ready' });
    const api=online.calls.find(c=>c.key==='api'), ghRepo=online.calls.find(c=>c.key==='gh_repo');
    assert.deepEqual(api.args,['api','--hostname','github.com','--method','GET','user','--jq','.login']);
    assert.deepEqual(ghRepo.args,['repo','view','https://github.com/owner/repo','--json','url']);
    assert.equal(ghRepo.options.cwd,f.root);assert.equal(ghRepo.options.timeoutMs,15000);
    const offline=scenario(), local=await doctor(f.root,{...offline,offline:true});
    assert.equal(local.status,'local_ready');assert.ok(!offline.calls.some(c=>['token','api','read','gh_repo'].includes(c.key)));
    for(const id of [accountId,urlId]) assert.equal(byId(local,id).reason,'offline');
    assert.deepEqual(snapshot(f.root),before);
    for(const key of ['api','read','gh_repo']) {
      const failed=scenario({[key]:{ok:false,reason:'process_timeout',text:'PRIVATE_TOKEN'}}), r=await doctor(f.root,failed);
      assert.equal(r.status,'needs_attention');assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
      if(key==='api') {
        assert.equal(byId(r,accountId).reason,'process_timeout');assert.equal(byId(r,accountId).commands,undefined);
        assert.equal(byId(r,urlId).details.gh_remote_read.blocked_by,accountId);
        assert.ok(!failed.calls.some(c=>c.key==='gh_repo'));
      } else assert.equal(byId(r,urlId).details[key==='read'?'git_remote_read':'gh_remote_read'].reason,'process_timeout');
    }
    for(const [login,status] of [['Other','mismatch'],['token=PRIVATE_TOKEN','failed'],['octocat','ready']]) {
      const r=await doctor(f.root,scenario({api:success(login)}));
      assert.equal(byId(r,accountId).status,status);assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
      assert.equal(byId(r,urlId).details.git_remote_read.status,'ready');
    }
    for(const text of ['bad JSON','{}','{"url":"https://github.com/other/repo"}']) {
      const r=await doctor(f.root,scenario({gh_repo:success(text)}));
      assert.equal(byId(r,urlId).status,'failed');
    }
    for(const url of ['git@github.com:owner/repo.git','ssh://git@github.com:22/OWNER/Repo.git/']) {
      const sc=scenario({url:success(url)}), r=await doctor(f.root,sc);
      assert.equal(byId(r,'config.repo.remote.url').status,'ready');
      assert.equal(byId(r,urlId).status,'not_checked');assert.equal(byId(r,urlId).reason,'online_incomplete');
      assert.equal(r.status,'checks_incomplete');
      assert.match(r.hint, /some online checks remain unverified/);
      assert.equal(byId(r,urlId).details.git_remote_read.reason,'ssh_probe_unsupported');
      assert.ok(!sc.calls.some(c=>c.key==='read'));
    }
    for(const url of ['https://github.com/other/repo','https://elsewhere.test/owner/repo']) {
      const sc=scenario({url:success(url)}), r=await doctor(f.root,sc);
      assert.equal(byId(r,'config.repo.remote.name').status,'ready');
      assert.equal(byId(r,'config.repo.remote.url').reason,'repository_address_mismatch');
      assert.equal(byId(r,urlId).blocked_by,'config.repo.remote.url');
      assert.ok(!sc.calls.some(c=>['read','gh_repo'].includes(c.key)));
    }
    for(const url of ['https://u:PRIVATE_TOKEN@github.com/owner/repo','https://github.com/owner/repo?PRIVATE_TOKEN','../local',
      'https://github.com/owner/repo\nhttps://github.com/other/repo']) {
      const r=await doctor(f.root,scenario({url:success(url)}));
      assert.equal(byId(r,'config.repo.remote.name').status,'ready');
      assert.equal(byId(r,'config.repo.remote.url').status,'invalid');assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
    }
    const config=join(f.root,'.agents/skills/gidd/config.toml');
    for(const key of ['name','url','account']) {
      write(config,configText.replace(new RegExp('^remote\\.'+key+' = .*\\n','m'),''));
      const r=await doctor(f.root,scenario());
      assert.equal(byId(r,'config.repo.remote.'+key).reason,'config_missing_repo_remote_'+key);
      assert.deepEqual(byId(r,'config.repo.remote.'+key).commands.at(-1).args, ['set', 'repo.remote.' + key, '<value>']);
      write(config,configText.replace(new RegExp('^remote\\.'+key+' = .*','m'),'remote.'+key+' = "PRIVATE_TOKEN:invalid"'));
      const invalid=await doctor(f.root,scenario());
      assert.equal(byId(invalid,'config.repo.remote.'+key).reason,'config_invalid_repo_remote_'+key);
      assert.ok(!JSON.stringify(invalid).includes('PRIVATE_TOKEN'));
    }
    write(config,configText.replace('remote.url = "https://github.com/owner/repo"','remote.url = "bad url"'));
    const independent=await doctor(f.root,scenario({remotes:success('other')}));
    assert.equal(byId(independent,'config.repo.remote.name').reason,'configured_remote_missing');
    assert.equal(byId(independent,'config.repo.remote.url').reason,'config_invalid_repo_remote_url');
    write(config,configText);
    const blocked=await doctor(f.root,scenario({remotes:success('other')}));
    assert.equal(byId(blocked,'config.repo.remote.url').blocked_by,'config.repo.remote.name');
    const broken=await doctor(f.root,scenario({inside:{ok:false,reason:'command_failed',text:''}}));
    assert.equal(byId(broken,'config.repo.remote.name').blocked_by,'folder.git.worktree');
    assert.equal(byId(broken,accountId).status,'ready');
    write(config,configText.replaceAll('github.com','github.example.test'));
    const enterprise=scenario({url:success('git@github.example.test:owner/repo.git'),gh_repo:success('{"url":"https://github.example.test/owner/repo"}')});
    assert.equal(byId(await doctor(f.root,enterprise),accountId).details.hostname,'github.example.test');
    assert.equal(enterprise.calls.find(c=>c.key==='api').args[2],'github.example.test');
    for(const text of ['invalid TOML','schema_version = 1\n[github]\n']) {
      write(config,text);const sc=scenario(), r=await doctor(f.root,sc);
      assert.equal(byId(r,'config.toml').status,'invalid');
      assert.equal(byId(r,'config.repo.remote.account').blocked_by,'config.toml');
      for (const field of ['mode', 'name', 'email']) assert.equal(byId(r, 'config.git.user.' + field).blocked_by, 'config.toml');
      assert.ok(!sc.calls.some(c=>['api','read','gh_repo'].includes(c.key)));
    }
    write(config, configText.replace('credential.mode = "inherit"\n', ''));
    assert.equal(byId(await doctor(f.root, scenario()), 'config.git.credential.mode').reason, 'config_missing_git_credential_mode');
    for (const [user, errors, blocker] of [
      ['', { mode: 'config_missing_git_user_mode' }, 'mode'],
      ['user.mode = "config"\n', { mode: 'config_invalid_git_user_mode' }, 'mode'],
      ['user.mode = "managed"\n', { name: 'config_missing_git_user_name', email: 'config_missing_git_user_email' }, 'name'],
      ['user.mode = "managed"\nuser.name = "Configured"\n', { email: 'config_missing_git_user_email' }, 'email'],
      ['user.mode = "managed"\nuser.email = "configured@example.test"\n', { name: 'config_missing_git_user_name' }, 'name'],
      ['user.mode = "managed"\nuser.name = "PRIVATE_TOKEN<name>"\nuser.email = "PRIVATE_TOKEN<email>"\n',
        { name: 'config_invalid_git_user_name', email: 'config_invalid_git_user_email' }, 'name'],
      ['user.mode = "inherit"\nuser.name = "Configured"\n', { name: 'config_git_user_inherit_conflict' }, 'name'],
      ['user.mode = "inherit"\nuser.email = "configured@example.test"\n', { email: 'config_git_user_inherit_conflict' }, 'email'],
      ['user.mode = "inherit"\nuser.name = "Configured"\nuser.email = "configured@example.test"\n',
        { name: 'config_git_user_inherit_conflict', email: 'config_git_user_inherit_conflict' }, 'name'],
    ]) {
      write(config, configText.replace('user.mode = "inherit"\n', user));
      const sc = scenario(), r = await doctor(f.root, { ...sc, offline: true });
      assert.equal(r.status, 'needs_attention');
      for (const field of ['mode', 'name', 'email']) {
        const item = byId(r, 'config.git.user.' + field);
        if (errors[field]) {
          assert.equal(item.reason, errors[field]); assert.equal(item.severity, 'error');
          assert.ok(item.hint.includes('git.user.' + field));
          if (errors[field] === 'config_git_user_inherit_conflict') {
            assert.deepEqual(item.commands[0].args, ['clear', 'git.user.' + field]);
          }
        } else if (errors.mode) {
          assert.equal(item.status, 'not_checked'); assert.equal(item.severity, 'info');
          assert.equal(item.blocked_by, 'config.git.user.mode');
        } else assert.equal(item.status, 'ready');
      }
      assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
      assert.equal(byId(r, 'folder.git.identity').status, 'not_checked');
      assert.equal(byId(r, 'folder.git.identity').blocked_by, 'config.git.user.' + blocker);
      assert.ok(!sc.calls.some(c => c.key === 'author'));
    }
    write(config, configText.replace('credential.mode = "inherit"', 'credential.mode = "gh"'));
    const noToken = scenario({ token: { ok: false, reason: 'command_failed', text: 'PRIVATE_TOKEN' } });
    const failedGh = await doctor(f.root, noToken);
    assert.equal(byId(failedGh, accountId).reason, 'account_token_unavailable');
    assert.match(byId(failedGh, accountId).hint, /gidd\.link\.cmd \.gh\.auth/);
    assert.equal(byId(failedGh, urlId).details.git_remote_read.blocked_by, accountId);
    assert.ok(!JSON.stringify(failedGh).includes('PRIVATE_TOKEN'));
    rmSync(config); const missing=await doctor(f.root,scenario());
    assert.equal(byId(missing,'config.toml').reason,'config_missing');
    assert.deepEqual(byId(missing,'config.toml').commands[0].args, ['set', 'repo.remote.account', '<value>']);
    await assert.rejects(doctor('.'),/repository_must_be_absolute/);
  } finally {f.dispose();}
});

test('doctor probes only published tools and reports minimal repair hints without fallback', {timeout:60000}, () => {
  const f=fixture();
  try {
    const exe=compile(f.root), git=findGit(), gh=join(f.root,'bound/gh.exe'), decoy=join(f.root,'path/gh.exe');
    stub(exe,gh); stub(exe,decoy,'fail');
    write(join(f.root,'.agents/skills/gidd/config.toml'),configText);
    const invoke=()=>json(diagnosis(f.root,{env:{PATH:dirname(decoy)}}));
    assert.equal(byId(invoke(),'tool.gh').reason,'tool_bindings_missing');
    bindFixture(f.root,{git,gh});
    // Unrelated runtimes and corrupt installation metadata must not enter doctor.
    write(join(toolsRoot(f.root),'bun/bun.exe'),'not executable');
    write(join(toolsRoot(f.root),'node/install.json'),'invalid');
    write(join(toolsRoot(f.root),'unrelated/SKILL.md'),'ignored');
    write(join(toolsRoot(f.root),'.cache/previous-gh/unknown'),'not a doctor concern');
    const before=snapshot(f.root), good=invoke();
    assert.equal(byId(good,'tool.gh').details.path,gh); assert.equal(byId(good,'tool.git').status,'ready');
    assert.equal(good.checks.filter(c=>['tool.js_runtime','tool.git','tool.gh'].includes(c.id)).length,3);
    assert.deepEqual(snapshot(f.root),before);
    for (const [mode,reason] of [['fail','command_failed'],['not gh','unrecognized_version'],
      ['gh version 2.97.0','version_below_minimum'],['gh version 2.99.0','tool_binding_version_changed'],['hang','process_timeout']]) {
      write(gh+'.mode',mode);
      const report=invoke();
      assert.equal(byId(report,'tool.gh').reason,reason); assert.match(byId(report,'tool.gh').hint,/gidd\.pre\.ensure/);
      assert.equal(byId(report,'tool.git').status,'ready');
    }
    rmSync(gh);
    assert.equal(byId(invoke(),'tool.gh').reason,'process_start_failed');
    const binding=join(toolsRoot(f.root),'tool-bindings.json');
    write(binding,'broken');
    assert.equal(byId(invoke(),'tool.git').reason,'tool_bindings_invalid');
    assert.equal(byId(invoke(),'tool.gh').reason,'tool_bindings_invalid');
    bindFixture(f.root,{git});
    assert.equal(byId(invoke(),'tool.git').status,'ready'); assert.equal(byId(invoke(),'tool.gh').reason,'tool_binding_missing');
    write(join(f.root,'.agents/skills/gidd/config.toml'),'invalid TOML');
    assert.equal(byId(invoke(),'tool.git').status,'ready','Broken repo config does not hide bound tools');
    const managedGh=join(toolsRoot(f.root),'gh/gh.exe'); stub(exe,managedGh);
    bindFixture(f.root,{git,gh:managedGh});
    const record=JSON.parse(readFileSync(binding,'utf8'));
    Object.assign(record.tools.gh,{source:'managed',record_sha256:'0'.repeat(64)});
    write(binding,JSON.stringify(record));
    const managed=invoke();
    assert.equal(byId(managed,'tool.gh').details.gidd_managed,true);
    assert.equal(byId(managed,'tool.git').details.gidd_managed,false);
  } finally {f.dispose();}
});

test('doctor distinguishes managed runtimes from external runtimes reached through junctions', () => {
  const f=fixture();
  try {
    const name=process.versions.bun?'bun':'node', root=toolsRoot(f.root);
    const managed=join(root,name,name+'.exe');
    mkdirSync(dirname(managed),{recursive:true}); copyFileSync(process.execPath,managed);
    const invoke=executable=>byId(json(run(executable,[join(repo,'tests/support/doctor.mjs'),f.root])),'tool.js_runtime').details;
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
    assert.equal(byId(diagnose(),'folder.git.worktree').reason,'not_git_repository');
    invoke(['init','--quiet']);
    invoke(['config','user.name','Fixture']); invoke(['config','user.email','fixture@example.test']);
    assert.equal(byId(diagnose(),'folder.git.worktree').reason,'unborn_branch');
    invoke(['-c','commit.gpgsign=false','commit','--allow-empty','--quiet','-m','fixture']);
    assert.equal(byId(diagnose(),'config.repo.remote.name').reason,'configured_remote_missing');
    invoke(['remote','add','origin','https://github.com/SwawHQ/gidd.git']);
    invoke(['remote','add','unrelated','https://u:PRIVATE_TOKEN@elsewhere.test/private']);
    assert.equal(diagnose().status,'local_ready');
    // Only the selected fetch target is the repository identity, not pushurl.
    invoke(['remote','set-url','--push','origin','https://github.com/different/push-target.git']);
    assert.equal(byId(diagnose(),'config.repo.remote.url').status,'ready');
    invoke(['remote','set-url','origin','https://github.com/Other/Fork.git']);
    assert.equal(byId(diagnose(),'config.repo.remote.url').reason,'repository_address_mismatch');
    assert.equal(readFileSync(config,'utf8'),worktreeConfig);
    invoke(['remote','set-url','origin','git@GITHUB.COM:SwawHQ/gidd.git']);
    assert.equal(diagnose().status,'local_ready');
    invoke(['remote','rename','origin','upstream']);
    configure(repository,'set','repo.remote.name','upstream');
    assert.equal(byId(diagnose(),'config.repo.remote.url').status,'ready','Use the configured remote, not hardcoded origin');
    invoke(['remote','rename','upstream','origin']);
    for (const key of ['account','name','url']) {
      write(config,worktreeConfig.replace(new RegExp('^remote\\.'+key+' = .*\\n','m'),''));
      assert.equal(byId(diagnose(),`config.repo.remote.${key}`).reason,`config_missing_repo_remote_${key}`);
      write(config,worktreeConfig.replace(new RegExp('^remote\\.'+key+' = .*','m'),'remote.'+key+' = "PRIVATE_TOKEN:invalid"'));
      const r=diagnose(); assert.equal(byId(r,`config.repo.remote.${key}`).reason,`config_invalid_repo_remote_${key}`);
      assert.equal(byId(r,'config.toml').status,'ready');
      assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
    }
    write(config,worktreeConfig);
    for (const [url,reason] of [['https://GitHub.com/SwawHQ/gidd.git/',undefined],
      ['git@github.com:SwawHQ/gidd.git',undefined],['ssh://git@github.com:22/SwawHQ/gidd',undefined],
      ['https://elsewhere.test/SwawHQ/gidd','repository_address_mismatch'],
      ['https://u:PRIVATE_TOKEN@github.com/SwawHQ/gidd','unsupported_remote_url']]) {
      invoke(['remote','set-url','origin',url]);
      const r=diagnose(); assert.equal(byId(r,'config.repo.remote.url').reason,reason);
      assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
    }
    invoke(['remote','set-url','origin','https://github.com/SwawHQ/gidd.git']);
    invoke(['config','--add','remote.origin.url','https://github.com/Other/Repo.git']);
    assert.equal(byId(diagnose(),'config.repo.remote.url').reason,'remote_url_ambiguous');
    invoke(['config','--replace-all','remote.origin.url','https://github.com/SwawHQ/gidd.git']);
    // The selected URL uses Git's insteadOf expansion, not a second remote lookup.
    invoke(['config','url.https://elsewhere.test/.insteadOf','https://github.com/']);
    assert.equal(byId(diagnose(),'config.repo.remote.url').reason,'repository_address_mismatch');
    invoke(['config','--unset','url.https://elsewhere.test/.insteadOf']);
    const nested=join(repository,'nested');mkdirSync(nested);
    assert.equal(statSync(byId(diagnose(nested),'config.toml').details.path,{bigint:true}).ino,statSync(config,{bigint:true}).ino);
    const fixed = await doctor(nested,{offline:true,fixedRepository:true});
    assert.equal(byId(fixed,'config.toml').details.path,join(nested,'.agents/skills/gidd/config.toml'));
    assert.equal(byId(fixed,'config.toml').reason,'config_missing','A bound target must not inherit parent config');
    assert.equal(byId(fixed,'folder.git.worktree').reason,'not_git_repository');
    write(config,worktreeConfig.replace('github.com','github.example.invalid'));
    invoke(['remote','set-url','origin','ssh://git@github.example.invalid/Team/Repo.git']);
    const movedIdentity=byId(diagnose(),'config.repo.remote.url');
    assert.equal(movedIdentity.reason,'repository_address_mismatch');
    assert.equal(movedIdentity.details.actual,'https://github.example.invalid/team/repo');
    configure(repository,'set','repo.remote.url',movedIdentity.details.actual);
    assert.equal(diagnose().status,'local_ready');
    rmSync(config);assert.equal(byId(diagnose(),'config.toml').reason,'config_missing');
    mkdirSync(config);assert.equal(byId(diagnose(),'config.toml').reason,'config_not_a_file');
    const bare=join(f.root,'bare.git');ok(run(git,['init','--bare','--quiet',bare]));
    assert.equal(byId(diagnose(bare),'folder.git.worktree').reason,'not_worktree');
    const broken=join(f.root,'broken');write(join(broken,'.git'),'gitdir: nowhere\n');
    assert.equal(byId(diagnose(broken),'folder.git.worktree').reason,'not_readable_worktree');
    assert.equal(byId(diagnose(join(f.root,'absent')),'folder.git.worktree').reason,'directory_missing');
  } finally {f.dispose();}
});
