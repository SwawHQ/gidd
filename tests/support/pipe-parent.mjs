import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [mode, path] = process.argv.slice(2);
if (mode === 'child' || mode === 'hang') {
  if (mode === 'child') {
    process.stdout.write('child holds stdout\n');
    process.stderr.write('child holds stderr\n');
  }
  setTimeout(() => {}, 10000);
} else if (mode === 'normal') {
  console.log('complete output');
  console.error('private stderr');
} else {
  // Keep the descendant alive after its parent exits so it still holds the pipes.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], {
    stdio: 'inherit', windowsHide: true, detached: true,
  });
  child.unref();
  writeFileSync(path, String(child.pid));
  await new Promise(resolve => setTimeout(resolve, Number(mode)));
  console.log('parent exited');
}
