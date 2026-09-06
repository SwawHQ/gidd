import { spawnSync } from 'node:child_process';

// The launcher selected this runtime. Keep the caller's cwd, environment and
// stdio; shell=false forwards decoded arguments without reinterpreting code.
const args = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
  console.error('Invalid runtime arguments. Use dev.cmd bun/node.');
  process.exit(1);
}
const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
