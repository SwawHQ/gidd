import { afterEach, test } from 'node:test';
import { adapter, assert, compile, existsSync, fixture, hash, join, json, nodeExecutable, ok, readFileSync, run, startFixture, support, until, write } from './support/helpers.mjs';
import { installation } from './support/issue-task.mjs';

test('process: stdout, inherited pipes and one shared timeout deadline', { timeout: 120000 }, async () => {
  const f = fixture(), pidFiles = [];
  try {
    const executable = nodeExecutable(), script = join(support, 'pipe-parent.mjs');
    const invoke = (args, timeout) => json(ok(adapter(f.root,{action:'process',executable,arguments:[script,...args],timeout})));
    const normal = invoke(['normal'],2);
    assert.equal(normal.result.ok,true); assert.equal(normal.result.text,'complete output');
    for (const delay of [0,1400]) {
      const path = join(f.root,`${delay}.pid`); pidFiles.push(path);
      const result = invoke([String(delay),path],2);
      assert.equal(result.result.ok,false); assert.equal(result.result.reason,'process_timeout'); assert.equal(result.result.text,'');
      assert.ok(result.elapsed >= 1800 && result.elapsed < 2800,`Shared deadline: ${result.elapsed} ms`);
    }
    const hanging = invoke(['hang'],1);
    assert.equal(hanging.result.ok,false); assert.equal(hanging.result.reason,'process_timeout'); assert.ok(hanging.elapsed < 1800);
  } finally {
    for (const path of pidFiles.filter(existsSync)) assert.throws(() => process.kill(Number(readFileSync(path,'utf8')), 0));
    f.dispose();
  }
});

function assertStopped(path) {
  const pid = Number(readFileSync(path + '.pid', 'utf8'));
  assert.throws(() => process.kill(pid, 0), `Fixture descendant ${pid} must be stopped`);
}

test('synchronous fixtures stop timed-out commands and child-held files before reporting failure', () => {
  const f = fixture();
  try {
    assert.throws(() => run(join(f.root, 'missing.exe')), { code: 'ENOENT' });
    const executable = nodeExecutable(), script = join(support, 'fixture-worker.mjs'), path = join(f.root, 'locked');
    assert.equal(run(executable, [script, 'status', '-1073741502']).status, 0xC0000142);
    assert.throws(() => run(executable, [script, 'hold', path], { timeout: 700 }), { code: 'ETIMEDOUT' });
    assertStopped(path);
    const orphan = join(f.root, 'orphan');
    ok(run(executable, [script, 'orphan', orphan])); assertStopped(orphan);
  } finally { f.dispose(); }
});

test('asynchronous fixtures release children after timeout, cancellation or owner termination', async () => {
  const f = fixture();
  try {
    const executable = nodeExecutable(), script = join(support, 'fixture-worker.mjs');
    for (const mode of ['timeout', 'cancel', 'terminated']) {
      const path = join(f.root, mode), worker = startFixture(f.root, executable,
        [script, 'hold', path], { timeout: mode === 'timeout' ? 1800 : 15000 });
      await until(() => existsSync(path + '.locked'));
      if (mode === 'timeout') await assert.rejects(worker.result, { code: 'ETIMEDOUT' });
      else if (mode === 'cancel') assert.equal((await worker.stop()).status, 130);
      else {
        worker.child.kill();
        assert.notEqual((await worker.result).status, 0);
        const pid = Number(readFileSync(path + '.pid', 'utf8'));
        await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
      }
      assertStopped(path);
    }
    const failing = startFixture(f.root, executable, [script, 'status', '-1073741502']);
    assert.equal((await failing.result).status, 0xC0000142);
  } finally { f.dispose(); }
});

test('fixture disposal stops an unawaited worker before deleting its working directory', async () => {
  const f = fixture();
  let worker, disposed = false;
  try {
    const path = join(f.root, 'locked');
    worker = startFixture(f.root, nodeExecutable(), [join(support, 'fixture-worker.mjs'), 'hold', path]);
    await until(() => existsSync(path + '.locked'));
    const pid = Number(readFileSync(path + '.pid', 'utf8'));
    f.dispose(); disposed = true;
    assert.equal(existsSync(f.root), false);
    assert.throws(() => process.kill(pid, 0));
    assert.equal((await worker.result).status, 130);
  } finally { if (!disposed) f.dispose(); }
});

let abandoned, originalProfile;
afterEach(() => {
  if (!abandoned) return;
  for (const resource of abandoned) assert.equal(existsSync(resource.root), false);
  assert.equal(process.env.USERPROFILE, originalProfile);
  abandoned = undefined;
});

test('fixture cleanup restores the profile when setup fails before try/finally', () => {
  originalProfile = process.env.USERPROFILE;
  assert.throws(() => {
    abandoned = [fixture(), fixture()];
    throw new Error('setup failed');
  }, /setup failed/);
});

test('automatic cleanup waits for cancelled task operations before deleting their files', async (t) => {
  originalProfile = process.env.USERPROFILE;
  const s = installation(t);
  abandoned = [s];
  let started = false;
  s.control.intercept = (exe, args, { signal }) => new Promise(resolve => {
    started = true;
    signal.addEventListener('abort', () => setTimeout(() => {
      assert.equal(existsSync(s.root), true);
      resolve({ ok: false, reason: 'cancelled', text: '' });
    }, 25), { once: true });
  });
  s.command('workspace', ['2']).catch(() => {});
  await until(() => started);
});

test('disposed fixtures cannot restore another profile or start more work', () => {
  const previous = fixture();
  previous.dispose();
  const current = fixture();
  try {
    previous.dispose();
    assert.equal(process.env.USERPROFILE, current.root);
    assert.throws(() => adapter(previous.root, { action: 'configuration' }), /fixture is closed/);
    assert.equal(existsSync(previous.root), false);
  } finally { current.dispose(); }
});

test('fixture cleanup restores the profile even when a worker fails to stop', () => {
  const profile = process.env.USERPROFILE, f = fixture();
  f.workers.add({ stopSync() { throw new Error('fixture stop failed'); } });
  try {
    assert.throws(() => f.dispose(), /workers did not stop/);
    assert.equal(process.env.USERPROFILE, profile);
    assert.equal(existsSync(f.root), true, 'Failed termination must not delete worker files');
  } finally {
    f.workers.clear();
    f.dispose();
  }
});

test('cached native fixtures remain independent after a caller changes its executable', () => {
  const first = fixture(), second = fixture();
  try {
    const original = compile(first.root), expected = hash(original);
    write(original, 'damaged fixture');
    const copied = compile(second.root);
    assert.equal(hash(copied), expected);
    assert.notEqual(hash(original), expected);
  } finally { second.dispose(); first.dispose(); }
});
