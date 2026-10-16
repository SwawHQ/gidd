import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parseGhArguments } from '../.agents/skills/gidd/scripts.js/commands/gh/index.mjs';
import { configureGitAuthentication } from '../.agents/skills/gidd/scripts.js/commands/gh/git-auth.mjs';
import { assert, fixture, join, write, readFileSync, existsSync, run, repo, compile, bindFixture, findGit, ok, stub, nodeExecutable } from './support/helpers.mjs';

test('authorization route needs no Issue and removed forwarding routes fail as unknown commands', () => {
  assert.deepEqual(parseGhArguments('gh.auth', []), { action: 'auth' });
  assert.deepEqual(parseGhArguments('gh.auth.git', []), { action: 'auth.git' });
  for (const route of ['gh.auth', 'gh.auth.git'])
    assert.throws(() => parseGhArguments(route, ['14']), /invalid_arguments/);
  for (const route of ['gh.auth.clear', 'git.auth', 'gh.auth.git.clear'])
    assert.throws(() => parseGhArguments(route, []), /invalid_arguments/);
  const url = pathToFileURL(join(repo, '.agents/skills/gidd/scripts.js/gidd.mjs')).href;
  for (const command of ['.git', '.gh', 'task']) {
    const result = run(process.execPath, ['--input-type=module', '-e',
      `const {main}=await import(${JSON.stringify(url)}); process.exitCode=await main([${JSON.stringify(command)}]);`]);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).details.code, 'unknown_command');
  }
});

test('authorization CLI streams login progress to stderr and returns only verified account JSON', () => {
  const f = fixture();
  try {
    const git = findGit(), gh = compile(f.root, 'wrapper-gh.cs'), target = join(f.root, 'repo');
    bindFixture(f.root, { git, gh });
    ok(run(git, ['init', '-b', 'main', target]));
    ok(run(git, ['-C', target, 'remote', 'add', 'origin', 'https://github.com/org/repo']));
    ok(run(git, ['-C', target, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']));
    assert.equal(existsSync(target + '.gidd'), false);
    const caller = join(f.root, 'caller-gh', 'hosts.yml'); write(caller, 'existing configuration');
    const config = readFileSync(join(target, '.git/config'), 'utf8');
    const url = pathToFileURL(join(repo, '.agents/skills/gidd/scripts.js/gidd.mjs')).href;
    const missing = run(process.execPath, ['--input-type=module', '-e',
      `const {main}=await import(${JSON.stringify(url)}); process.exitCode=await main(['gh.auth.git'],{boundRepository:process.argv[1]});`, target],
    { cwd: target, env: { GIDD_AUTH_LOGIN: 'SelectedUser', GH_CONFIG_DIR: join(f.root, 'caller-gh') } });
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stdout).details.code, 'gh_auth_required');
    assert.equal(readFileSync(join(target, '.git/config'), 'utf8'), config);
    assert.equal(existsSync(target + '.gidd'), false);
    const result = ok(run(process.execPath, ['--input-type=module', '-e',
      `const {main}=await import(${JSON.stringify(url)}); process.exitCode=await main(['gh.auth'],{boundRepository:process.argv[1]});`, target],
    { cwd: target, env: { GIDD_AUTH_LOGIN: 'SelectedUser', GH_CONFIG_DIR: join(f.root, 'caller-gh'), GH_TOKEN: 'caller-private-token' } }));
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'success');
    assert.deepEqual(report.github, { hostname: 'github.com', account: 'SelectedUser', config_directory: join(target + '.gidd', 'gh') });
    assert.match(result.stderr, /fixture browser login progress/);
    assert.doesNotMatch(result.stdout + result.stderr, /caller-private-token|fixture-SelectedUser/);
    assert.equal(readFileSync(caller, 'utf8'), 'existing configuration');
    assert.equal(readFileSync(join(target, '.git/config'), 'utf8'), config);
    const login = readFileSync(join(target + '.gidd', 'gh/hosts.yml'), 'utf8');
    const global = join(f.root, 'global.gitconfig');
    write(global, '[user]\n\tname = Global Author\n\temail = global@example.test\n');
    const globalBefore = readFileSync(global, 'utf8');
    const script = `const {main}=await import(${JSON.stringify(url)}); process.exitCode=await main(['gh.auth.git'],{boundRepository:process.argv[1]});`;
    const options = { cwd: target, env: { GIDD_AUTH_LOGIN: 'MustNotLogIn', GH_CONFIG_DIR: join(f.root, 'caller-gh'),
      GH_TOKEN: 'caller-private-token', GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' } };
    const configured = ok(run(process.execPath, ['--input-type=module', '-e', script, target], options));
    const authorization = JSON.parse(configured.stdout);
    const key = 'credential.https://github.com.helper';
    assert.equal(authorization.status, 'success');
    assert.equal(authorization.credential_helper, key);
    assert.deepEqual(authorization.github, { hostname: 'github.com', config_directory: join(target + '.gidd', 'gh') });
    assert.doesNotMatch(configured.stdout + configured.stderr, /caller-private-token|fixture-SelectedUser|login progress/);
    const helpers = ok(run(git, ['-C', target, 'config', '--local', '--null', '--get-all', key])).stdout.split('\0');
    assert.equal(helpers.length, 3); assert.equal(helpers[0], ''); assert.equal(helpers[2], '');
    assert.ok(helpers[1].includes(gh.replaceAll('\\', '/')));
    assert.ok(helpers[1].includes((target + '.gidd').replaceAll('\\', '/')));
    const configuredBefore = readFileSync(join(target, '.git/config'), 'utf8');
    ok(run(process.execPath, ['--input-type=module', '-e', script, target], options));
    assert.equal(readFileSync(join(target, '.git/config'), 'utf8'), configuredBefore);
    assert.equal(readFileSync(global, 'utf8'), globalBefore);
    assert.equal(readFileSync(join(target + '.gidd', 'gh/hosts.yml'), 'utf8'), login);
    for (const field of ['user.name', 'user.email'])
      assert.equal(run(git, ['-C', target, 'config', '--local', '--get', field]).status, 1);
    ok(run(git, ['-C', target, 'config', '--local', '--unset-all', key]));
    assert.equal(run(git, ['-C', target, 'config', '--local', '--get-all', key]).status, 1);
    assert.equal(readFileSync(join(target + '.gidd', 'gh/hosts.yml'), 'utf8'), login);
  } finally { f.dispose(); }
});

test('Git credentials use the selected profile and quoted executable from linked worktrees', async () => {
  const f = fixture();
  try {
    const git = findGit(), main = join(f.root, "repo ' & 中文"), linked = join(f.root, 'linked');
    const gh = join(f.root, "tools ' & quoted", 'gh.exe');
    stub(nodeExecutable(), gh);
    const global = join(f.root, 'global.gitconfig');
    write(global, '[credential]\n\thelper = !echo inherited-helper-must-not-run >&2; exit 99\n');
    const env = { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GH_CONFIG_DIR: join(f.root, 'wrong-profile') };
    const native = (path, args, options = {}) => run(git, ['-C', path, ...args], { env, ...options });
    const execute = async (path, args) => ok(native(path, args)).stdout.trim();
    ok(run(git, ['init', '-b', 'main', main], { env }));
    for (const [key, value] of [['user.name', 'Original Author'], ['user.email', 'author@example.test'],
      ['credential.https://github.com.helper', 'unrelated-helper']]) ok(native(main, ['config', key, value]));
    const storage = { main, common: join(main, '.git'), path: main + '.gidd' };
    write(join(storage.path, 'gh/profile-marker'), 'selected-profile');
    write(join(main, 'auth'), `const fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== 'git-credential get') process.exit(91);
if (fs.readFileSync(require('node:path').join(process.env.GH_CONFIG_DIR, 'profile-marker'), 'utf8') !== 'selected-profile') process.exit(92);
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  if (!input.includes('host=github.example.test')) process.exit(93);
  process.stdout.write('username=Fixture\\npassword=fixture-token\\n');
});\n`);
    ok(native(main, ['add', 'auth']));
    ok(native(main, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']));
    ok(native(main, ['worktree', 'add', '--quiet', '-b', 'linked', linked]));
    const globalBefore = readFileSync(global, 'utf8');
    const key = await configureGitAuthentication(storage, 'github.example.test', gh, execute);
    assert.equal(key, 'credential.https://github.example.test.helper');
    const configured = readFileSync(join(main, '.git/config'), 'utf8');
    await configureGitAuthentication(storage, 'github.example.test', gh, execute);
    assert.equal(readFileSync(join(main, '.git/config'), 'utf8'), configured);
    const credentials = ok(native(linked, ['credential', 'fill'], { env,
      input: 'protocol=https\nhost=github.example.test\n\n' }));
    assert.match(credentials.stdout, /username=Fixture/);
    assert.match(credentials.stdout, /password=fixture-token/);
    assert.doesNotMatch(credentials.stderr, /inherited-helper-must-not-run/);
    assert.equal(ok(native(main, ['config', '--get', 'user.name'])).stdout.trim(), 'Original Author');
    assert.equal(ok(native(main, ['config', '--get', 'user.email'])).stdout.trim(), 'author@example.test');
    assert.equal(ok(native(main, ['config', '--get', 'credential.https://github.com.helper'])).stdout.trim(), 'unrelated-helper');
    assert.equal(readFileSync(global, 'utf8'), globalBefore);
    assert.equal(existsSync(join(main, '.git/config.lock')), false);
  } finally { f.dispose(); }
});

test('Git credential configuration keeps the original config on failure and respects existing Git locks', async () => {
  const f = fixture();
  try {
    const git = findGit(), main = join(f.root, 'repo');
    ok(run(git, ['init', '-b', 'main', main]));
    const storage = { main, common: join(main, '.git'), path: main + '.gidd' };
    const config = join(storage.common, 'config'), lock = config + '.lock';
    const before = readFileSync(config, 'utf8');
    for (const failed of ['--replace-all', '--add']) {
      await assert.rejects(configureGitAuthentication(storage, 'github.com', process.execPath, async (path, args) => {
        assert.equal(existsSync(lock), true);
        assert.notEqual(run(git, ['-C', path, 'config', 'fixture.concurrent', 'blocked']).status, 0);
        if (args.includes(failed)) throw new Error('fixture_write_failed');
        return ok(run(git, ['-C', path, ...args])).stdout.trim();
      }), /fixture_write_failed/);
      assert.equal(readFileSync(config, 'utf8'), before);
      assert.equal(existsSync(lock), false);
    }
    write(lock, 'another Git operation');
    await assert.rejects(configureGitAuthentication(storage, 'github.com', process.execPath,
      () => assert.fail('A locked config must stop before invoking Git')), /git_config_locked/);
    assert.equal(readFileSync(lock, 'utf8'), 'another Git operation');
    assert.equal(readFileSync(config, 'utf8'), before);
  } finally { f.dispose(); }
});

test('Git credential configuration preserves a lock reacquired immediately after commit', () => {
  const f = fixture();
  try {
    const main = join(f.root, 'repo'), config = join(main, '.git/config');
    write(config, '[core]\n\tbare = false\n');
    const url = pathToFileURL(join(repo, '.agents/skills/gidd/scripts.js/commands/gh/git-auth.mjs')).href;
    // Node can replace named fs exports; Bun runs this deterministic race probe in Node too.
    const result = ok(run(nodeExecutable(), ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { configureGitAuthentication } from ${JSON.stringify(url)};
      const [main, common, config] = process.argv.slice(1), lock = config + '.lock';
      const rename = fs.renameSync, marker = 'another Git operation';
      let acquired = false;
      try {
        fs.renameSync = (source, destination) => {
          rename(source, destination);
          if (source === lock && destination === config) {
            fs.writeFileSync(lock, marker, { flag: 'wx' }); acquired = true;
          }
        };
        syncBuiltinESMExports();
        await configureGitAuthentication({ main, common, path: main + '.gidd' },
          'github.com', process.execPath, async () => '');
      } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
      console.log(JSON.stringify({ acquired, content: fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : null }));
    `, main, join(main, '.git'), config]));
    assert.deepEqual(JSON.parse(result.stdout), { acquired: true, content: 'another Git operation' });
  } finally { f.dispose(); }
});
