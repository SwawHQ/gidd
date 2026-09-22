import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { compareVersions, managedExecutable, plainPath, platformName, versionPattern } from './storage.mjs';
import { minimums, toolEnvironment } from './tools.mjs';
import { runCommand } from './process.mjs';

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
    // PowerShell expands Windows short directory names when publishing paths.
    const managedPaths = [root,realpathSync.native(root)].map(base => resolve(base,name,managedExecutable(name)).toLowerCase());
    if (!tool || typeof tool.path !== 'string' || !isAbsolute(tool.path) || !tool.path.toLowerCase().endsWith('.exe') ||
        !['managed','path'].includes(tool.source) || !versionPattern.test(tool.version) ||
        (tool.source === 'managed' && (!managedPaths.includes(resolve(tool.path).toLowerCase()) ||
          !/^[a-f0-9]{64}$/.test(tool.record_sha256)))) throw new Error('tool_bindings_invalid');
  }
  return record;
}

export function boundTools(root, required = ['git','gh']) {
  const {tools} = readBindings(root);
  for (const name of required) if (!tools[name]) throw new Error('tool_binding_missing:' + name);
  for (const name of required) {
    if (compareVersions(tools[name].version,minimums[name]) < 0) throw new Error('tool_binding_incompatible:' + name);
  }
  return tools;
}

export function boundExecutor(bindings, execute = runCommand) {
  const env = toolEnvironment(bindings.git?.path);
  return async (executable,args,options={}) => {
    const result = await execute(executable,args,{...options,env: options.env ? toolEnvironment(bindings.git?.path, options.env) : env});
    if (result.reason === 'process_start_failed') {
      const name = Object.keys(bindings).find(name=>bindings[name].path === executable);
      throw new Error('tool_binding_unusable:' + (name || 'unknown'));
    }
    return result;
  };
}
