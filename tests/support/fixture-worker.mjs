import { spawn } from 'node:child_process';
import { existsSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, path] = process.argv.slice(2);
if (mode === 'status') process.exit(Number(path));
if (mode === 'child') {
  // The current directory stays in use until this descendant exits.
  process.chdir(dirname(path));
  openSync(path, 'w');
  writeFileSync(path + '.locked', 'locked');
  setInterval(() => {}, 60000);
} else {
  // Detached children exercise the owner's cleanup after their parent exits.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', path], {
    stdio: 'inherit', windowsHide: true, detached: true,
  });
  writeFileSync(path + '.pid', String(child.pid));
  const deadline = Date.now() + 10000;
  while (!existsSync(path + '.locked')) {
    if (Date.now() > deadline) throw new Error('Fixture child did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (mode === 'orphan') child.unref();
}
