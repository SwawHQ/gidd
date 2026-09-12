import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireInstallLock, installTool, removeStage, resolveRelease, writeInstallationGuide } from './install.mjs';
import { compareVersions, hashFile, inspectToolTree, managedToolValid, resolveStorage } from './storage.mjs';
import { findTool, check, minimums } from './tools.mjs';
import { bindingPath, publishBinding, readBindings } from './bindings.mjs';
import { inspectEntryDestination, inspectRepositoryEntry, publishRepositoryEntry } from './repository-entry.mjs';

const reasonOf = error => /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : 'tool_preparation_failed';
export function bindingMatches(root,name,candidate) {
  try {
    const tool=readBindings(root).tools[name];
    return !!tool && tool.path.toLowerCase() === candidate.path.toLowerCase() && tool.version === candidate.version && tool.source === candidate.source &&
      (tool.source !== 'managed' || tool.record_sha256 === hashFile(join(root,name,'install.json')));
  } catch { return false; }
}

// Binding publication commits a replacement. A manifest hash distinguishes the
// new installation from the old one even though the executable path is unchanged.
export function recoverTool(root,name) {
  if (!['git','gh'].includes(name)) throw new Error('invalid_tool_name');
  const backup=join(root,'.cache','previous-'+name),target=join(root,name);
  if (!existsSync(backup)) return;
  if (!managedToolValid(backup,name,{allowDamaged:true})) throw new Error('unknown_tool_backup:' + name);
  let committed=false;
  try {
    const tool=readBindings(root).tools[name];
    committed=tool?.source === 'managed' && tool.path.toLowerCase() === resolve(root,name,name==='git'?'cmd/git.exe':'gh.exe').toLowerCase() &&
      managedToolValid(target,name) && tool.record_sha256 === hashFile(join(target,'install.json'));
  } catch {}
  if (committed) {
    const retired=join(root,'.cache',`retired-${name}-${randomUUID()}`);
    renameSync(backup,retired); inspectToolTree(retired); rmSync(retired,{recursive:true});
  } else {
    if (existsSync(target)) {
      if (!managedToolValid(target,name,{allowDamaged:true})) throw new Error('unknown_recovery_target:' + name);
      inspectToolTree(target); rmSync(target,{recursive:true});
    }
    renameSync(backup,target);
  }
}

export async function prepareTools(storage,{checkOnly=false,force=false,names=['git','gh'],readText,receive,onPhase=()=>{}}={}) {
  if(checkOnly && force)throw new Error('force_conflicts_with_check');
  if (names.some(name=>!['git','gh'].includes(name))) throw new Error('invalid_tool_name');
  const root=storage.tools_root,tools=[],checks=[]; let release;
  try {
    if (!checkOnly) { release=acquireInstallLock(root); writeInstallationGuide(root); }
    for (const name of names) {
      try {
        if (!checkOnly) recoverTool(root,name);
        let extraPaths=[];
        try { const bound=readBindings(root).tools[name]; if(bound?.source==='path' && existsSync(bound.path))extraPaths=[bound.path]; } catch {}
        let candidate=await findTool(name,{root,extraPaths});
        if (checkOnly) {
          checks.push(candidate);
          const pending=existsSync(join(root,'.cache','previous-'+name));
          const matches=candidate.status==='ready' && bindingMatches(root,name,candidate.details);
          checks.push(check(`binding.${name}`,!pending && matches?'ready':'invalid',pending?'tool_recovery_pending':matches?'bound_candidate_verified':'bootstrap_required'));
          continue;
        }
        let action='reused';
        if (force || candidate.status!=='ready') {
          const target=join(root,name),replace=existsSync(target);
          if (replace && !managedToolValid(target,name,{allowDamaged:true})) throw new Error('unknown_tool_ownership:' + name);
          const definition=await resolveRelease(name,storage.tools[name],null,readText);
          if(compareVersions(definition.version,minimums[name]) < 0)throw new Error('release_below_minimum:' + name);
          console.error('GIDD download: '+name+' '+definition.version+' '+definition.url);
          await installTool(root,definition,{receive,replace,onPhase:phase=>onPhase(name,phase)});
          action=force && replace?'reinstalled':replace?'repaired':'installed';
          candidate=await findTool(name,{root,source:'managed'});
          if(candidate.status!=='ready') throw new Error('post_install_check_failed:' + name);
        }
        const binding=publishBinding(root,name,candidate.details);
        await onPhase(name,'bound');
        tools.push({name,action,path:candidate.details.path,binding_action:binding});
        checks.push(candidate,check(`binding.${name}`,'ready','bound_candidate_verified'));
        recoverTool(root,name); removeStage(root,name);
      } catch(error) {
        checks.push(check('tool.'+name,'invalid',reasonOf(error)));
        // Recover uncommitted replacements where possible. Never undo a binding
        // already committed; recovery can leave an explicit error for next time.
        if (!checkOnly) try { recoverTool(root,name); } catch(recovery) { checks.push(check('recovery.'+name,'invalid',reasonOf(recovery))); }
      }
    }
  } finally {release?.();}
  return {schema:'gidd.bootstrap-tools/v1',status:checks.every(c=>c.status==='ready')?'ready':'needs_bootstrap',read_only:checkOnly,
    tools,checks,tools_root:root,binding_path:bindingPath(root)};
}

async function main(args) {
  let repository,checkOnly=false,force=false,runtimeReport=false,repositoryEntry=false; const seen=new Set();
  for(let i=0;i<args.length;i++) {
    const arg=args[i]; if(seen.has(arg))throw new Error('invalid_arguments');seen.add(arg);
    if(arg==='--check')checkOnly=true;
    else if(arg==='--force')force=true;
    else if(arg==='--runtime-report')runtimeReport=true;
    else if(arg==='--repository-entry')repositoryEntry=true;
    else if(arg==='--repository' && args[i+1])repository=args[++i];
    else throw new Error('invalid_arguments');
  }
  const runtime=runtimeReport?JSON.parse(readFileSync(0,'utf8').replace(/^\uFEFF/,'')):null;
  let tools,entry,repositoryCheck;
  try {
    const storage=resolveStorage(repository);
    if (repositoryEntry) {
      if (checkOnly || !repository || !runtime || runtime.status!=='ready') throw new Error('invalid_arguments');
      inspectEntryDestination(repository);
      tools=await prepareTools(storage,{force,names:['git']});
      if (tools.status==='ready') {
        const git=readBindings(storage.tools_root).tools.git.path;
        repositoryCheck=await inspectRepositoryEntry(repository,git,storage.github);
        const gh=await prepareTools(storage,{force,names:['gh']});
        tools={...tools,status:gh.status,tools:[...tools.tools,...gh.tools],checks:[...tools.checks,...gh.checks]};
        if (tools.status==='ready') {
          // Recheck after preparation, before publishing a repository entry.
          repositoryCheck=await inspectRepositoryEntry(repository,git,storage.github);
          entry=publishRepositoryEntry(repository);
        }
      }
    } else tools=await prepareTools(storage,{checkOnly,force});
  } catch(error) {
    const failure=check(repositoryEntry?'repository.entry':'tools.storage','invalid',reasonOf(error));
    tools={...tools,status:'needs_bootstrap',tools:tools?.tools || [],checks:[...(tools?.checks || []),failure]};
  }
  const report=runtime?{...runtime,status:runtime.status==='ready' && tools.status==='ready'?'ready':'needs_tools',
    tools:tools.tools,tool_checks:tools.checks,binding_path:tools.binding_path}:tools;
  if (repositoryEntry) {
    report.repository=repository;
    report.entry=entry || {status:'not_published'};
    if (repositoryCheck) report.repository_check=repositoryCheck;
    if (entry) report.message=`已为目标仓库准备专用入口 ${entry.path}。可在任意工作目录调用，仓库操作固定针对 ${repository}；共享工具和认证不属于单个仓库。`;
  }
  console.log(JSON.stringify(report));return report.status==='ready'?0:1;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.exitCode=await main(process.argv.slice(2));}
  catch(error){console.log(JSON.stringify({schema:'gidd.tools/v1',status:'error',reason:reasonOf(error)}));process.exitCode=2;}
}
