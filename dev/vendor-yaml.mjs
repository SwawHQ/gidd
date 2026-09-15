// Run with dev.cmd bun dev/vendor-yaml.mjs. End users do not run this build.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.versions.bun) throw new Error('Run this build with Bun.');
const version = '2.9.1';
const stage = mkdtempSync(join(tmpdir(), 'gidd-yaml-build-'));
const vendor = fileURLToPath(new URL('../.agents/skills/gidd/scripts.js/vendor/', import.meta.url));
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: stage, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error('yaml_build_failed');
};
try {
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ private: true, dependencies: { yaml: version } }));
  run(['install', '--ignore-scripts']);
  writeFileSync(join(stage, 'entry.mjs'), "export { parseDocument, stringify } from './node_modules/yaml/browser/index.js';\n");
  mkdirSync(vendor, { recursive: true });
  run(['build', './entry.mjs', '--target', 'browser', '--format', 'esm', '--outfile', join(vendor, 'yaml.mjs')]);
  copyFileSync(join(stage, 'node_modules/yaml/LICENSE'), join(vendor, 'yaml.LICENSE'));
} finally {
  if (dirname(resolve(stage)) !== resolve(tmpdir()) || !basename(stage).startsWith('gidd-yaml-build-')) {
    throw new Error('unexpected_yaml_build_directory');
  }
  rmSync(stage, { recursive: true, force: true });
}
