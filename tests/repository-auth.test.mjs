import { test } from 'node:test';
import { selectRepositoryAccount, authorizeRepositoryGitHub } from '../.agents/skills/gidd/scripts.js/shared/repository-auth.mjs';
import { assert, fixture, join, write, readFileSync, existsSync } from './support/helpers.mjs';

test('repository profiles select independent accounts and ignore caller tokens and profile', async () => {
  const f = fixture();
  try {
    const a = { path: join(f.root, 'a.gidd') }, b = { path: join(f.root, 'b.gidd') };
    const caller = { GH_CONFIG_DIR: join(f.root, 'user-gh'), gh_token: 'private-caller', GH_ENTERPRISE_TOKEN: 'private-enterprise' };
    const before = { ...caller }, calls = [];
    const execute = async (exe, args, { env }) => {
      calls.push({ args, env });
      if (args[0] === 'config') return { ok: true, text: env.GH_CONFIG_DIR === join(a.path, 'gh') ? 'Personal' : 'Work' };
      if (args[0] === 'auth') {
        assert.equal(env.gh_token, undefined); assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
        return { ok: true, text: 'token-' + args.at(-1) };
      }
      return { ok: true, text: (env.GH_TOKEN || env.GH_ENTERPRISE_TOKEN).slice(6) };
    };
    const target = { gh: 'fixture.exe', hostname: 'github.com', repository: 'https://github.com/org/repo' };
    const [first, second] = await Promise.all([a, b].map(storage => selectRepositoryAccount(target, { storage, env: caller, execute })));
    assert.equal(first.identity.details.actual, 'Personal');
    assert.equal(second.identity.details.actual, 'Work');
    const task = await selectRepositoryAccount({ ...target, account: 'Original' }, { storage: b, env: caller, execute });
    assert.equal(task.identity.details.actual, 'Original');
    assert.equal(calls.filter(call => call.args[0] === 'config').length, 2, 'Task identity does not follow the new default');
    assert.deepEqual(caller, before);
    assert.equal(existsSync(a.path), false, 'Reading a profile does not create local data');
    const enterprise = await selectRepositoryAccount({ ...target, hostname: 'github.example.test' }, { storage: b, env: caller, execute });
    assert.equal(enterprise.env.GH_TOKEN, undefined);
    assert.equal(enterprise.env.GH_ENTERPRISE_TOKEN, 'token-Work');
  } finally { f.dispose(); }
});

test('missing repository login stops before shared-keyring token lookup', async () => {
  const f = fixture();
  try {
    const storage = { path: join(f.root, 'repo.gidd') }, calls = [];
    await assert.rejects(selectRepositoryAccount({ gh: 'fixture.exe', hostname: 'github.com' }, {
      storage, execute: async (exe, args) => { calls.push(args); return { ok: false, reason: 'command_failed', text: '' }; },
    }), /gh_auth_required/);
    assert.deepEqual(calls, [['config', 'get', 'user', '--host', 'github.com']]);
  } finally { f.dispose(); }
});

test('authorization uses only the repository profile and verifies actual identity after login', async () => {
  const f = fixture();
  try {
    const storage = { path: join(f.root, 'repo.gidd') }, user = join(f.root, 'user-gh');
    const profile = join(storage.path, 'gh');
    write(join(user, 'hosts.yml'), 'existing user configuration');
    let loggedIn = false;
    const target = { gh: 'fixture.exe', hostname: 'github.example.test' };
    const options = {
      storage, cwd: f.root, env: { GH_CONFIG_DIR: user, GH_TOKEN: 'caller-token', gh_prompt_disabled: '' },
      login: async (exe, args, { env, cwd, stdio }) => {
        assert.equal(exe, target.gh); assert.equal(cwd, f.root);
        assert.deepEqual(args, ['auth', 'login', '--hostname', target.hostname, '--web', '--skip-ssh-key']);
        assert.equal(env.GH_CONFIG_DIR, profile); assert.equal(env.GH_TOKEN, undefined);
        assert.equal(env.GH_PROMPT_DISABLED, '1'); assert.equal(env.gh_prompt_disabled, undefined);
        assert.deepEqual(stdio, ['ignore', 2, 2]);
        write(join(profile, 'hosts.yml'), 'new repository configuration');
        loggedIn = true; return 0;
      },
      execute: async (exe, args, { env }) => {
        assert.equal(loggedIn, true); assert.equal(env.GH_CONFIG_DIR, profile);
        return { ok: true, text: args[0] === 'auth' ? 'private-token' : 'AuthenticatedUser' };
      },
    };
    const result = await authorizeRepositoryGitHub(target, options);
    assert.deepEqual(result, { hostname: target.hostname, account: 'AuthenticatedUser', config_directory: profile });
    assert.equal(readFileSync(join(user, 'hosts.yml'), 'utf8'), 'existing user configuration');
    assert.doesNotMatch(JSON.stringify(result), /private-token/);
    for (const [status, reason] of [[1, /gh_login_failed/], [130, /cancelled/]]) {
      await assert.rejects(authorizeRepositoryGitHub(target, { ...options, login: async () => status,
        execute: () => assert.fail('Failed login must not query credentials') }), reason);
    }
    await assert.rejects(authorizeRepositoryGitHub(target, { ...options,
      execute: async (exe, args) => ({ ok: true, text: args[0] === 'config' ? 'Expected' : args[0] === 'auth' ? 'private-token' : 'Other' }),
    }), /unexpected_account/);
  } finally { f.dispose(); }
});
