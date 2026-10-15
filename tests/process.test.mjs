import { afterEach, test } from 'node:test';
import { adapter, assert, compile, existsSync, fixture, join, json, ok, readFileSync, run, startAdapter, until } from './support/helpers.mjs';

test('process: stdout, inherited pipes and one shared timeout deadline', { timeout: 120000 }, async () => {
  const f = fixture(), pidFiles = [];
  try {
    const executable = compile(f.root,'pipe-parent.cs');
    const invoke = (args, timeout) => json(ok(adapter(f.root,{action:'process',executable,arguments:args,timeout})));
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
    const pids=pidFiles.filter(existsSync).map(file=>Number(readFileSync(file,'utf8')));
    ok(adapter(f.root,{action:'terminate-pipe-children',pids}));
    // Windows may release executable handles just after termination.
    await new Promise(resolve => setTimeout(resolve,100));
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
    const executable = compile(f.root, 'fixture-worker.cs'), path = join(f.root, 'locked');
    assert.equal(run(executable, ['status', '-1073741502']).status, 0xC0000142);
    assert.throws(() => run(executable, ['hold', path], { timeout: 700 }), { code: 'ETIMEDOUT' });
    assertStopped(path);
    const orphan = join(f.root, 'orphan');
    ok(run(executable, ['orphan', orphan])); assertStopped(orphan);
  } finally { f.dispose(); }
});

test('asynchronous fixtures release children after timeout, cancellation or owner termination', async () => {
  const f = fixture();
  try {
    const executable = compile(f.root, 'fixture-worker.cs');
    for (const mode of ['timeout', 'cancel', 'terminated']) {
      const path = join(f.root, mode), worker = startAdapter(f.root,
        { action: 'fixture-worker', executable, arguments: ['hold', path] }, { timeout: mode === 'timeout' ? 1800 : 15000 });
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
      assert.equal(existsSync(worker.marker.replace(/\.locked$/, '')), false);
    }
    const failing = startAdapter(f.root, { action: 'fixture-worker', executable, arguments: ['status', '-1073741502'] });
    assert.equal((await failing.result).status, 0xC0000142);
  } finally { f.dispose(); }
});

test('fixture disposal stops an unawaited worker before deleting its locked directory', async () => {
  const f = fixture();
  let worker, disposed = false;
  try {
    const executable = compile(f.root, 'fixture-worker.cs'), path = join(f.root, 'locked');
    worker = startAdapter(f.root, { action: 'fixture-worker', executable, arguments: ['hold', path] });
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
