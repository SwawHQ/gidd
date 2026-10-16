import { test } from 'node:test';
import { resolveRemoteBinding, verifyRemoteBinding, remoteIdentity, validRemoteBinding } from '../.agents/skills/gidd/scripts.js/shared/remote-binding.mjs';
import { runCommand } from '../.agents/skills/gidd/scripts.js/shared/process.mjs';
import { repositoryConnection } from '../.agents/skills/gidd/scripts.js/shared/repository-remote.mjs';
import { assert, bindFixture, fixture, findGit, join, ok, run, readFileSync } from './support/helpers.mjs';

function setup() {
  const f = fixture(), exe = findGit();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1' };
  const native = args => ok(run(exe, ['-C', f.root, ...args], { env })).stdout.trim();
  native(['init', '-b', 'main']);
  native(['remote', 'add', 'origin', 'https://github.com/upstream/repo.git']);
  const git = async (path, args) => {
    const result = await runCommand(exe, ['-C', path, ...args], { env });
    assert.equal(result.ok, true, JSON.stringify({ args, result })); return result.text;
  };
  const resolve = () => resolveRemoteBinding(git, f.root, 'main');
  return { ...f, exe, env, native, git, resolve };
}

test('Git connections avoid an immediate duplicate read and refresh transports before use', async () => {
  const s = setup(), calls = [];
  try {
    bindFixture(s.root, { git: findGit() });
    const execute = (exe, args, options) => {
      calls.push(args);
      return runCommand(exe, args, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1' } });
    };
    const connection = await repositoryConnection(s.root, { execute, branch: 'main' });
    const reads = () => calls.filter(args => args.includes('config') && args.includes('--null')).length;
    assert.equal(reads(), 1);
    s.native(['config', 'remote.origin.pushurl', 'git@github.com:upstream/repo.git']);
    await connection.verifyRemote();
    assert.equal(reads(), 2);
    assert.equal(connection.remote.push.url, 'git@github.com:upstream/repo.git');
    s.native(['config', 'remote.origin.pushurl', 'https://github.com/other/repo.git']);
    await assert.rejects(connection.verifyRemote(), /delivery_remote_changed/);
    assert.equal(reads(), 3);
  } finally { s.dispose(); }
});

test('remote selection follows target branch precedence and Git URL rewriting', async () => {
  const s = setup();
  try {
    s.native(['remote', 'add', 'fork', 'https://github.com/me/repo.git']);
    s.native(['config', 'branch.main.remote', 'origin']);
    s.native(['config', 'branch.main.merge', 'refs/heads/trunk']);
    s.native(['config', 'remote.pushDefault', 'fork']);
    let binding = await s.resolve();
    assert.equal(binding.fetch.name, 'origin'); assert.equal(binding.fetch.branch, 'trunk');
    assert.equal(binding.push.name, 'fork');
    s.native(['config', 'branch.main.pushRemote', 'origin']);
    assert.equal((await s.resolve()).push.name, 'origin');
    s.native(['config', 'url.git@github.com:.pushInsteadOf', 'https://github.com/']);
    assert.equal((await s.resolve()).push.url, 'git@github.com:upstream/repo.git');
    s.native(['config', 'remote.origin.pushurl', 'https://github.com/explicit/repo.git']);
    assert.equal((await s.resolve()).push.url, 'https://github.com/explicit/repo.git');
  } finally { s.dispose(); }
});

test('dedicated remote isolates multi-push defaults and invalid dedicated settings never fall back', async () => {
  const s = setup();
  try {
    s.native(['config', '--add', 'remote.origin.pushurl', 'https://github.com/a/repo']);
    s.native(['config', '--add', 'remote.origin.pushurl', 'https://github.com/b/repo']);
    await assert.rejects(s.resolve(), /remote_multiple_push_urls/);
    s.native(['remote', 'add', 'for.swaw.gidd', 'https://github.com/upstream/repo.git']);
    s.native(['config', 'remote.for.swaw.gidd.pushurl', 'git@github.com:me/repo.git']);
    const selected = await s.resolve();
    assert.equal(selected.selection, 'dedicated');
    assert.equal(selected.fetch.repository, 'https://github.com/upstream/repo');
    assert.equal(selected.push.repository, 'https://github.com/me/repo');
    s.native(['config', '--add', 'remote.for.swaw.gidd.url', 'https://github.com/extra/repo']);
    await assert.rejects(s.resolve(), /remote_dedicated_urls_invalid/);
    s.native(['config', '--unset-all', 'remote.for.swaw.gidd.url']);
    await assert.rejects(s.resolve(), /remote_dedicated_urls_invalid/);
  } finally { s.dispose(); }
});

test('records pin repositories and fetch branch while aliases, transport and working defaults may change', async () => {
  const s = setup();
  try {
    const remote = remoteIdentity(await s.resolve()), record = { target_branch: 'main', branch: 'gidd-issue-1', delivery: { remote } };
    assert.equal(validRemoteBinding(remote), true);
    assert.equal(validRemoteBinding(await s.resolve()), false);
    await verifyRemoteBinding(s.git, s.root, record);
    s.native(['config', 'branch.main.remote', 'origin']); // equivalent explicit default
    await verifyRemoteBinding(s.git, s.root, record);
    s.native(['remote', 'add', 'other', 'https://github.com/other/repo']);
    s.native(['config', 'branch.gidd-issue-1.pushRemote', 'other']);
    await verifyRemoteBinding(s.git, s.root, record);
    s.native(['config', '--unset', 'branch.gidd-issue-1.pushRemote']);
    s.native(['config', 'remote.origin.pushurl', 'git@github.com:upstream/repo.git']);
    assert.equal((await verifyRemoteBinding(s.git, s.root, record)).push.url, 'git@github.com:upstream/repo.git');
    s.native(['remote', 'rename', 'origin', 'renamed']);
    await verifyRemoteBinding(s.git, s.root, record);
    s.native(['remote', 'add', 'for.swaw.gidd', 'https://github.com/upstream/repo.git']);
    await verifyRemoteBinding(s.git, s.root, record);
    s.native(['config', 'branch.main.merge', 'refs/heads/other']);
    await assert.rejects(verifyRemoteBinding(s.git, s.root, record), /delivery_remote_changed/);
    s.native(['config', '--unset', 'branch.main.merge']);
    s.native(['config', 'remote.for.swaw.gidd.pushurl', 'https://github.com/other/repo']);
    await assert.rejects(verifyRemoteBinding(s.git, s.root, record), /delivery_remote_changed/);
  } finally { s.dispose(); }
});
