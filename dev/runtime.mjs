import { spawnSync } from 'node:child_process';

// The launcher selected this runtime. Keep the caller's cwd, environment and
// stdio. The batch entry forwards its complete argv directly, without PowerShell.
const forwarded = process.argv.slice(2);
const system = forwarded[0]?.toLowerCase() === 'sys';
const name = forwarded[system ? 1 : 0]?.toLowerCase();
if (!['bun', 'node'].includes(name)) {
  console.error('Invalid runtime arguments. Use dev.cmd bun/node.');
  process.exit(1);
}
const args = forwarded.slice(system ? 2 : 1);
const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
