import { bindFixture, prepare } from './support/helpers.mjs';
import { test } from 'node:test';
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { runCommand } from '../.agents/skills/gidd/scripts/github.mjs';
import { authorize } from '../.agents/skills/gidd/scripts/auth.mjs';
import { toolsRoot, adapter, assert, compile, dirname, existsSync, fixture, findGit, join, json, ok, ps, readFileSync, repo, run, snapshot, stub, write } from './support/helpers.mjs';

const options = { repository: repo, gh: join(repo, 'fixture-gh.exe'), git: findGit(), account: 'octocat' };
const success = text => ({ ok: true, reason: 'process_exit', text });
const githubConfig = '\n[github]\nhostname = "github.com"\naccount = "Octocat"\nremote = "origin"\n';

test('process adapter bounds hangs and output, redacts failures and isolates repository overrides', { timeout: 15000 }, async () => {
  const common = { cwd: repo, timeoutMs: 5000 };
  const result = await runCommand(process.execPath, ['-e', 'console.log(JSON.stringify({dir:process.env.GIT_DIR,prompt:process.env.GIT_TERMINAL_PROMPT,gcm:process.env.GCM_INTERACTIVE,profile:process.env.GH_CONFIG_DIR}))'],
    { ...common, env: { ...process.env, GIT_DIR: 'wrong-repository', GH_CONFIG_DIR: 'chosen-profile' } });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.text), { prompt: '0', gcm: 'never', profile: 'chosen-profile' });
  const secret = await runCommand(process.execPath, ['-e', 'console.error("ghp_PRIVATE_TOKEN");console.log("PRIVATE_TOKEN");process.exit(1)'], common);
  assert.deepEqual(secret, { ok: false, reason: 'command_failed', text: '' });
  const started = performance.now();
  assert.equal((await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...common, timeoutMs: 250 })).reason, 'process_timeout');
  assert.ok(performance.now() - started < 2500);
  assert.equal((await runCommand(process.execPath, ['-e', 'console.log("x".repeat(1100000))'], common)).reason, 'output_limit');
  assert.equal((await runCommand(join(repo, 'does-not-exist.exe'), [], common)).reason, 'process_start_failed');
});

test('GitHub subprocess deadline also covers pipes inherited by descendants', { timeout: 15000 }, async () => {
  const f = fixture(), pidFiles = [];
  try {
    const exe = compile(f.root, 'pipe-parent.cs');
    for (const delay of [0, 200]) {
      const pid = join(f.root, `${delay}.pid`); pidFiles.push(pid);
      const started = performance.now();
      const result = await runCommand(exe, [String(delay), pid], { cwd: f.root, timeoutMs: 500 });
      assert.equal(result.reason, 'process_timeout');
      assert.equal(result.text, '');
      assert.ok(performance.now() - started < 1500, 'Child-held pipes must not extend the deadline');
    }
  } finally {
    ok(adapter(f.root, { action: 'terminate-pipe-children', pids: pidFiles.filter(existsSync).map(file => Number(readFileSync(file, 'utf8'))) }));
    await new Promise(resolve => setTimeout(resolve, 100));
    f.dispose();
  }
});

test('authorization reuses verified identities, rejects mismatches and requires explicit parameters', async () => {
  for (const login of ['Octocat', 'OtherAccount']) {
    let calls = 0;
    const result = await authorize(options, { execute: async () => { calls++; return success(login); } });
    assert.equal(calls, 1, 'Existing identities must not start login or switch accounts');
    assert.equal(result.status, login === 'Octocat' ? 'ready' : 'mismatch');
    assert.equal(result.credentials_may_have_changed, false);
  }
  for (const patch of [{ account: '' }, { gh: '' }, { repository: '.' }]) {
    await assert.rejects(authorize({ ...options, ...patch }, { execute: () => assert.fail('Invalid request must not execute') }));
  }
  const token = await authorize(options, { env: { GH_TOKEN: 'PRIVATE_TOKEN' }, execute: async () => ({ ok: false, reason: 'command_failed', text: '' }) });
  assert.equal(token.reason, 'environment_token_active');
  assert.ok(!JSON.stringify(token).includes('PRIVATE_TOKEN'));
});

test('authorization streams this attempt device code, verifies account and redacts raw gh output', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const gh = compile(f.root, 'auth-gh.cs');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key)));
    env.GH_CONFIG_DIR = join(f.root, 'credentials');
    for (const mode of ['success', 'plaintext', 'mismatch', 'verify-fail', 'failure', 'no-challenge', 'bad-url']) {
      // Each mode gets an independent fixture executable and login state.
      const executable = join(f.root, mode, 'gh.exe');
      mkdirSync(dirname(executable)); copyFileSync(gh, executable); write(executable + '.mode', mode);
      const events = [];
      const result = await authorize({ ...options, gh: executable, repository: f.root }, { env, timeoutMs: 2000, onEvent: event => events.push(event) });
      const expected = { success: 'authenticated', plaintext: 'authenticated', mismatch: 'authorized_account_mismatch',
        'verify-fail': 'identity_verification_failed', failure: 'command_failed', 'no-challenge': 'device_challenge_not_observed',
        'bad-url': 'unsupported_authorization_url' }[mode];
      assert.equal(result.reason, expected, JSON.stringify(result));
      assert.ok(!JSON.stringify({ result, events }).includes('PRIVATE_TOKEN'));
      if (['old','no-challenge','bad-url'].includes(mode)) assert.equal(events.length, 0);
      else assert.deepEqual(events, [{ schema: 'gidd.auth.event/v1', type: 'authorization_required', url: 'https://github.com/login/device', code: 'ABCD-EFGH' }]);
      if (mode === 'plaintext') assert.equal(result.credential_storage, 'plaintext');
      if (mode === 'old') assert.equal(existsSync(executable + '.started'), false);
    }
  } finally { f.dispose(); }
});

test('authorization cancels or times out a pending login without marking it successful', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const gh = compile(f.root, 'auth-gh.cs'); write(gh + '.mode', 'hang');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key)));
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let events = 0;
      const started = performance.now();
      const result = await authorize({ ...options, gh, repository: f.root }, { env, timeoutMs: 300, signal: controller.signal,
        onEvent() { events++; if (cancel) setTimeout(() => controller.abort(), 20); } });
      assert.equal(events, 1);
      assert.equal(result.reason, cancel ? 'cancelled' : 'process_timeout');
      assert.equal(result.status, 'failed');
      assert.ok(performance.now() - started < 2000);
      assert.equal(existsSync(gh + '.logged'), false);
    }
  } finally { f.dispose(); }
});

test('authorization uses bindings, rejects retired gh versions and never discovers PATH tools', { timeout: 15000 }, () => {
  const f = fixture();
  try {
    const executable = compile(f.root, 'auth-gh.cs'), oldBin = join(f.root, 'old-bin');
    const oldGh = join(oldBin, 'gh.exe'), managedGh = join(toolsRoot(f.root),'gh/gh.exe');
    stub(executable, oldGh, 'old');
    const config = join(f.root, '.agents/skills/gidd/config.toml');
    const configText = 'schema_version = 1\n[tools]\n';
    write(config, configText + githubConfig);
    ok(adapter(f.root,{action:'bootstrap',repositoryRoot:f.root,responses:{},downloads:{},yes:true},{env:{PATH:dirname(process.execPath)}}));
    const env = { PATH: [oldBin, dirname(process.execPath)].join(';'), GH_CONFIG_DIR: join(f.root, 'credentials'),
      GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '' };
    const invoke = () => ps(join(repo, '.agents/skills/gidd/scripts/windows/authorize.ps1'), ['-RepositoryPath', f.root], { env });
    assert.equal(json(invoke()).reason, 'tool_bindings_missing');
    assert.equal(existsSync(join(toolsRoot(f.root),'gh')), false, 'Missing compatible gh must not trigger installation');
    stub(executable, managedGh, 'success', true);
    write(config, configText + 'gh = { version = "2.99.0", source = "https://github.com/cli/cli/releases" }\n' + githubConfig);
    assert.equal(json(invoke()).reason, 'config_retired_field:tools.gh.version');
    write(config, configText + githubConfig);
    ok(prepare(f.root,'gh',{env:{PATH:oldBin}}));
    assert.equal(json(ok(invoke())).reason, 'authenticated');
    assert.equal(existsSync(managedGh + '.started'), true);
    assert.equal(existsSync(oldGh + '.started'), false);
  } finally { f.dispose(); }
});

test('dev.cmd .auth requires identity config and uses shared storage', { timeout: 15000 }, () => {
  const f = fixture();
  try {
    const checkout = join(f.root,'checkout');
    for (const path of ['dev.cmd','dev','.agents/skills/gidd/gidd.cmd','.agents/skills/gidd/scripts','.agents/skills/gidd/references','.agents/skills/gidd/config.example.toml']) cpSync(join(repo,path),join(checkout,path),{recursive:true});
    ok(adapter(f.root,{action:'bootstrap',repositoryRoot:checkout,responses:{},downloads:{},yes:true},{env:{PATH:dirname(process.execPath)}}));
    const compiled = compile(f.root,'auth-gh.cs');
    const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    for (const configured of [false,true]) {
      if (configured) write(join(checkout,'.agents/skills/gidd/config.toml'),`schema_version = 1\n[tools]\n` + githubConfig);
      stub(compiled,join(toolsRoot(f.root),'gh/gh.exe'),'existing',true);
      bindFixture(f.root,{gh:join(toolsRoot(f.root),'gh/gh.exe')});
      const before = snapshot(checkout);
      const result = run(cmd,['/d','/s','/c',`""${join(checkout,'dev.cmd')}" .auth"`], {
        windowsVerbatimArguments:true,
        env:{PATH:dirname(process.execPath),GH_CONFIG_DIR:join(f.root,'credentials'),
          GH_TOKEN:'',GITHUB_TOKEN:'',GH_ENTERPRISE_TOKEN:'',GITHUB_ENTERPRISE_TOKEN:''},
      });
      assert.equal(result.status,configured ? 0 : 2);
      assert.equal(json(result).reason,configured ? 'already_authenticated' : 'config_missing');
      assert.deepEqual(snapshot(checkout),before);
    }
  } finally { f.dispose(); }
});

test('dev.cmd .auth dispatches real JavaScript with one runtime and never installs tools', { timeout: 15000 }, () => {
  const f = fixture();
  try {
    const checkout = join(f.root, 'repo with spaces');
    for (const path of ['dev.cmd','dev','.agents/skills/gidd/gidd.cmd','.agents/skills/gidd/scripts','.agents/skills/gidd/references','.agents/skills/gidd/config.example.toml']) cpSync(join(repo, path), join(checkout, path), { recursive: true });
    write(join(checkout, '.agents/skills/gidd/config.toml'), 'schema_version = 1\n[tools]\n' + githubConfig);
    ok(adapter(f.root,{action:'bootstrap',repositoryRoot:checkout,responses:{},downloads:{},yes:true},{env:{PATH:dirname(process.execPath)}}));
    const compiled = compile(f.root, 'auth-gh.cs'), gh = join(f.root, 'bin/gh.exe');
    mkdirSync(dirname(gh)); copyFileSync(compiled, gh); write(gh + '.mode', 'success');
    bindFixture(f.root,{gh});
    const env = { PATH: [dirname(process.execPath), dirname(gh)].join(';'), GH_CONFIG_DIR: join(f.root, 'credentials'),
      GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '' };
    const entry = join(checkout, 'dev.cmd'), cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
    const invoke = args => run(cmd, ['/d','/s','/c', `""${entry}" ${args}"`], { env, windowsVerbatimArguments: true });
    const invalid = invoke('.auth Octocat');
    assert.notEqual(invalid.status, 0); assert.equal(existsSync(gh + '.started'), false);
    const before = snapshot(checkout);
    const result = ok(invoke('.auth'));
    assert.equal(json(result).reason, 'authenticated');
    assert.deepEqual(JSON.parse(result.stderr.trim()), { schema: 'gidd.auth.event/v1', type: 'authorization_required', url: 'https://github.com/login/device', code: 'ABCD-EFGH' });
    assert.deepEqual(snapshot(checkout), before, 'Only gh credentials may change; no repository/tool writes');
  } finally { f.dispose(); }
});
