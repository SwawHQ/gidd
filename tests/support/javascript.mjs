import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireInstallLock, installTool, removeStage, resolveRelease, writeInstallationGuide } from '../../.agents/skills/gidd/scripts/install.mjs';
import { managedToolValid, resolveStorage } from '../../.agents/skills/gidd/scripts/storage.mjs';
import { findTool } from '../../.agents/skills/gidd/scripts/tools.mjs';
import { prepareTools } from '../../.agents/skills/gidd/scripts/bootstrap-tools.mjs';
const path = process.argv[2], request = JSON.parse(readFileSync(path,'utf8'));
let release;
try {
  let result;
  switch (request.action) {
    case 'prepare': result = await prepareTools(request.root ? {tools_root:request.root,tools:resolveStorage(request.repositoryRoot).tools} : resolveStorage(request.repositoryRoot),{
      names:request.names,checkOnly:request.checkOnly,
      readText:request.responses ? async url=>{if(!(url in request.responses))throw new Error('unexpected_metadata_request');return request.responses[url];}:undefined,
      receive:request.downloads ? async url=>{if(!(url in request.downloads))throw new Error('unexpected_download');return readFileSync(request.downloads[url]);}:undefined,
      onPhase:(name,phase)=>{if(phase===request.stopAt)process.kill(process.pid,'SIGKILL');},
    });
      if(result.status !== 'ready') process.exitCode=1;
      break;
    case 'configuration': result = resolveStorage(request.repositoryRoot); break;
    case 'release': result = await resolveRelease(request.name,{ version: request.version, source: request.source },
      request.pinnedPath ? JSON.parse(readFileSync(request.pinnedPath,'utf8')) : null,
      request.responses ? async url => { if (!(url in request.responses)) throw new Error(`unexpected_metadata_request:${url}`); return request.responses[url]; } : undefined); break;
    case 'validate': result = managedToolValid(request.root,request.name); break;
    case 'find': result = await findTool(request.name,{ root: request.managedPath ? join(request.managedPath,'../..') : '', minimum: request.minimum.split('.').concat(['0','0']).slice(0,3).join('.') }); break;
    case 'stage': removeStage(request.root,request.name); break;
    case 'guide': release = acquireInstallLock(request.root); writeInstallationGuide(request.root); break;
    case 'install': {
      const definition = JSON.parse(readFileSync(request.definitionPath,'utf8'));
      release = acquireInstallLock(request.root);
      if (request.stopAt === 'locked') { writeFileSync(path+'.locked','locked'); await new Promise(resolve => setTimeout(resolve,30000)); }
      const files = new Map([[definition.url,definition.archive], ...(definition.supplements || []).map(file => [file.url,`${definition.name}-${definition.version}-${file.name}`])]);
      result = await installTool(request.root,definition,{
        receive: request.fixtureDirectory ? async url => { if (!files.has(url)) throw new Error(`unexpected_download:${url}`); return readFileSync(join(request.fixtureDirectory,files.get(url))); } : undefined,
        onPhase: phase => { if (phase === request.stopAt) process.kill(process.pid,'SIGKILL'); },
      }); break;
    }
    default: throw new Error('unknown_fixture_action');
  }
  if (result !== undefined) console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { release?.(); }
