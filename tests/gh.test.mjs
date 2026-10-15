import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parseGhArguments } from '../.agents/skills/gidd/scripts.js/commands/gh/index.mjs';
import { assert, fixture, join, write, readFileSync, existsSync, run, repo, compile, bindFixture, findGit, ok } from './support/helpers.mjs';

test('authorization route needs no Issue and removed forwarding routes fail as unknown commands', () => {
  assert.deepEqual(parseGhArguments('gh.auth', []), { action: 'auth' });
  assert.throws(() => parseGhArguments('gh.auth', ['14']), /invalid_arguments/);
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
  } finally { f.dispose(); }
});
