// Rebuild with dev.cmd bun dev/vendor-skill.mjs. Tests do not need an install step.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.versions.bun) throw new Error('Run this build with Bun.');
const packages = [
  { name: 'js-yaml', version: '5.4.3', integrity: 'sha512-yzzNtgczwgoVHNigCyKTXcQJU4Y8t/ikU4UxXW0BvrLfHTGWZhsNcOT2s/a7vn81/4KqVnNmHjaUEPlvWnNwVw==' },
  { name: 'marked', version: '18.1.0', integrity: 'sha512-PamYXWWWg2nboG3oX5Ffzpy3EFZROqZJK9hSlMmUnekp7TxPs5DcT95vwd46m73/exfKCRVMtgXoPMI4FEJL6w==' },
];
const stage = mkdtempSync(join(tmpdir(), 'gidd-skill-build-'));
const vendor = fileURLToPath(new URL('./vendor/', import.meta.url));
const run = args => {
  const result = spawnSync(process.execPath, args, {
    cwd: stage, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(stage, 'cache') },
  });
  if (result.error || result.status !== 0) throw result.error || new Error('skill_parser_build_failed');
};
try {
  const dependencies = {};
  for (const { name, version, integrity } of packages) {
    const response = await fetch(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
    if (!response.ok) throw new Error(`Download failed: ${name}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) {
      throw new Error(`Package integrity mismatch: ${name}`);
    }
    writeFileSync(join(stage, `${name}.tgz`), bytes);
    dependencies[name] = `file:./${name}.tgz`;
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ private: true, dependencies }));
  run(['install', '--ignore-scripts']);
  writeFileSync(join(stage, 'entry.mjs'), "export { load as loadYaml } from 'js-yaml';\nexport { lexer as lexMarkdown, walkTokens } from 'marked';\n");
  run(['build', './entry.mjs', '--target', 'browser', '--format', 'esm', '--outfile', 'skill-parsers.mjs']);
  mkdirSync(vendor, { recursive: true });
  copyFileSync(join(stage, 'skill-parsers.mjs'), join(vendor, 'skill-parsers.mjs'));
  for (const { name } of packages) {
    copyFileSync(join(stage, 'node_modules', name, 'LICENSE'), join(vendor, `${name}.LICENSE`));
  }
} finally {
  if (dirname(resolve(stage)) !== resolve(tmpdir()) || !basename(stage).startsWith('gidd-skill-build-')) {
    throw new Error('unexpected_skill_build_directory');
  }
  rmSync(stage, { recursive: true, force: true });
}
