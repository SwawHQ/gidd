import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { configure, readConfiguration } from '../.agents/skills/gidd/scripts.js/shared/config.mjs';
import { validateGitSettings } from '../.agents/skills/gidd/scripts.js/shared/git-settings.mjs';
import { gitConfigurationEnvironment, selectGitHubAccount } from '../.agents/skills/gidd/scripts.js/shared/execution-env.mjs';
import { runPassthrough } from '../.agents/skills/gidd/scripts.js/shared/passthrough.mjs';
import { executionTimeout, noninteractiveEnvironment, rejectInteractiveArguments } from '../.agents/skills/gidd/scripts.js/shared/noninteractive.mjs';
import { publishRepositoryEntry, runRepositoryCommand } from './support/repository.mjs';
import { assert, fixture, findGit, join, mkdirSync, write, run, ok, compile, bindFixture, copySkill, adapter,
  dirname, readFileSync, repo, until, existsSync } from './support/helpers.mjs';

const code = pathToFileURL(join(repo, '.agents/skills/gidd/scripts.js/gidd.mjs')).href;
const driver = `const {main}=await import(${JSON.stringify(code)});process.exitCode=await main(JSON.parse(process.argv[1]),{boundRepository:process.argv[2]});`;
const settings = { user: { mode: 'managed', name: 'Configured 姓名', email: 'configured@example.test' }, credential: { mode: 'gh' } };
function setup(f) {
  const git = findGit(), gh = compile(f.root, 'wrapper-gh.cs');
  bindFixture(f.root, { git, gh });
  const target = join(f.root, "仓库 ' & space"), elsewhere = join(f.root, 'elsewhere');
  mkdirSync(target); mkdirSync(elsewhere);
  ok(run(git, ['init', '--quiet', target]));
  const config = join(target, '.agents/skills/gidd/config.toml');
  const text = 'schema_version = 1\n[repo]\nremote.url = "https://github.com/owner/repo"\nremote.account = "Octocat"\n' +
    '[git]\nuser.mode = "managed"\nuser.name = "Configured 姓名"\nuser.email = "configured@example.test"\ncredential.mode = "gh"\n';
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
    assert.throws(() => validateGitSettings({}), /config_missing_git_user_mode/);
    assert.throws(() => validateGitSettings({ user: { mode: 'inherit' } }), /config_missing_git_credential_mode/);
    for (const mode of ['', 'config', 'auto', 'true']) {
      assert.throws(() => validateGitSettings({ user: { mode } }), /config_invalid_git_user_mode/);
      assert.throws(() => configure(f.root, 'set', 'git.user.mode', mode), /config_invalid_git_user_mode/);
    }
    for (const user of [{}, { name: 'one' }, { email: 'one@example.test' }]) {
      assert.throws(() => validateGitSettings({ user: { mode: 'managed', ...user } }), /config_incomplete_git_user/);
    }
    for (const user of [{ name: 'one' }, { email: 'one@example.test' }, { name: 'one', email: 'one@example.test' }]) {
      assert.throws(() => validateGitSettings({ user: { mode: 'inherit', ...user } }), /config_git_user_inherit_conflict/);
    }
    for (const mode of ['', 'auto', 'true']) assert.throws(() => validateGitSettings({ user: { mode: 'inherit' }, credential: { mode } }), /config_invalid_git_credential_mode/);
    configure(f.root, 'set', 'git.credential.mode', 'inherit');
    configure(f.root, 'set', 'git.user.mode', 'managed');
    assert.throws(() => validateGitSettings(readConfiguration(f.root).git), /config_incomplete_git_user/);
    assert.match(configure(f.root, 'show').content, /user.mode = "managed"/);
    configure(f.root, 'set', 'git.user.name', 'Name "quotes" & 中文');
    assert.throws(() => validateGitSettings(readConfiguration(f.root).git), /config_incomplete_git_user/);
    configure(f.root, 'set', 'git.user.email', 'person@example.test');
    assert.equal(validateGitSettings(readConfiguration(f.root).git).user.name, 'Name "quotes" & 中文');
    configure(f.root, 'set', 'git.user.mode', 'inherit');
    assert.throws(() => validateGitSettings(readConfiguration(f.root).git), /config_git_user_inherit_conflict/);
    assert.match(configure(f.root, 'show').content, /user.mode = "inherit"/);
    configure(f.root, 'set', 'git.user.mode', 'managed');
    assert.ok(configure(f.root, 'show').content.includes('user.mode = "managed"'));
    assert.equal(validateGitSettings({ user: { mode: 'inherit' }, credential: { mode: 'inherit' } }).user.mode, 'inherit');
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
    assert.deepEqual(diagnostic.checks.find(item => item.id === 'config.git.user.mode').details,
      { mode: 'managed', source: 'config.toml' });
    for (const field of ['name', 'email']) {
      assert.deepEqual(diagnostic.checks.find(item => item.id === 'config.git.user.' + field).details, { configured: settings.user[field] });
    }
    assert.equal(diagnostic.checks.find(item => item.id === 'folder.git.identity').details.author.name, settings.user.name);
    assert.equal(diagnostic.checks.find(item => item.id === 'folder.git.identity').details.committer.email, settings.user.email);
    const distinct = JSON.parse(s.invoke(['doctor', '--offline'], { env: {
      GIT_AUTHOR_NAME: 'Environment Author', GIT_AUTHOR_EMAIL: 'author@example.test',
      GIT_COMMITTER_NAME: 'Environment Committer', GIT_COMMITTER_EMAIL: 'committer@example.test',
    } }).stdout);
    const identity = distinct.checks.find(item => item.id === 'folder.git.identity');
    assert.equal(identity.status, 'ready');
    assert.deepEqual(identity.details, {
      author: { name: 'Environment Author', email: 'author@example.test' },
      committer: { name: 'Environment Committer', email: 'committer@example.test' },
    });
    assert.equal(s.invoke(['.git', '-C', s.elsewhere, 'rev-parse', '--is-inside-work-tree']).status, 128);
    const inherited = s.text.replace('user.mode = "managed"', 'user.mode = "inherit"').replace(/^user\.(?:name|email) = .*\n/gm, '');
    write(s.config, inherited);
    assert.equal(ok(s.invoke(['.git', 'config', '--get', 'user.name'])).stdout.trim(), 'Local Name');
    assert.equal(ok(s.invoke(['.gh', 'child-git'])).stdout.trim(), 'Local Name');
    const localReport = JSON.parse(s.invoke(['doctor', '--offline']).stdout);
    assert.deepEqual(localReport.checks.find(item => item.id === 'config.git.user.mode').details, { mode: 'inherit', source: 'git' });
    assert.equal(localReport.checks.find(item => item.id === 'folder.git.identity').details.author.email, 'local@example.test');
    const globalConfig = join(f.root, 'global.gitconfig');
    write(globalConfig, '[user]\nname = Global Name\nemail = global@example.test\n');
    for (const key of ['name', 'email']) ok(run(s.git, ['-C', s.target, 'config', '--unset', 'user.' + key]));
    const globalEnv = { GIT_CONFIG_GLOBAL: globalConfig };
    assert.match(ok(s.invoke(['.git', 'var', 'GIT_AUTHOR_IDENT'], { env: globalEnv })).stdout, /^Global Name <global@example.test>/);
    assert.equal(ok(s.invoke(['.gh', 'child-git'], { env: globalEnv })).stdout.trim(), 'Global Name');
  } finally { f.dispose(); }
});

test('invalid identity modes block both wrappers and cannot report a fallback identity as ready', () => {
  const f = fixture();
  try {
    const s = setup(f);
    for (const [text, reason, field, diagnosticReason = reason] of [
      [s.text.replace('user.mode = "managed"\n', ''), 'config_missing_git_user_mode', 'mode'],
      [s.text.replace('"managed"', '"config"'), 'config_invalid_git_user_mode', 'mode'],
      [s.text.replace(/^user\.(?:name|email) = .*\n/gm, ''), 'config_incomplete_git_user', 'name', 'config_missing_git_user_name'],
      [s.text.replace('"managed"', '"inherit"'), 'config_git_user_inherit_conflict', 'name'],
      [s.text.replace(settings.user.email, ' '), 'config_invalid_git_user_email', 'email'],
    ]) {
      write(s.config, text);
      for (const tool of ['.git', '.gh']) {
        const failed = s.invoke([tool, '--version']);
        assert.equal(failed.status, 2); assert.equal(failed.stdout, '');
        assert.match(failed.stderr, new RegExp(reason));
      }
      const shown = ok(s.invoke(['set.show']));
      assert.equal(shown.stdout, text); assert.equal(shown.stderr, '');
      const report = JSON.parse(s.invoke(['doctor', '--offline']).stdout);
      assert.equal(report.checks.find(item => item.id === 'config.git.user.' + field).reason, diagnosticReason);
      assert.equal(report.checks.find(item => item.id === 'folder.git.identity').blocked_by, 'config.git.user.' + field);
    }
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
    assert.match(missing.stderr, /gidd\.link\.cmd \.gh\.auth/);
    assert.doesNotMatch(missing.stderr, /PRIVATE_TOKEN/);
    const marker = join(f.root, 'ssh-used'), ssh = join(f.root, 'fake-ssh.cjs');
    write(ssh, `require('fs').writeFileSync(${JSON.stringify(marker)},'called');process.exit(47);`);
    const sshResult = s.invoke(['.git', 'ls-remote', 'git@github.com:other/project.git'], { env: {
      GIT_SSH_COMMAND: `"${process.execPath.replaceAll('\\', '/')}" "${ssh.replaceAll('\\', '/')}"`, GIT_SSH_VARIANT: 'ssh',
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

test('editors and AskPass fail without invoking inherited programs; stdin and pager remain usable', () => {
  const f = fixture();
  try {
    const s = setup(f), marker = join(f.root, 'unexpected-interaction'), script = join(f.root, 'interactive.cjs');
    write(script, `require('fs').writeFileSync(${JSON.stringify(marker)},'called');process.exit(0);`);
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`;
    const env = { GIT_EDITOR: command, GIT_SEQUENCE_EDITOR: command, GH_EDITOR: command,
      GIT_ASKPASS: script, SSH_ASKPASS: script, GCM_INTERACTIVE: 'true', GIT_PAGER: command };
    const failed = s.invoke(['.git', '-c', 'core.editor=' + command, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty'], { env });
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /interactive editor disabled/);
    assert.equal(existsSync(marker), false);
    assert.notEqual(s.invoke(['.git', 'rev-parse', '--verify', 'HEAD']).status, 0, 'No commit was made by a no-op editor');
    for (const variable of ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']) {
      assert.match(ok(s.invoke(['.git', 'var', variable], { env })).stdout, /reject-interaction\.mjs/);
    }
    assert.equal(ok(s.invoke(['.git', 'var', 'GIT_PAGER'], { env })).stdout.trim(), 'cat');
    write(s.config, s.text.replace('"gh"', '"inherit"'));
    const credential = s.invoke(['.git', '-c', 'credential.helper=', '-c', 'core.askPass=' + script, 'credential', 'fill'],
      { input: 'protocol=https\nhost=example.invalid\n\n', env });
    assert.notEqual(credential.status, 0); assert.match(credential.stderr, /credential prompt disabled|unable to get password/);
    const askpass = s.invoke(['.git', '-c', 'credential.helper=', '-c', 'credential.interactive=true', 'credential', 'fill'],
      { input: 'protocol=https\nhost=example.invalid\n\n', env });
    assert.notEqual(askpass.status, 0); assert.match(askpass.stderr, /credential prompt disabled/);
    assert.equal(existsSync(marker), false);
    const helper = '!echo "$GCM_INTERACTIVE" >&2; echo username=fixture; echo password=fixture';
    const inherited = ok(s.invoke(['.git', '-c', 'credential.helper=', '-c', 'credential.helper=' + helper, 'credential', 'fill'],
      { input: 'protocol=https\nhost=example.invalid\n\n', env }));
    assert.match(inherited.stderr, /^0\r?\n/);
    ok(s.invoke(['.git', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-F', '-'], { input: 'message from stdin\n', env }));
    assert.equal(ok(s.invoke(['.git', 'log', '-1', '--format=%s'])).stdout.trim(), 'message from stdin');
    const sequence = s.invoke(['.git', 'rebase', '-i', '--root'], { env });
    assert.notEqual(sequence.status, 0); assert.match(sequence.stderr, /interactive editor disabled/);
    assert.equal(existsSync(marker), false);
  } finally { f.dispose(); }
});

test('explicit patch/interactive modes fail before execution without mistaking data for options', () => {
  const f = fixture();
  try {
    const s = setup(f);
    for (const args of [['add', '-p'], ['add', '-vi'], ['clean', '-di'], ['commit', '-sp'], ['commit', '--inter'],
      ['checkout', '--patch'], ['restore', '--pa'], ['reset', '-p'], ['stash', 'push', '-p'], ['mergetool'], ['difftool', '-y'],
      ['-C', s.target, '-c', 'user.name=-p', 'add', '-p']]) {
      const failed = s.invoke(['.git', ...args]);
      assert.equal(failed.status, 2, JSON.stringify(args) + failed.stderr); assert.match(failed.stderr, /interactive_command_disabled/);
    }
    for (const args of [['add', '--', '-p'], ['commit', '-m', '--patch'], ['commit', '-m-p'], ['commit', '-qm', '--patch'],
      ['commit', '-i', '-m', 'message'], ['commit', '--message=-p'], ['clean', '-e', '--interactive'],
      ['restore', '-s', '--patch'], ['config', 'alias.inspect', 'add -p']]) {
      assert.doesNotThrow(() => rejectInteractiveArguments('git', args));
    }
    ok(s.invoke(['.git', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', '--patch']));
    assert.equal(ok(s.invoke(['.git', 'log', '-1', '--format=%s'])).stdout.trim(), '--patch');
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
    const failed = s.invoke(['.git', 'clean', '-f', '--', 'locked-file.txt'], { env: { GIT_ASK_YESNO: 'must-not-run' } });
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
    write(script, `require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));process.exit(47);`);
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`;
    for (const variant of ['ssh', 'plink', 'tortoiseplink']) {
      const result = s.invoke(['.git', '-c', 'core.sshCommand=' + command, '-c', 'ssh.variant=' + variant,
        'ls-remote', 'ssh://git@example.invalid:2222/other/project.git']);
      assert.notEqual(result.status, 0);
      assert.ok(existsSync(marker), result.stderr);
      const received = JSON.parse(readFileSync(marker, 'utf8'));
      assert.ok(received.args.includes(variant === 'ssh' ? '-oBatchMode=yes' : '-batch'));
      assert.ok(received.args.includes(variant === 'ssh' ? '-p' : '-P'));
      assert.ok(received.args.includes('2222'));
      assert.ok(received.args.includes('git@example.invalid'));
    }
    const result = s.invoke(['.git', '-C', s.elsewhere, '-c', 'core.sshCommand=must-not-run',
      'ls-remote', 'git@example.invalid:path with spaces.git'], { env: { GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: 'ssh' } });
    assert.notEqual(result.status, 0);
    const received = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(realpathSync.native(received.cwd), realpathSync.native(s.elsewhere));
    assert.ok(received.args.some(arg => arg.includes('path with spaces.git')));
    for (const variant of ['simple', 'auto']) {
      const failed = s.invoke(['.git', 'ls-remote', 'git@example.invalid:repo'], { env: { GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: variant } });
      assert.notEqual(failed.status, 0); assert.match(failed.stderr, /noninteractive SSH/);
    }
    const fromEnv = s.invoke(['.git', '--config-env=core.sshCommand=GIDD_TEST_SSH', '-c', 'ssh.variant=ssh',
      'ls-remote', 'git@example.invalid:repo'], { env: { GIDD_TEST_SSH: command } });
    assert.notEqual(fromEnv.status, 0);
    assert.ok(JSON.parse(readFileSync(marker, 'utf8')).args.includes('-oBatchMode=yes'));
    ok(run(s.git, ['-C', s.target, 'config', 'core.sshCommand', command]));
    ok(run(s.git, ['-C', s.target, 'config', 'ssh.variant', 'ssh']));
    const fromFile = s.invoke(['.git', 'ls-remote', 'git@example.invalid:repo']);
    assert.notEqual(fromFile.status, 0);
    assert.ok(JSON.parse(readFileSync(marker, 'utf8')).args.includes('-oBatchMode=yes'));
    const nestedEnv = noninteractiveEnvironment(s.git, { GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: 'ssh' });
    const nested = s.invoke(['.git', 'ls-remote', 'git@example.invalid:nested-repo'], { env: nestedEnv });
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
    const result = ok(s.invoke(['.gh', 'noninteractive-environment']));
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.GH_PROMPT_DISABLED, '1'); assert.equal(actual.GCM_INTERACTIVE, '0');
    assert.equal(actual.GH_EDITOR, actual.GIT_EDITOR); assert.equal(actual.GIT_PAGER, 'cat');
  } finally { f.dispose(); }
});

test('optional execution deadlines validate input and stop descendants with exit 124', async () => {
  assert.equal(executionTimeout({}), 0); assert.equal(executionTimeout({ GIDD_EXEC_TIMEOUT_MS: '0' }), 0);
  assert.equal(executionTimeout({ gidd_exec_timeout_ms: '3000' }), 3000);
  for (const value of ['-1', '1.5', 'soon', '2147483648']) {
    assert.throws(() => executionTimeout({ GIDD_EXEC_TIMEOUT_MS: value }), /invalid_execution_timeout/);
  }
  const f = fixture();
  try {
    const marker = join(f.root, 'timed-descendant');
    const pending = runPassthrough(process.execPath, ['-e', `const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000)`],
      { timeoutMs: 1500, stdio: 'ignore' });
    await until(() => existsSync(marker));
    const descendant = Number(readFileSync(marker, 'utf8'));
    assert.equal(await pending, 124);
    await until(() => { try { process.kill(descendant, 0); return false; } catch { return true; } });
    const s = setup(f);
    assert.equal(s.invoke(['.git', '--version'], { env: { GIDD_EXEC_TIMEOUT_MS: 'invalid' } }).status, 2);
    const timeout = s.invoke(['.git', '-c', 'alias.wait=!sleep 30', 'wait'], { env: { GIDD_EXEC_TIMEOUT_MS: '500' } });
    assert.equal(timeout.status, 124); assert.match(timeout.stderr, /execution timed out/);
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
    const entry = pathToFileURL(join(repo, '.agents/skills/gidd/scripts.js/shared/passthrough.mjs')).href;
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
    const editor = runRepositoryCommand(s.target, ['.git', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty'],
      { cwd: s.elsewhere, env: s.env });
    assert.notEqual(editor.status, 0); assert.match(editor.stderr, /interactive editor disabled/);
    const denied = runRepositoryCommand(s.target, ['.git', '-c', 'credential.helper=', '-c', 'credential.interactive=true', 'credential', 'fill'],
      { cwd: s.elsewhere, input: 'protocol=https\nhost=example.invalid\n\n', env: s.env });
    assert.notEqual(denied.status, 0); assert.match(denied.stderr, /credential prompt disabled/);
    const invoke = args => runRepositoryCommand(s.target, args, { cwd: s.elsewhere, env: s.env });
    const original = readFileSync(s.config, 'utf8');
    for (const args of [['clear'], ['clear', 'git.user.name', 'extra'],
      ['clear', 'git.user.name', ''], ['clear', 'git.user'],
      ['clear', 'schema_version'], ['set', 'git.user.name', '']]) {
      assert.equal(invoke(args).status, 2);
      assert.equal(readFileSync(s.config, 'utf8'), original);
    }
    for (const [key, value] of [['name', 'Inherited Name'], ['email', 'inherited@example.test']]) {
      ok(run(s.git, ['-C', s.target, 'config', 'user.' + key, value]));
    }
    for (const field of ['name', 'email']) {
      const cleared = JSON.parse(ok(invoke(['clear', 'git.user.' + field])).stdout);
      assert.equal(cleared.action, 'clear'); assert.equal(cleared.changed, true);
    }
    assert.equal(invoke(['.git', '--version']).status, 2, 'Managed identity stays incomplete until repaired');
    ok(invoke(['set', 'git.user.mode', 'inherit']));
    ok(invoke(['set.show']));
    assert.equal(ok(invoke(['.git', 'config', '--get', 'user.name'])).stdout.trim(), 'Inherited Name');
    assert.equal(JSON.parse(ok(invoke(['clear', 'git.user.name'])).stdout).changed, false);
    const report = JSON.parse(invoke(['doctor', '--offline']).stdout);
    assert.deepEqual(report.checks.find(item => item.id === 'config.git.user.name').details, { omitted: true });
    assert.equal(report.checks.find(item => item.id === 'folder.git.identity').details.author.email, 'inherited@example.test');
    ok(invoke(['clear', 'git.user.mode']));
    const missingMode = JSON.parse(invoke(['doctor', '--offline']).stdout);
    assert.equal(missingMode.checks.find(item => item.id === 'config.git.user.mode').reason, 'config_missing_git_user_mode');
    assert.equal(invoke(['.git', '--version']).status, 2);
    for (const lang of ['en', 'zh']) assert.match(ok(invoke(['help', lang])).stdout, /gidd.link clear/);
  } finally { f.dispose(); }
});
