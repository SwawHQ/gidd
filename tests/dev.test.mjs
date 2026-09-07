import { test } from 'node:test';
import { cpSync, statSync } from 'node:fs';
import { adapter, assert, compile, dirname, existsSync, fixture, join, json, mkdirSync, ok, readFileSync, readdirSync, repo, run, snapshot, stub, write } from './support/helpers.mjs';

test('PowerShell sources have UTF-8 BOM before parsing', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const paths=[];
    function visit(dir) {
      for (const entry of readdirSync(dir,{withFileTypes:true})) {
        const path=join(dir,entry.name);
        if (entry.isDirectory()) visit(path); else if (entry.name.endsWith('.ps1')) paths.push(path);
      }
    }
    for (const dir of ['scripts','.agents/skills/gidd/scripts','tests']) visit(join(repo,dir));
    assert.equal(json(ok(adapter(f.root,{action:'syntax',paths}))).checked,paths.length);
  } finally { f.dispose(); }
});

test('test command executes every suite and propagates failures', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const runner=join(f.root,'scripts/dev/dev.mjs');
    write(runner,readFileSync(join(repo,'scripts/dev/dev.mjs'),'utf8'));
    for (const suite of ['doctor','setup','process','dev','config','github','entry']) {
      const marker=join(f.root,`${suite}.ran`);
      write(join(f.root,`tests/${suite}.test.mjs`),
        `import {test} from 'node:test'; import {writeFileSync} from 'node:fs';\ntest('${suite}', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); ${suite === 'setup' ? "throw new Error('expected fixture failure');" : ''} });\n`);
    }
    const result=run(process.execPath,[runner,'.test']);
    assert.equal(result.status,1,'A failing suite must fail the command');
    assert.match(result.stdout,/Suite summary: 6 passed, 1 failed/);
    assert.match(result.stdout,/FAIL tests\/setup.test.mjs \(\d+\.\d+s\)/);
    assert.match(result.stdout,/Rerun \(PowerShell\): .*\.test-(bun|node) setup/);
    for (const suite of ['doctor','setup','process','dev','config','github','entry']) {
      assert.equal(existsSync(join(f.root,`${suite}.ran`)),true,`${suite} must actually execute, including after a failure`);
    }
    const selected=ok(run(process.execPath,[runner,'.test','doctor']));
    assert.match(selected.stdout,/Suite summary: 1 passed, 0 failed/);
    assert.doesNotMatch(selected.stdout,/Rerun \(PowerShell\):/);
    assert.notEqual(run(process.execPath,[runner,'.test','unknown']).status,0);
    assert.notEqual(run(process.execPath,[runner,'.test-live',f.root]).status,0);
  } finally { f.dispose(); }
});

test('dev.cmd: help without runtimes, language selection, validation and explicit setup reuse', { timeout: 120000 }, () => {
  const f=fixture();
  try {
    const checkout=join(f.root,'开发 repo & spaces'); mkdirSync(checkout);
    for (const path of ['dev.cmd','scripts/dev','.agents/skills/gidd/scripts/windows','.agents/skills/gidd/assets']) cpSync(join(repo,path),join(checkout,path),{recursive:true});
    const entry=join(checkout,'dev.cmd'), cmd=join(process.env.SystemRoot || process.env.SYSTEMROOT,'System32/cmd.exe');
    const invoke=(args, env={}) => run(cmd,['/d','/s','/c',`""${entry}" ${args.join(' ')}"`],{
      cwd:f.root,windowsVerbatimArguments:true,env:{PATH:'',GIDD_DEV_LANG:'',LC_ALL:'en_US.UTF-8',...env},
    });
    const before=snapshot(checkout);
    assert.match(ok(invoke(['.help','zh'])).stdout,/仓库开发/);
    assert.match(ok(invoke(['.help','en'])).stdout,/repository development/);
    assert.match(ok(invoke([],{GIDD_DEV_LANG:'zh-CN'})).stdout,/仓库开发/);
    assert.match(ok(invoke(['.help','en'],{GIDD_DEV_LANG:'zh-CN'})).stdout,/repository development/);
    assert.match(ok(invoke([],{LC_ALL:'zh_CN.UTF-8'})).stdout,/仓库开发/);
    for (const args of [['.help','invalid'],['.help','en','extra'],['.unknown'],['.info','extra'],['.test','unknown'],['.setup','relative-path'],['.test-live',`"${f.root}"`],['.test']]) {
      assert.notEqual(invoke(args).status,0,`Must reject: ${args.join(' ')}`);
    }
    const info=invoke(['.info']); assert.equal(info.status,1); assert.equal(json(info).bun.status,'missing');
    assert.deepEqual(snapshot(checkout),before,'Help, diagnostics and invalid commands must not install or write');
    const bin=join(f.root,'bin'); stub(compile(f.root),join(bin,'bun.exe'));
    const bunOnly=invoke(['.info'],{PATH:bin}); assert.equal(bunOnly.status,1); assert.equal(json(bunOnly).node.status,'missing');
    assert.match(invoke(['.test'],{PATH:bin}).stderr,/node unavailable/);
    stub(join(bin,'bun.exe'),join(bin,'node.exe'));
    ok(invoke(['.setup'],{PATH:bin}));
    const failedRuntimes=invoke(['.test','config'],{PATH:bin});
    assert.equal(failedRuntimes.status,1);
    assert.match(failedRuntimes.stdout,/Runtime summary:[\s\S]*FAIL bun[\s\S]*FAIL node[\s\S]*exit 1/);
    assert.equal(existsSync(join(checkout,'.dev')),false,'External runtime reuse must not create development data');
    assert.equal(json(ok(invoke(['.info'],{PATH:bin}))).bun.details.path,join(bin,'bun.exe'));
    const localBun=join(checkout,'.dev/bun/bun.exe');
    stub(join(bin,'bun.exe'),localBun,undefined,true);
    const localNode=join(checkout,'.dev/node/node.exe');
    stub(join(bin,'node.exe'),localNode,undefined,true);
    const leftover=join(checkout,'.dev/.cache/bun/download.part'); write(leftover,'leftover after publication');
    const nodeLeftover=join(checkout,'.dev/.cache/node/download.part'); write(nodeLeftover,'leftover after publication');
    ok(invoke(['.setup'])); assert.equal(existsSync(leftover),false,'Reuse must clean staging left after publication');
    assert.equal(existsSync(nodeLeftover),false);
    assert.equal(existsSync(join(checkout,'.dev/.cache/install.lock')),true);
    const localInfo=json(ok(invoke(['.info'])));
    assert.equal(localInfo.bun.details.source,'managed');
    assert.equal(localInfo.node.details.source,'managed');
    // PowerShell may expand the temporary directory's Windows 8.3 alias.
    for (const [actual,expected] of [[localInfo.bun.details.path,localBun],[localInfo.node.details.path,localNode],[localInfo.tools_root,join(checkout,'.dev')]]) {
      const a=statSync(actual,{bigint:true}), b=statSync(expected,{bigint:true});
      assert.equal(a.dev,b.dev); assert.equal(a.ino,b.ino);
    }
    assert.equal(existsSync(join(checkout,'.dev/tools')),false,'Setup must use the flat development root');
    const occupied=join(checkout,'.dev/bun/user.txt'); write(occupied,'keep');
    const result=invoke(['.setup']); assert.notEqual(result.status,0); assert.match(result.stderr,/occupied_or_version_conflicting_target/);
    assert.equal(readFileSync(occupied,'utf8'),'keep');
    const config=join(checkout,'.agents/skills/gidd/config.toml');
    const configuredRoot=join(checkout,'.devv');
    write(config,'# retain this comment\nschema_version = 1\n[tools]\ndirectory = ".devv"\n');
    stub(join(bin,'bun.exe'),join(configuredRoot,'bun/bun.exe'),undefined,true);
    stub(join(bin,'node.exe'),join(configuredRoot,'node/node.exe'),undefined,true);
    ok(invoke(['.setup']));
    const configuredInfo=json(ok(invoke(['.info'])));
    assert.equal(configuredInfo.storage.configured,true);
    assert.equal(statSync(configuredInfo.tools_root,{bigint:true}).ino,statSync(configuredRoot,{bigint:true}).ino);
    assert.equal(existsSync(join(configuredRoot,'INSTALLATION.md')),true);
    assert.equal(readFileSync(occupied,'utf8'),'keep','Switching config must preserve old storage');
    assert.match(readFileSync(config,'utf8'),/^# retain this comment/);
    const configuredText=readFileSync(config,'utf8');
    write(config,configuredText+'node = { version = "24.0.1", source = "https://nodejs.org/dist" }\n');
    const mismatch=json(invoke(['.info']));
    assert.equal(mismatch.node.status,'invalid');
    assert.ok(mismatch.node.details.rejected.some(x=>x.reason==='configured_version_mismatch'));
    assert.match(invoke(['.setup']).stderr,/occupied_or_version_conflicting_target:node/);
    assert.equal(readFileSync(join(configuredRoot,'node/install.json'),'utf8').includes('24.0.0'),true);
    write(config,'invalid = true');
    assert.notEqual(invoke(['.setup']).status,0); assert.notEqual(invoke(['.info']).status,0);
    assert.match(ok(invoke(['.help','en'])).stdout,/repository development/);
  } finally { f.dispose(); }
});

test('dev.cmd .setup selects one tool, reuses gh and rejects local package inputs', () => {
  const f = fixture();
  try {
    const checkout = join(f.root, 'repo with spaces');
    for (const path of ['dev.cmd','scripts/dev','.agents/skills/gidd/scripts/windows','.agents/skills/gidd/assets']) cpSync(join(repo,path),join(checkout,path),{recursive:true});
    const cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
    const invoke = (args = '', path = '', tool = 'gh') => run(cmd, ['/d','/s','/c', `""${join(checkout,'dev.cmd')}" .setup ${tool} ${args}"`], { windowsVerbatimArguments:true, env:{PATH:path} });
    assert.notEqual(invoke('relative-path').status, 0);
    assert.notEqual(invoke('', '', 'unknown').status, 0);
    assert.notEqual(invoke('one two').status, 0);
    assert.notEqual(invoke(`"${f.root}"`).status, 0);
    const exe = compile(f.root), bin = join(f.root,'bin');
    stub(exe, join(bin,'gh.exe'));
    assert.match(ok(invoke('',bin)).stdout, /gh 2\.98\.0:/);
    assert.equal(existsSync(join(checkout,'.dev')), false, 'PATH reuse must not create tool storage');
    for (const name of ['bun','node']) {
      const selectedBin = join(f.root,name);
      stub(exe,join(selectedBin,`${name}.exe`));
      const selected = ok(invoke('',selectedBin,name));
      assert.match(selected.stdout,new RegExp(`^${name} `));
      assert.equal(existsSync(join(checkout,'.dev')),false,'A selected runtime must not install other missing tools');
    }
    const config = join(checkout,'.agents/skills/gidd/config.toml');
    const configText = 'schema_version = 1\n[tools]\ndirectory = ".chosen-tools"\ngh = { version = "2.98.0", source = "https://github.com/cli/cli/releases" }\n';
    write(config,configText);
    const tools = join(checkout,'.chosen-tools');
    stub(exe,join(tools,'gh/gh.exe'),undefined,true);
    assert.match(ok(invoke()).stdout, /gh 2\.98\.0:/);
    assert.equal(existsSync(join(tools,'gh/gh.exe')), true);
    for (const name of ['bun','node','.cache/gh']) assert.equal(existsSync(join(tools,name)), false);
    assert.equal(readFileSync(config,'utf8'),configText);
    ok(invoke());
    write(config,configText.replace('2.98.0','2.99.0'));
    assert.match(invoke().stderr,/occupied_or_version_conflicting_target:gh/);
    assert.equal(JSON.parse(readFileSync(join(tools,'gh/install.json'),'utf8')).version,'2.98.0');
  } finally { f.dispose(); }
});

test('dev.cmd bun/node forwards argv, stdin, cwd and exit code using the selected runtime', { timeout: 60000 }, () => {
  const f = fixture();
  try {
    const checkout = join(f.root, '开发 repo & spaces');
    for (const path of ['dev.cmd','scripts/dev','.agents/skills/gidd/scripts/windows','.agents/skills/gidd/assets']) cpSync(join(repo, path), join(checkout, path), { recursive: true });
    const config = join(checkout, '.agents/skills/gidd/config.toml');
    write(config, 'schema_version = 1\n[tools]\ndirectory = ".fixture-tools"\n');
    const name = process.versions.bun ? 'bun' : 'node', other = name === 'bun' ? 'node' : 'bun';
    const script = join(f.root, 'script with spaces.mjs');
    write(script, "import {readFileSync} from 'node:fs'; console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),exe:process.execPath,input:readFileSync(0,'utf8')})); console.error('fixture stderr'); process.exit(17);");
    const entry = join(checkout, 'dev.cmd'), cmd = join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/cmd.exe');
    const invoke = (args, input = '') => run(cmd, ['/d','/s','/c', `""${entry}" ${args}"`], {
      cwd: f.root, input, windowsVerbatimArguments: true, env: { PATH: dirname(process.execPath) },
    });
    assert.notEqual(invoke(`${other} --version`).status, 0, 'Only the selected runtime is required');
    assert.equal(existsSync(join(checkout, '.fixture-tools')), false);
    assert.notEqual(invoke(`${name} --version`).status, 0, 'Portable mode must not use an available PATH runtime');
    assert.notEqual(invoke('sys').status, 0);
    assert.notEqual(invoke('sys unknown').status, 0);
    const result = invoke(`sys ${name} "${script}" "two words" "" --Argument --help "tail\\\\" - "a & b"`, 'stdin fixture');
    assert.equal(result.status, 17, result.stderr);
    const output = json(result);
    assert.deepEqual(output.args, ['two words', '', '--Argument', '--help', 'tail\\', '-', 'a & b']);
    assert.equal(statSync(output.cwd, { bigint: true }).ino, statSync(f.root, { bigint: true }).ino);
    assert.equal(output.input, 'stdin fixture');
    assert.match(result.stderr, /fixture stderr/);
    assert.equal(existsSync(join(checkout, '.fixture-tools')), false, 'Forwarding must not install');
    const evaluated = ok(invoke(`sys ${name} -e "console.log('evaluation works')"`));
    assert.match(evaluated.stdout, /evaluation works/);
    const inputScript = "console.log('stdin script works'); process.exit(19);";
    const systemInput = invoke(`sys ${name} -`, inputScript);
    assert.equal(systemInput.status, 19, systemInput.stderr);
    assert.match(systemInput.stdout, /stdin script works/);
    // A real managed executable wins over the same runtime on PATH.
    const managed = join(checkout, `.fixture-tools/${name}/${name}.exe`);
    stub(process.execPath, managed, undefined, true);
    const managedInput = invoke(`${name} -`, inputScript);
    assert.equal(managedInput.status, 19, managedInput.stderr);
    assert.match(managedInput.stdout, /stdin script works/);
    const selected = json(invoke(`${name} "${script}"`));
    assert.equal(statSync(selected.exe, { bigint: true }).ino, statSync(managed, { bigint: true }).ino);
    const system = json(invoke(`sys ${name} "${script}" --system sys`));
    assert.equal(statSync(system.exe, { bigint: true }).ino, statSync(process.execPath, { bigint: true }).ino);
    assert.deepEqual(system.args, ['--system', 'sys'], 'Only the command prefix selects the runtime source');
    const missingSystem = run(cmd, ['/d','/s','/c', `""${entry}" sys ${name} --version"`], {
      cwd: f.root, windowsVerbatimArguments: true, env: { PATH: '' },
    });
    assert.notEqual(missingSystem.status, 0, 'System mode must not fall back to the valid portable runtime');
    const extra = join(dirname(managed), 'unexpected.txt'); write(extra, 'keep this file');
    assert.notEqual(invoke(`${name} --version`).status, 0, 'Damaged managed storage must not fall back to PATH');
    assert.equal(readFileSync(extra, 'utf8'), 'keep this file');
    assert.equal(invoke(`sys ${name} --version`).status, 0, 'System mode does not validate portable runtime integrity');
  } finally { f.dispose(); }
});
