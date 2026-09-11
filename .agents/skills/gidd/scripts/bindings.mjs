import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { durableFile } from './install.mjs';
import { compareVersions, hashFile, managedExecutable, plainPath, platformName, versionPattern } from './storage.mjs';
import { minimums, toolEnvironment } from './tools.mjs';
import { runCommand } from './github.mjs';

export const bindingPath = root => join(root, 'tool-bindings.json');
export function readBindings(root) {
  const path = bindingPath(root); plainPath(path);
  if (!existsSync(path)) throw new Error('tool_bindings_missing');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 65536) throw new Error('tool_bindings_invalid');
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('tool_bindings_invalid'); }
  if (record?.schema !== 'gidd.tool-bindings/v1' || record.platform !== platformName() ||
      !record.tools || typeof record.tools !== 'object' || Array.isArray(record.tools) ||
      Object.keys(record.tools).some(name => !['git','gh'].includes(name))) throw new Error('tool_bindings_invalid');
  for (const [name, tool] of Object.entries(record.tools)) {
    if (!tool || typeof tool.path !== 'string' || !isAbsolute(tool.path) || !tool.path.toLowerCase().endsWith('.exe') ||
        !['managed','path'].includes(tool.source) || !versionPattern.test(tool.version) ||
        (tool.source === 'managed' && (resolve(tool.path).toLowerCase() !== resolve(root,name,managedExecutable(name)).toLowerCase() ||
          !/^[a-f0-9]{64}$/.test(tool.record_sha256)))) throw new Error('tool_bindings_invalid');
  }
  return record;
}

// The caller holds the shared installation lock and has verified the candidate.
export function publishBinding(root, name, candidate) {
  let record;
  try { record = readBindings(root); }
  catch (error) {
    if (!['tool_bindings_missing','tool_bindings_invalid'].includes(error.message)) throw error;
    const path = bindingPath(root);
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 65536) throw error;
      // Preserve damaged generated data before rebuilding it.
      durableFile(join(root,'.cache',`bindings-invalid-${randomUUID()}.json`),readFileSync(path));
    }
    record = { schema:'gidd.tool-bindings/v1', platform:platformName(), tools:{} };
  }
  const tool = { path:candidate.path, source:candidate.source, version:candidate.version };
  if (tool.source === 'managed') tool.record_sha256 = hashFile(join(root,name,'install.json'));
  record.tools[name] = tool;
  const path = bindingPath(root), text = JSON.stringify(record);
  if (existsSync(path) && readFileSync(path,'utf8') === text) return 'reused';
  const temporary = join(root,`.tool-bindings-${randomUUID()}.tmp`);
  try { durableFile(temporary,text); renameSync(temporary,path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return 'published';
}

export function boundTools(root, required = ['git','gh']) {
  const {tools} = readBindings(root);
  for (const name of required) if (!tools[name]) throw new Error('tool_binding_missing:' + name);
  for (const [name,tool] of Object.entries(tools)) {
    if (compareVersions(tool.version,minimums[name]) < 0) throw new Error('tool_binding_incompatible:' + name);
  }
  return tools;
}

export function boundExecutor(bindings, execute = runCommand) {
  const env = toolEnvironment(bindings.git?.path);
  return async (executable,args,options={}) => {
    const result = await execute(executable,args,{...options,env});
    if (result.reason === 'process_start_failed') {
      const name = Object.keys(bindings).find(name=>bindings[name].path === executable);
      throw new Error('tool_binding_unusable:' + (name || 'unknown'));
    }
    return result;
  };
}
