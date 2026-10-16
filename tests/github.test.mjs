import { test } from 'node:test';
import { runCommand } from '../.agents/skills/gidd/scripts.js/shared/process.mjs';
import { assert, existsSync, fixture, join, nodeExecutable, readFileSync, repo, support, until, write } from './support/helpers.mjs';

test('JS execution requires binary paths and preserves literal arguments without a shell', async () => {
  const f=fixture();
  try {
    const marker=join(f.root,'wrapper-started');
    for(const extension of ['cmd','bat','ps1']) {
      const wrapper=join(f.root,'tool.'+extension);
      write(wrapper,extension==='ps1' ? `Set-Content -LiteralPath '${marker}' -Value started` : `@echo started>"${marker}"\r\n`);
      assert.deepEqual(await runCommand(wrapper,[]),{ok:false,reason:'absolute_binary_required',text:''});
    }
    for(const name of ['git','gh.exe']) assert.equal((await runCommand(name,['--version'])).reason,'absolute_binary_required');
    assert.equal(existsSync(marker),false);
    const args=['','two words','a & b','a|b','a>b','%PATH%','!literal!','two "quotes"','tail\\','中文'];
    const result=await runCommand(process.execPath,['-e','console.log(JSON.stringify(process.argv.slice(1)))','--',...args]);
    assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(JSON.parse(result.text),args);
  } finally {f.dispose();}
});

test('process adapter bounds hangs and output, redacts failures and isolates repository overrides', { timeout: 15000 }, async () => {
  const common = { cwd: repo, timeoutMs: 5000 };
  const result = await runCommand(process.execPath, ['-e', 'console.log(JSON.stringify({dir:process.env.GIT_DIR,prompt:process.env.GIT_TERMINAL_PROMPT,gcm:process.env.GCM_INTERACTIVE,profile:process.env.GH_CONFIG_DIR}))'],
    { ...common, env: { ...process.env, GIT_DIR: 'wrong-repository', GH_CONFIG_DIR: 'chosen-profile' } });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.text), { prompt: '0', gcm: 'never', profile: 'chosen-profile' });
  const secret = await runCommand(process.execPath, ['-e', 'console.error("ghp_PRIVATE_TOKEN");console.log("PRIVATE_TOKEN");process.exit(1)'], common);
  assert.deepEqual(secret, { ok: false, reason: 'command_failed', text: '' });
  const started = performance.now();
  assert.equal((await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...common, timeoutMs: 250 })).reason, 'process_timeout');
  assert.ok(performance.now() - started < 2500);
  assert.equal((await runCommand(process.execPath, ['-e', 'console.log("x".repeat(1100000))'], common)).reason, 'output_limit');
  assert.equal((await runCommand(join(repo, 'does-not-exist.exe'), [], common)).reason, 'process_start_failed');
});

test('GitHub subprocess deadline also covers pipes inherited by descendants', { timeout: 15000 }, async () => {
  const f = fixture(), pidFiles = [];
  try {
    const exe = nodeExecutable(), script = join(support, 'pipe-parent.mjs');
    for (const delay of [0, 200]) {
      const pid = join(f.root, `${delay}.pid`); pidFiles.push(pid);
      const started = performance.now();
      const result = await runCommand(exe, [script, String(delay), pid], { cwd: f.root, timeoutMs: 500 });
      assert.equal(result.reason, 'process_timeout');
      assert.equal(result.text, '');
      assert.ok(performance.now() - started < 1500, 'Child-held pipes must not extend the deadline');
    }
  } finally {
    for (const path of pidFiles.filter(existsSync)) {
      const pid = Number(readFileSync(path, 'utf8'));
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    }
    // Windows can release the process's directory handle just after termination.
    await new Promise(resolve => setTimeout(resolve, 100));
    f.dispose();
  }
});
