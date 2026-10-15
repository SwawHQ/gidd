import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { gitConfigurationEnvironment, selectGitHubAccount } from '../.agents/skills/gidd/scripts.js/shared/execution-env.mjs';
import { runAttachedCommand } from '../.agents/skills/gidd/scripts.js/shared/attached-process.mjs';
import { noninteractiveEnvironment } from '../.agents/skills/gidd/scripts.js/shared/noninteractive.mjs';
import { assert, fixture, findGit, join, mkdirSync, write, run, ok, compile, bindFixture,
  readFileSync, repo, until, existsSync, initializeDataFixture } from './support/helpers.mjs';

const identity = { name: 'Configured 姓名', email: 'configured@example.test' };
function setup(f) {
  const git = findGit(), gh = compile(f.root, 'wrapper-gh.cs');
  bindFixture(f.root, { git, gh });
  const target = join(f.root, "仓库 ' & space"), elsewhere = join(f.root, 'elsewhere');
  mkdirSync(target); mkdirSync(elsewhere);
  ok(run(git, ['init', '--quiet', target]));
  ok(run(git, ['-C', target, 'remote', 'add', 'origin', 'https://github.com/owner/repo']));
  for (const [key, value] of [['user.name', identity.name], ['user.email', identity.email]])
    ok(run(git, ['-C', target, 'config', key, value]));
  const config = join(target, '.agents/skills/gidd/config.toml');
  const text = 'schema_version = 1\n';
  write(config, text);
  initializeDataFixture(target);
  const env = { GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '',
    GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '', GH_CONFIG_DIR: join(f.root, 'credentials') };
  // Empty identity variables have Git meaning too; remove them in the caller.
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) env[key] = undefined;
  const invoke = ([tool, ...args], options = {}) => run(tool === 'git' ? git : gh, args,
    { cwd: target, ...options, env: noninteractiveEnvironment(git, { ...process.env, ...env, ...options.env }, tool === 'git' ? args : []) });
  return { git, gh, target, elsewhere, config, text, invoke, env };
}

test('editors and AskPass fail without invoking inherited programs; stdin and pager remain usable', () => {
  const f = fixture();
  try {
    const s = setup(f), marker = join(f.root, 'unexpected-interaction'), script = join(f.root, 'interactive.cjs');
    write(script, `require('fs').writeFileSync(${JSON.stringify(marker)},'called');process.exit(0);`);
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`;
    const env = { GIT_EDITOR: command, GIT_SEQUENCE_EDITOR: command, GH_EDITOR: command,
      GIT_ASKPASS: script, SSH_ASKPASS: script, GCM_INTERACTIVE: 'true', GIT_PAGER: command };
    const failed = s.invoke(['git', '-c', 'core.editor=' + command, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty'], { env });
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /interactive editor disabled/);
    assert.equal(existsSync(marker), false);
    assert.notEqual(s.invoke(['git', 'rev-parse', '--verify', 'HEAD']).status, 0, 'No commit was made by a no-op editor');
    for (const variable of ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']) {
      assert.match(ok(s.invoke(['git', 'var', variable], { env })).stdout, /reject-interaction\.mjs/);
    }
    assert.equal(ok(s.invoke(['git', 'var', 'GIT_PAGER'], { env })).stdout.trim(), 'cat');
    const credential = s.invoke(['git', '-c', 'credential.helper=', '-c', 'core.askPass=' + script, 'credential', 'fill'],
      { input: 'protocol=https\nhost=example.invalid\n\n', env });
    assert.notEqual(credential.status, 0); assert.match(credential.stderr, /credential prompt disabled|unable to get password/);
    const askpass = s.invoke(['git', '-c', 'credential.helper=', '-c', 'credential.interactive=true', 'credential', 'fill'],
      { input: 'protocol=https\nhost=example.invalid\n\n', env });
    assert.notEqual(askpass.status, 0); assert.match(askpass.stderr, /credential prompt disabled/);
    assert.equal(existsSync(marker), false);
    const helper = '!echo "$GCM_INTERACTIVE" >&2; echo username=fixture; echo password=fixture';
    const inherited = ok(s.invoke(['git', '-c', 'credential.helper=', '-c', 'credential.helper=' + helper, 'credential', 'fill'],
      { input: 'protocol=https\nhost=example.invalid\n\n', env }));
    assert.match(inherited.stderr, /^0\r?\n/);
    ok(s.invoke(['git', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-F', '-'], { input: 'message from stdin\n', env }));
    assert.equal(ok(s.invoke(['git', 'log', '-1', '--format=%s'])).stdout.trim(), 'message from stdin');
    const sequence = s.invoke(['git', 'rebase', '-i', '--root'], { env });
    assert.notEqual(sequence.status, 0); assert.match(sequence.stderr, /interactive editor disabled/);
    assert.equal(existsSync(marker), false);
  } finally { f.dispose(); }
});

test('Windows file locks fail without asking whether to retry', async () => {
  const f = fixture();
  let locker, closed;
  try {
    const s = setup(f), locked = join(s.target, 'locked-file.txt'), marker = join(f.root, 'locked');
    write(locked, 'keep this file');
    locker = spawn(s.gh, ['lock-file', locked, marker], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    closed = new Promise((resolve, reject) => { locker.once('close', resolve); locker.once('error', reject); });
    await until(() => existsSync(marker));
    const failed = s.invoke(['git', 'clean', '-f', '--', 'locked-file.txt'], { env: { GIT_ASK_YESNO: 'must-not-run' } });
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /interactive retry disabled/);
    assert.equal(existsSync(locked), true);
  } finally {
    locker?.stdin.end();
    if (closed) await closed;
    f.dispose();
  }
});

test('SSH batch options preserve transport cwd, native command priority and arguments', () => {
  const f = fixture();
  try {
    const s = setup(f), marker = join(f.root, 'ssh-arguments.json'), script = join(f.root, 'ssh fixture.cjs');
    ok(s.invoke(['git', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']));
    const transport = join(f.root, 'unmanaged-transport');
    ok(run(s.git, ['-C', s.target, 'worktree', 'add', '--detach', transport], { env: s.env }));
    write(script, `require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));process.exit(47);`);
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`;
    for (const variant of ['ssh', 'plink', 'tortoiseplink']) {
      const result = s.invoke(['git', '-c', 'core.sshCommand=' + command, '-c', 'ssh.variant=' + variant,
        'ls-remote', 'ssh://git@example.invalid:2222/other/project.git']);
      assert.notEqual(result.status, 0);
      assert.ok(existsSync(marker), result.stderr);
      const received = JSON.parse(readFileSync(marker, 'utf8'));
      assert.ok(received.args.includes(variant === 'ssh' ? '-oBatchMode=yes' : '-batch'));
      assert.ok(received.args.includes(variant === 'ssh' ? '-p' : '-P'));
      assert.ok(received.args.includes('2222'));
      assert.ok(received.args.includes('git@example.invalid'));
    }
    const result = s.invoke(['git', '-C', transport, '-c', 'core.sshCommand=must-not-run',
      'ls-remote', 'git@example.invalid:path with spaces.git'], { env: { GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: 'ssh' } });
    assert.notEqual(result.status, 0);
    const received = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(realpathSync.native(received.cwd), realpathSync.native(transport));
    assert.ok(received.args.some(arg => arg.includes('path with spaces.git')));
    for (const variant of ['simple', 'auto']) {
      const failed = s.invoke(['git', 'ls-remote', 'git@example.invalid:repo'], { env: { GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: variant } });
      assert.notEqual(failed.status, 0); assert.match(failed.stderr, /noninteractive SSH/);
    }
    const fromEnv = s.invoke(['git', '--config-env=core.sshCommand=GIDD_TEST_SSH', '-c', 'ssh.variant=ssh',
      'ls-remote', 'git@example.invalid:repo'], { env: { GIDD_TEST_SSH: command } });
    assert.notEqual(fromEnv.status, 0);
    assert.ok(JSON.parse(readFileSync(marker, 'utf8')).args.includes('-oBatchMode=yes'));
    ok(run(s.git, ['-C', s.target, 'config', 'core.sshCommand', command]));
    ok(run(s.git, ['-C', s.target, 'config', 'ssh.variant', 'ssh']));
    const fromFile = s.invoke(['git', 'ls-remote', 'git@example.invalid:repo']);
    assert.notEqual(fromFile.status, 0);
    assert.ok(JSON.parse(readFileSync(marker, 'utf8')).args.includes('-oBatchMode=yes'));
    const nestedEnv = noninteractiveEnvironment(s.git, { GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: 'ssh' });
    const nested = s.invoke(['git', 'ls-remote', 'git@example.invalid:nested-repo'], { env: nestedEnv });
    assert.notEqual(nested.status, 0);
    assert.ok(JSON.parse(readFileSync(marker, 'utf8')).args.some(arg => arg.includes('nested-repo')));
  } finally { f.dispose(); }
});

test('noninteractive defaults are case-insensitive and reach gh editors and child Git', () => {
  const env = noninteractiveEnvironment('C:/git.exe', { gcm_interactive: 'true', gh_editor: 'unexpected', git_pager: 'less', GH_FORCE_TTY: '1' });
  assert.equal(env.gcm_interactive, undefined); assert.equal(env.GCM_INTERACTIVE, '0');
  assert.equal(env.gh_editor, undefined); assert.equal(env.GH_EDITOR, env.GIT_EDITOR);
  assert.equal(env.git_pager, undefined); assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.GH_FORCE_TTY, undefined);
  assert.match(env.GH_EDITOR, /reject-interaction\.mjs/);
  const f = fixture();
  try {
    const s = setup(f);
    const result = ok(s.invoke(['gh', 'noninteractive-environment']));
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.GH_PROMPT_DISABLED, '1'); assert.equal(actual.GCM_INTERACTIVE, '0');
    assert.equal(actual.GH_EDITOR, actual.GIT_EDITOR); assert.equal(actual.GIT_PAGER, 'cat');
  } finally { f.dispose(); }
});

test('attached process deadlines stop descendants with exit 124', async () => {
  const f = fixture();
  try {
    const marker = join(f.root, 'timed-descendant');
    const pending = runAttachedCommand(process.execPath, ['-e', `const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000)`],
      { timeoutMs: 1500, stdio: 'ignore' });
    await until(() => existsSync(marker));
    const descendant = Number(readFileSync(marker, 'utf8'));
    assert.equal(await pending, 124);
    await until(() => { try { process.kill(descendant, 0); return false; } catch { return true; } });
  } finally { f.dispose(); }
});

test('account selection isolates parallel accounts and supports Enterprise token variables', async () => {
  const f = fixture();
  try {
    const gh = compile(f.root, 'wrapper-gh.cs');
    const original = { ...process.env, GH_TOKEN: 'PRIVATE_TOKEN', GITHUB_TOKEN: 'PRIVATE_TOKEN' };
    const results = await Promise.all(['Octocat', 'Another'].map(account => selectGitHubAccount(
      { gh, hostname: 'github.example.test', account }, { env: original })));
    for (const [i, account] of ['Octocat', 'Another'].entries()) {
      assert.equal(results[i].env.GH_ENTERPRISE_TOKEN, 'fixture-' + account);
      assert.equal(results[i].env.GH_TOKEN, undefined);
      assert.equal(results[i].identity.details.actual, account);
    }
    assert.equal(original.GH_TOKEN, 'PRIVATE_TOKEN');
    const mixed = gitConfigurationEnvironment({ git_config_count: '1', git_config_key_0: 'other.key', git_config_value_0: 'retained' },
      [['credential.helper', ''], ['credential.helper', 'new']]);
    assert.equal(mixed.GIT_CONFIG_COUNT, '3'); assert.equal(mixed.GIT_CONFIG_VALUE_0, 'retained');
    assert.equal(mixed.GIT_CONFIG_VALUE_1, ''); assert.equal(mixed.GIT_CONFIG_VALUE_2, 'new');
    assert.throws(() => gitConfigurationEnvironment({ GIT_CONFIG_COUNT: '1' }, []), /git_config_environment_invalid/);
  } finally { f.dispose(); }
});

test('credential helper verifies explicitly selected accounts and supplied tokens', async () => {
  const calls = [];
  const execute = async (exe, args, options) => {
    calls.push(args);
    if (args[0] === 'auth') return { ok: true, text: 'stored-token' };
    assert.equal(options.env.GH_CONFIG_DIR, 'caller-config');
    return { ok: true, text: options.env.GH_TOKEN === 'stored-token' ? 'stored-account' : 'token-account' };
  };
  const target = { gh: 'fixture-gh', hostname: 'github.com' }, env = { GH_CONFIG_DIR: 'caller-config' };
  const native = await selectGitHubAccount(target, { env, execute });
  assert.equal(native.identity.details.actual, 'stored-account');
  assert.deepEqual(calls[0], ['auth', 'token', '--hostname', 'github.com']);
  calls.length = 0;
  const supplied = { ...env, github_token: 'supplied-token' };
  const token = await selectGitHubAccount(target, { env: supplied, execute });
  assert.equal(token.identity.details.actual, 'token-account');
  assert.equal(calls.some(args => args[0] === 'auth'), false);
  await assert.rejects(selectGitHubAccount({ ...target, account: 'stored-account' }, { env: supplied, execute }), error => {
    assert.equal(error.message, 'unexpected_account');
    assert.doesNotMatch(JSON.stringify(error), /supplied-token/);
    return true;
  });
  assert.equal(supplied.github_token, 'supplied-token');
});

test('streaming execution has no output cap and cancellation returns a nonzero status', async () => {
  const f = fixture();
  try {
    const entry = pathToFileURL(join(repo, '.agents/skills/gidd/scripts.js/shared/attached-process.mjs')).href;
    const script = `const {runAttachedCommand}=await import(${JSON.stringify(entry)});process.exitCode=await runAttachedCommand(process.execPath,['-e','process.stdin.pipe(process.stdout);process.stderr.write("stderr");process.exitCode=17']);`;
    const input = 'x'.repeat(1100000) + '\n中文\0\n';
    const output = run(process.execPath, ['--input-type=module', '-e', script], { input, maxBuffer: 2000000 });
    assert.equal(output.stdout, input); assert.equal(output.stderr, 'stderr'); assert.equal(output.status, 17);
    const marker = join(f.root, 'running');
    const controller = new AbortController();
    const pending = runAttachedCommand(process.execPath, ['-e', `const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000)`],
      { signal: controller.signal, stdio: 'ignore' });
    await until(() => { try { return Number(readFileSync(marker, 'utf8')) > 0; } catch { return false; } });
    const descendant = Number(readFileSync(marker, 'utf8'));
    controller.abort(); assert.equal(await pending, 130);
    await until(() => { try { process.kill(descendant, 0); return false; } catch { return true; } });
  } finally { f.dispose(); }
});
