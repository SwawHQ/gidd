import { test } from 'node:test';
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { checkIdentity, runCommand } from '../.agents/skills/gidd/scripts/github.mjs';
import { authorize } from '../.agents/skills/gidd/scripts/auth.mjs';
import { toolsRoot, adapter, assert, compile, dirname, existsSync, fixture, findGit, join, json, ok, ps, readFileSync, repo, run, snapshot, stub, write } from './support/helpers.mjs';

const options = { repository: repo, gh: join(repo, 'fixture-gh.exe'), git: findGit(), account: 'octocat' };
const success = text => ({ ok: true, reason: 'process_exit', text });
const byId = (report, id) => report.checks.find(check => check.id === id);
const githubConfig = '\n[github]\nhostname = "github.com"\naccount = "Octocat"\nremote = "origin"\n';
function scenario(overrides = {}) {
  const calls = [];
  return { calls, execute: async (exe, args, settings) => {
    calls.push({ exe, args, settings });
    const key = args[0] === 'api' ? 'api' : args[0] === 'rev-parse' ? 'repository' :
      args[0] === 'var' ? 'author' : args.includes('--get-url') ? 'remote' : 'read';
    return overrides[key] || success({ api: 'Octocat', repository: repo,
      author: 'Local Author <author@example.test> 1234567890 +0800',
      remote: 'https://github.com/owner/repo.git', read: '' }[key]);
  } };
}

test('identity separates verified API user, remote reading and effective commit author', async () => {
  const s = scenario(), report = await checkIdentity(options, s.execute);
  assert.equal(report.status, 'checks_passed');
  assert.equal(byId(report, 'github.api').details.login, 'Octocat');
  assert.equal(byId(report, 'git.author').details.email, 'author@example.test');
  assert.equal(byId(report, 'git.remote_read').status, 'ready');
  assert.equal(byId(report, 'git.authentication').status, 'not_checked');
  assert.deepEqual(s.calls[0].args, ['api', '--hostname', 'github.com', '--method', 'GET', 'user', '--jq', '.login']);
  assert.ok(s.calls.every(call => call.settings.cwd === repo));
  assert.ok(s.calls.every(call => !call.args.some(arg => ['login','switch','setup-git','push'].includes(arg))));
  const mismatch = await checkIdentity({ ...options, account: 'someone-else' }, scenario().execute);
  assert.equal(mismatch.status, 'needs_attention');
  assert.equal(byId(mismatch, 'github.api').status, 'mismatch');
  assert.equal(byId(mismatch, 'git.author').status, 'ready');
  const enterprise = scenario({ remote: success('https://gh--enterprise.example/owner/repo') });
  assert.equal((await checkIdentity({ ...options, hostname: 'gh--enterprise.example' }, enterprise.execute)).status, 'checks_passed');
  assert.equal(enterprise.calls[0].args[2], 'gh--enterprise.example');
});

test('missing dependencies and independent failures never become authentication success', async () => {
  const missing = await checkIdentity({ repository: repo }, () => assert.fail('Must not invoke missing tools'));
  assert.equal(missing.status, 'needs_attention');
  assert.equal(byId(missing, 'github.api').status, 'missing');
  assert.equal(byId(missing, 'git.author').status, 'not_checked');
  for (const key of ['api', 'repository', 'author', 'read']) {
    const s = scenario({ [key]: { ok: false, reason: 'process_timeout', text: 'ghp_PRIVATE_TOKEN' } });
    const report = await checkIdentity(options, s.execute);
    assert.equal(report.status, 'needs_attention');
    assert.ok(!JSON.stringify(report).includes('PRIVATE_TOKEN'));
    if (key !== 'repository') assert.equal(s.calls.length, 5, 'One failure must not suppress independent checks');
  }
  const invalid = await checkIdentity(options, scenario({ api: success('token=ghp_PRIVATE_TOKEN') }).execute);
  assert.equal(byId(invalid, 'github.api').reason, 'invalid_api_response');
  assert.ok(!JSON.stringify(invalid).includes('PRIVATE_TOKEN'));
});

test('only eligible HTTPS remotes are read, with no URL credentials exposed', async () => {
  for (const remote of ['git@github.com:owner/repo.git', 'https://elsewhere.test/owner/repo',
    'https://user:PRIVATE_TOKEN@github.com/owner/repo', 'https://github.com/owner/repo?PRIVATE_TOKEN',
    'http://github.com/owner/repo', 'https:github.com/owner/repo', 'https://github.com\\owner/repo', 'origin']) {
    const s = scenario({ remote: success(remote) }), report = await checkIdentity(options, s.execute);
    assert.equal(byId(report, 'git.remote_read').status, 'not_checked');
    assert.equal(report.status, 'needs_attention');
    assert.equal(s.calls.length, 4, 'Ineligible remotes must not trigger a transport request');
    assert.ok(!JSON.stringify(report).includes('PRIVATE_TOKEN'));
  }
  for (const patch of [{ repository: '.' }, { hostname: '-h' }, { hostname: 'github.com/token' },
    { account: 'bad account' }, { remote: '--upload-pack=evil' }, { gh: 'ghbw.cmd' }]) {
    await assert.rejects(checkIdentity({ ...options, ...patch }, () => assert.fail('Invalid input must not execute')));
  }
});

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

test('CLI reads real Git author and remains read-only in an isolated repository', async () => {
  const f = fixture();
  try {
    const git = findGit();
    ok(run(git, ['init', f.root]));
    ok(run(git, ['-C', f.root, 'config', 'user.name', 'Fixture Author']));
    ok(run(git, ['-C', f.root, 'config', 'user.email', 'fixture@example.test']));
    ok(run(git, ['-C', f.root, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']));
    write(join(f.root,'.agents/skills/gidd/config.toml'),'schema_version = 1\n[tools]\n' + githubConfig);
    const before = snapshot(f.root);
    const result = run(process.execPath, [join(repo, '.agents/skills/gidd/scripts/github.mjs'), '--repository', f.root, '--git', git]);
    assert.equal(result.status, 1);
    const report = json(result);
    assert.equal(byId(report, 'github.api').status, 'missing');
    assert.equal(byId(report, 'git.author').details.name, 'Fixture Author');
    assert.equal(byId(report, 'git.remote_read').reason, 'https_remote_required');
    assert.deepEqual(snapshot(f.root), before);
    const invalid = run(process.execPath, [join(repo, '.agents/skills/gidd/scripts/github.mjs'), '--repository', '.']);
    assert.equal(invalid.status, 2);
    assert.equal(json(invalid).reason, 'repository_must_be_absolute');
    // Startup errors must produce JSON and never initialize tools or config.
    write(join(f.root, '.agents/skills/gidd/config.toml'), 'invalid = true');
    const configured = snapshot(f.root);
    const bootstrap = ps(join(repo, '.agents/skills/gidd/scripts/windows/check-identity.ps1'), ['-RepositoryPath', f.root]);
    assert.equal(bootstrap.status, 2);
    assert.equal(json(bootstrap).reason, 'bootstrap_failed_run_offline_doctor');
    assert.deepEqual(snapshot(f.root), configured);
    write(join(f.root, '.agents/skills/gidd/config.toml'), 'schema_version = 1\n[tools]\n' + githubConfig);
    const valid = snapshot(f.root);
    const bootstrapped = ps(join(repo, '.agents/skills/gidd/scripts/windows/check-identity.ps1'), ['-RepositoryPath', f.root],
      { env: { PATH: [dirname(process.execPath), dirname(git)].join(';') } });
    assert.equal(bootstrapped.status, 1, bootstrapped.stdout + bootstrapped.stderr);
    assert.equal(byId(json(bootstrapped), 'github.api').reason, 'gh_unavailable');
    assert.equal(byId(json(bootstrapped), 'git.author').details.name, 'Fixture Author');
    assert.deepEqual(snapshot(f.root), valid, 'Bootstrap must only need one runtime and must not create tool directories');
  } finally { f.dispose(); }
});

test('identity subprocess deadline also covers pipes inherited by descendants', { timeout: 15000 }, async () => {
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
    for (const mode of ['success', 'plaintext', 'mismatch', 'verify-fail', 'failure', 'no-challenge', 'bad-url', 'old']) {
      // Each mode gets an independent fixture executable and login state.
      const executable = join(f.root, mode, 'gh.exe');
      mkdirSync(dirname(executable)); copyFileSync(gh, executable); write(executable + '.mode', mode);
      const events = [];
      const result = await authorize({ ...options, gh: executable, repository: f.root }, { env, timeoutMs: 2000, onEvent: event => events.push(event) });
      const expected = { success: 'authenticated', plaintext: 'authenticated', mismatch: 'authorized_account_mismatch',
        'verify-fail': 'identity_verification_failed', failure: 'command_failed', 'no-challenge': 'device_challenge_not_observed',
        'bad-url': 'unsupported_authorization_url', old: 'requires_gh_2_98_or_newer' }[mode];
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

test('authorization bootstrap skips old PATH gh and honors configured versions', { timeout: 15000 }, () => {
  const f = fixture();
  try {
    const executable = compile(f.root, 'auth-gh.cs'), oldBin = join(f.root, 'old-bin');
    const oldGh = join(oldBin, 'gh.exe'), managedGh = join(toolsRoot(f.root),'gh/gh.exe');
    stub(executable, oldGh, 'old');
    const config = join(f.root, '.agents/skills/gidd/config.toml');
    const configText = 'schema_version = 1\n[tools]\n';
    write(config, configText + githubConfig);
    const env = { PATH: [oldBin, dirname(process.execPath)].join(';'), GH_CONFIG_DIR: join(f.root, 'credentials'),
      GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '' };
    const invoke = () => ps(join(repo, '.agents/skills/gidd/scripts/windows/authorize.ps1'), ['-RepositoryPath', f.root], { env });
    assert.equal(json(invoke()).reason, 'gh_unavailable');
    assert.equal(existsSync(toolsRoot(f.root)), false, 'Missing compatible gh must not trigger installation');
    stub(executable, managedGh, 'success', true);
    write(config, configText + 'gh = { version = "2.99.0", source = "https://github.com/cli/cli/releases" }\n' + githubConfig);
    assert.equal(json(invoke()).reason, 'gh_unavailable', 'The version floor must not bypass exact configuration');
    write(config, configText + githubConfig);
    assert.equal(json(ok(invoke())).reason, 'authenticated');
    assert.equal(existsSync(managedGh + '.started'), true);
    assert.equal(existsSync(oldGh + '.started'), false);
  } finally { f.dispose(); }
});

test('dev.cmd .auth requires identity config and uses shared storage', { timeout: 15000 }, () => {
  const f = fixture();
  try {
    const checkout = join(f.root,'checkout');
    for (const path of ['dev.cmd','scripts/dev','.agents/skills/gidd/scripts']) cpSync(join(repo,path),join(checkout,path),{recursive:true});
    const compiled = compile(f.root,'auth-gh.cs');
    const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    for (const configured of [false,true]) {
      if (configured) write(join(checkout,'.agents/skills/gidd/config.toml'),`schema_version = 1\n[tools]\n` + githubConfig);
      stub(compiled,join(toolsRoot(f.root),'gh/gh.exe'),'existing',true);
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
    for (const path of ['dev.cmd','scripts/dev','.agents/skills/gidd/scripts']) cpSync(join(repo, path), join(checkout, path), { recursive: true });
    write(join(checkout, '.agents/skills/gidd/config.toml'), 'schema_version = 1\n[tools]\n' + githubConfig);
    const compiled = compile(f.root, 'auth-gh.cs'), gh = join(f.root, 'bin/gh.exe');
    mkdirSync(dirname(gh)); copyFileSync(compiled, gh); write(gh + '.mode', 'success');
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
