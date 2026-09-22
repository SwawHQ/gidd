import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { toolsRoot, managedExecutable } from '../../../shared/storage.mjs';
import { check } from '../shared/result.mjs';

export const id = 'tool.js_runtime';
function managedRuntime(name) {
  try {
    const actual = realpathSync.native(process.execPath);
    const expected = resolve(realpathSync.native(toolsRoot()), name, managedExecutable(name));
    return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  } catch { return false; }
}
export function run() {
  const name = process.versions.bun ? 'bun' : 'node';
  return check(id, 'ready', undefined, { name, path: process.execPath,
    version: process.versions.bun || process.versions.node, gidd_managed: managedRuntime(name) });
}
