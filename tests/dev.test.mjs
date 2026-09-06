import { test } from 'bun:test';
import { cpSync, statSync } from 'node:fs';
import { adapter, assert, compile, existsSync, fixture, join, json, mkdirSync, ok, readFileSync, readdirSync, repo, run, snapshot, stub, write } from './support/helpers.mjs';

test('PowerShell sources have UTF-8 BOM before parsing', () => {
  const f=fixture();
  try {
    const paths=[];
    function visit(dir) {
      for (const entry of readdirSync(dir,{withFileTypes:true})) {
        const path=join(dir,entry.name);
        if (entry.isDirectory()) visit(path); else if (entry.name.endsWith('.ps1')) paths.push(path);
      }
    }
    for (const dir of ['scripts','skills/gidd/scripts','tests']) visit(join(repo,dir));
    assert.equal(json(ok(adapter(f.root,{action:'syntax',paths}))).checked,paths.length);
  } finally { f.dispose(); }
});

test('dev.cmd: help without runtimes, language selection, validation and explicit setup reuse', () => {
  const f=fixture();
  try {
    const checkout=join(f.root,'开发 repo & spaces'); mkdirSync(checkout);
    for (const path of ['dev.cmd','scripts/dev','skills/gidd/scripts/windows','skills/gidd/assets']) cpSync(join(repo,path),join(checkout,path),{recursive:true});
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
    for (const args of [['.help','invalid'],['.help','en','extra'],['.unknown'],['.info','extra'],['.test','unknown'],['.setup','relative-path'],['.test']]) {
      assert.notEqual(invoke(args).status,0,`Must reject: ${args.join(' ')}`);
    }
    const info=invoke(['.info']); assert.equal(info.status,1); assert.equal(json(info).bun.status,'missing');
    assert.deepEqual(snapshot(checkout),before,'Help, diagnostics and invalid commands must not install or write');
    const bin=join(f.root,'bin'); stub(compile(f.root),join(bin,'bun.exe'));
    ok(invoke(['.setup'],{PATH:bin}));
    assert.equal(existsSync(join(checkout,'.dev')),false,'External Bun reuse must not create development data');
    assert.equal(json(ok(invoke(['.info'],{PATH:bin}))).bun.details.path,join(bin,'bun.exe'));
    const localBun=join(checkout,'.dev/bun/bun.exe');
    stub(join(bin,'bun.exe'),localBun,undefined,true);
    const leftover=join(checkout,'.dev/.cache/bun/download.part'); write(leftover,'leftover after publication');
    ok(invoke(['.setup'])); assert.equal(existsSync(leftover),false,'Reuse must clean staging left after publication');
    assert.equal(existsSync(join(checkout,'.dev/.cache/install.lock')),true);
    const localInfo=json(ok(invoke(['.info'])));
    assert.equal(localInfo.bun.details.source,'checkout');
    // PowerShell may expand the temporary directory's Windows 8.3 alias.
    for (const [actual,expected] of [[localInfo.bun.details.path,localBun],[localInfo.tools_root,join(checkout,'.dev')]]) {
      const a=statSync(actual,{bigint:true}), b=statSync(expected,{bigint:true});
      assert.equal(a.dev,b.dev); assert.equal(a.ino,b.ino);
    }
    assert.equal(existsSync(join(checkout,'.dev/tools')),false,'Setup must use the flat development root');
    const occupied=join(checkout,'.dev/bun/user.txt'); write(occupied,'keep');
    const result=invoke(['.setup']); assert.notEqual(result.status,0); assert.match(result.stderr,/occupied_or_invalid_target/);
    assert.equal(readFileSync(occupied,'utf8'),'keep');
  } finally { f.dispose(); }
},60000);
