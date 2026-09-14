import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedToolValid, resolveStorage } from '../../.agents/skills/gidd/scripts/storage.mjs';
import { findTool } from '../../.agents/skills/gidd/scripts/tools.mjs';
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
try {
  let result;
  switch (request.action) {
    case 'configuration': result = resolveStorage(request.repositoryRoot); break;
    case 'validate': result = managedToolValid(request.root, request.name); break;
    case 'find': result = await findTool(request.name, { root: request.managedPath ? join(request.managedPath, '../..') : '', minimum: request.minimum.split('.').concat(['0','0']).slice(0,3).join('.') }); break;
    default: throw new Error('unknown_fixture_action');
  }
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
