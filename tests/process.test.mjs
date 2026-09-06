import { test } from 'node:test';
import { adapter, assert, compile, existsSync, fixture, join, json, ok, readFileSync } from './support/helpers.mjs';

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
