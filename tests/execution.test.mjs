import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { configure, readConfiguration } from '../.agents/skills/gidd/scripts.js/config.mjs';
import { validateGitSettings } from '../.agents/skills/gidd/scripts.js/git-settings.mjs';
import { gitConfigurationEnvironment, selectGitHubAccount } from '../.agents/skills/gidd/scripts.js/execution-env.mjs';
import { runPassthrough } from '../.agents/skills/gidd/scripts.js/passthrough.mjs';
import { publishRepositoryEntry, runRepositoryCommand } from './support/repository.mjs';
import { assert, fixture, findGit, join, mkdirSync, write, run, ok, compile, bindFixture, copySkill, adapter,
  dirname, readFileSync, repo, until } from './support/helpers.mjs';

const code = pathToFileURL(join(repo, '.agents/skills/gidd/scripts.js/gidd.mjs')).href;
const driver = `const {main}=await import(${JSON.stringify(code)});process.exitCode=await main(JSON.parse(process.argv[1]),{boundRepository:process.argv[2]});`;
const settings = { user: { name: 'Configured 姓名', email: 'configured@example.test' }, credential: { mode: 'gh' } };
function setup(f) {
  const git = findGit(), gh = compile(f.root, 'wrapper-gh.cs');
  bindFixture(f.root, { git, gh });
  const target = join(f.root, "仓库 ' & space"), elsewhere = join(f.root, 'elsewhere');
  mkdirSync(target); mkdirSync(elsewhere);
  ok(run(git, ['init', '--quiet', target]));
  const config = join(target, '.agents/skills/gidd/config.toml');
  const text = 'schema_version = 1\n[repo]\nremote.url = "https://github.com/owner/repo"\nremote.account = "Octocat"\n' +
    '[git]\nuser.name = "Configured 姓名"\nuser.email = "configured@example.test"\ncredential.mode = "gh"\n';
  write(config, text);
  const env = { GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '',
    GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '', GH_CONFIG_DIR: join(f.root, 'credentials') };
  // Empty identity variables have Git meaning too; remove them in the caller.
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) env[key] = undefined;
  const invoke = (args, options = {}) => run(process.execPath, ['--input-type=module', '-e', driver, '--', JSON.stringify(args), target],
    { cwd: elsewhere, ...options, env: { ...env, ...options.env } });
  return { git, gh, target, elsewhere, config, text, invoke, env };
}

test('Git settings require an explicit mode and a complete identity; fields remain independently repairable', () => {
  const f = fixture();
  try {
    assert.throws(() => validateGitSettings({}), /config_missing_git_credential_mode/);
    assert.throws(() => validateGitSettings({ user: { name: 'one' }, credential: { mode: 'inherit' } }), /config_incomplete_git_user/);
    for (const mode of ['', 'auto', 'true']) assert.throws(() => validateGitSettings({ credential: { mode } }), /config_invalid_git_credential_mode/);
    configure(f.root, 'set', 'git.credential.mode', 'inherit');
    configure(f.root, 'set', 'git.user.name', 'Name "quotes" & 中文');
    assert.throws(() => validateGitSettings(readConfiguration(f.root).git), /config_incomplete_git_user/);
    configure(f.root, 'set', 'git.user.email', 'person@example.test');
    assert.equal(validateGitSettings(readConfiguration(f.root).git).user.name, 'Name "quotes" & 中文');
    assert.equal(validateGitSettings({ credential: { mode: 'inherit' } }).credential.mode, 'inherit');
  } finally { f.dispose(); }
});

test('runtime Git config beats files, preserves native overrides and reaches Git launched by gh', () => {
  const f = fixture();
  try {
    const s = setup(f);
    ok(run(s.git, ['-C', s.target, 'config', 'user.name', 'Local Name']));
    ok(run(s.git, ['-C', s.target, 'config', 'user.email', 'local@example.test']));
    assert.equal(ok(s.invoke(['.git', 'config', '--get', 'user.name'])).stdout.trim(), settings.user.name);
    assert.equal(ok(s.invoke(['.git', '-c', 'user.name=Explicit Name', 'config', '--get', 'user.name'])).stdout.trim(), 'Explicit Name');
    assert.match(ok(s.invoke(['.git', 'var', 'GIT_AUTHOR_IDENT'], { env: { GIT_AUTHOR_NAME: 'Environment Author' } })).stdout,
      /^Environment Author <configured@example.test>/);
    const diagnostic = JSON.parse(s.invoke(['doctor', '--offline']).stdout);
    assert.equal(diagnostic.checks.find(item => item.id === 'folder.git.author').details.name, settings.user.name);
    assert.equal(diagnostic.checks.find(item => item.id === 'folder.git.author').details.committer.email, settings.user.email);
    assert.equal(s.invoke(['.git', '-C', s.elsewhere, 'rev-parse', '--is-inside-work-tree']).status, 128);
  } finally { f.dispose(); }
});

test('passthrough preserves arbitrary arguments, stdin, stderr, exit code and configured gh defaults', () => {
  const f = fixture();
  try {
    const s = setup(f);
    const args = ['echo', '--repo', 'other/project', '--repository=another', '', 'a & b', 'a|b', '%PATH%', '!literal!', 'two "quotes"', 'tail\\', '中文'];
    const result = s.invoke(['.gh', ...args], { input: 'stdin\n中文\n', env: { GH_HOST: 'wrong.test', GH_REPO: 'wrong/repo', GH_TOKEN: 'PRIVATE_TOKEN' } });
    assert.equal(result.status, 23); assert.equal(result.stderr, 'native stderr\n');
    const lines = result.stdout.trim().split(/\r?\n/).map(line => {
      const i = line.indexOf('='); return [line.slice(0, i), Buffer.from(line.slice(i + 1), 'base64').toString()];
    });
    assert.deepEqual(lines.filter(([key]) => key === 'arg').map(([, value]) => value), args);
    assert.deepEqual(Object.fromEntries(lines.filter(([key]) => key !== 'arg')), {
      cwd: realpathSync.native(s.target), host: 'github.com', repo: 'github.com/owner/repo', account: 'Octocat', input: 'stdin\n中文\n',
    });
    assert.equal(ok(s.invoke(['.gh', 'child-git'])).stdout.trim(), settings.user.name);
    for (const account of ['missing', 'mismatch']) {
      write(s.config, s.text.replace('Octocat', account));
      const failed = s.invoke(['.gh', 'echo']);
      assert.equal(failed.status, 2); assert.equal(failed.stdout, '');
      assert.equal(JSON.parse(failed.stderr).reason, account === 'missing' ? 'account_token_unavailable' : 'unexpected_account');
      assert.ok(!failed.stderr.includes('PRIVATE_TOKEN'));
      ok(s.invoke(['.git', 'status', '--short']));
    }
  } finally { f.dispose(); }
});

test('HTTPS credentials are acquired lazily via gh; helper reset and command overrides work', () => {
  const f = fixture();
  try {
    const s = setup(f);
    ok(run(s.git, ['-C', s.target, 'config', 'credential.helper', '!echo wrong-helper >&2; exit 1']));
    const request = 'protocol=https\nhost=github.com\n\n';
    const credential = ok(s.invoke(['.git', 'credential', 'fill'], { input: request }));
    assert.match(credential.stdout, /password=fixture-Octocat/); assert.doesNotMatch(credential.stderr, /wrong-helper/);
    const override = ok(s.invoke(['.git', '-c', 'credential.https://github.com.helper=', '-c',
      'credential.https://github.com.helper=!echo username=explicit; echo password=explicit', 'credential', 'fill'], { input: request }));
    assert.match(override.stdout, /password=explicit/);
    write(s.config, s.text.replace('Octocat', 'missing'));
    const missing = s.invoke(['.git', 'credential', 'fill'], { input: request });
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /account_token_unavailable/);
    assert.doesNotMatch(missing.stderr, /PRIVATE_TOKEN/);
    const marker = join(f.root, 'ssh-used'), ssh = join(f.root, 'fake-ssh.cjs');
    write(ssh, `require('fs').writeFileSync(${JSON.stringify(marker)},'called');process.exit(47);`);
    const sshResult = s.invoke(['.git', 'ls-remote', 'git@github.com:other/project.git'], { env: {
      GIT_SSH_COMMAND: `"${process.execPath.replaceAll('\\', '/')}" "${ssh.replaceAll('\\', '/')}"`, GIT_SSH_VARIANT: 'simple',
    } });
    assert.notEqual(sshResult.status, 0); assert.equal(readFileSync(marker, 'utf8'), 'called');
    // Local history preserves explicit authors and Git's committer default.
    ok(s.invoke(['.git', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture', '--author=Original <original@example.test>']));
    assert.equal(ok(s.invoke(['.git', 'log', '-1', '--format=%an|%ae|%cn|%ce'])).stdout.trim(),
      'Original|original@example.test|Configured 姓名|configured@example.test');
    ok(s.invoke(['.git', '-c', 'commit.gpgsign=false', 'commit', '--amend', '--no-edit', '--allow-empty']));
    assert.equal(ok(s.invoke(['.git', 'log', '-1', '--format=%an'])).stdout.trim(), 'Original');
    write(s.config, s.text.replace('"gh"', '"inherit"'));
    const inherited = ok(s.invoke(['.git', 'config', '--get-all', 'credential.helper']));
    assert.match(inherited.stdout, /wrong-helper/);
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

test('streaming execution has no output cap and cancellation returns a nonzero status', async () => {
  const f = fixture();
  try {
    const entry = pathToFileURL(join(repo, '.agents/skills/gidd/scripts.js/passthrough.mjs')).href;
    const script = `const {runPassthrough}=await import(${JSON.stringify(entry)});process.exitCode=await runPassthrough(process.execPath,['-e','process.stdin.pipe(process.stdout);process.stderr.write("stderr");process.exitCode=17']);`;
    const input = 'x'.repeat(1100000) + '\n中文\0\n';
    const output = run(process.execPath, ['--input-type=module', '-e', script], { input, maxBuffer: 2000000 });
    assert.equal(output.stdout, input); assert.equal(output.stderr, 'stderr'); assert.equal(output.status, 17);
    const marker = join(f.root, 'running');
    const controller = new AbortController();
    const pending = runPassthrough(process.execPath, ['-e', `const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000)`],
      { signal: controller.signal, stdio: 'ignore' });
    await until(() => { try { return Number(readFileSync(marker, 'utf8')) > 0; } catch { return false; } });
    const descendant = Number(readFileSync(marker, 'utf8'));
    controller.abort(); assert.equal(await pending, 130);
    await until(() => { try { process.kill(descendant, 0); return false; } catch { return true; } });
  } finally { f.dispose(); }
});

test('generated CMD forwards .git/.gh with literal arguments and bound working directory', () => {
  const f = fixture();
  try {
    const s = setup(f), skill = join(s.target, '.agents/skills/gidd');
    copySkill(skill);
    ok(adapter(f.root, { action: 'bootstrap', repositoryRoot: s.target, responses: {}, downloads: {}, yes: true }, { env: { PATH: dirname(process.execPath) } }));
    publishRepositoryEntry(s.target, join(skill, 'scripts.js/gidd.mjs'));
    const result = runRepositoryCommand(s.target, ['.git', 'config', '--get', 'user.name'], { cwd: s.elsewhere, env: s.env });
    assert.equal(ok(result).stdout.trim(), settings.user.name);
    const args = ['.gh', 'echo', '--repository=other/project', '中文 & spaces', '!literal!', 'two "quotes"'];
    const gh = runRepositoryCommand(s.target, args, { cwd: s.elsewhere, input: 'stdin', env: s.env });
    assert.equal(gh.status, 23); assert.equal(gh.stderr, 'native stderr\n');
    const values = gh.stdout.split(/\r?\n/).filter(line => line.startsWith('arg=')).map(line => Buffer.from(line.slice(4), 'base64').toString());
    assert.deepEqual(values, args.slice(1));
    const credential = ok(runRepositoryCommand(s.target, ['.git', 'credential', 'fill'],
      { cwd: s.elsewhere, input: 'protocol=https\nhost=github.com\n\n', env: s.env }));
    assert.match(credential.stdout, /password=fixture-Octocat/);
  } finally { f.dispose(); }
});
