// Run with dev.cmd bun dev/vendor-toml.mjs. No install step is needed by users.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.versions.bun) throw new Error('Run this build with Bun.');
const version = '1.7.2';
const stage = mkdtempSync(join(tmpdir(), 'gidd-toml-build-'));
const vendor = fileURLToPath(new URL('../.agents/skills/gidd/scripts.js/vendor/', import.meta.url));
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: stage, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error('toml_build_failed');
};
try {
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ private: true, dependencies: { 'smol-toml': version } }));
  run(['install', '--ignore-scripts']);
  writeFileSync(join(stage, 'entry.mjs'), "export { parse, stringify } from './node_modules/smol-toml/dist/index.js';\n");
  mkdirSync(vendor, { recursive: true });
  run(['build', './entry.mjs', '--target', 'browser', '--format', 'esm', '--outfile', join(vendor, 'toml.mjs')]);
  copyFileSync(join(stage, 'node_modules/smol-toml/LICENSE'), join(vendor, 'toml.LICENSE'));
} finally {
  if (dirname(resolve(stage)) !== resolve(tmpdir()) || !basename(stage).startsWith('gidd-toml-build-')) throw new Error('unexpected_toml_build_directory');
  rmSync(stage, { recursive: true, force: true });
}
