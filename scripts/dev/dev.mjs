import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [command, argument = '', ...extra] = process.argv.slice(2);
const suites = ['doctor', 'setup', 'process', 'dev'];
if (process.platform !== 'win32') {
  console.error('Development tests currently require Windows. Other platforms are not yet verified.');
  process.exit(1);
}
if (extra.length || !['.test', '.test-live'].includes(command) ||
    (command === '.test' && argument && argument !== 'all' && !suites.includes(argument))) {
  console.error('Use dev.cmd .test [all|doctor|setup|process|dev] or .test-live [archive-directory].');
  process.exit(1);
}
const files = command === '.test-live' ? ['tests/live.test.mjs'] :
  (argument && argument !== 'all' ? [argument] : suites).map(suite => `tests/${suite}.test.mjs`);
console.log(`Runtime: ${process.versions.bun ? 'Bun ' + process.versions.bun : 'Node ' + process.versions.node}`);
let failed = false;
// Bun 1.2.15 caches node:test registration against the first loaded test file.
// A fresh process per file ensures every suite runs and isolates test state.
for (const file of files) {
  const runnerArgs = process.versions.bun ? ['test', file, '--timeout', '60000'] : ['--test', file];
  const env = { ...process.env };
  // A parent node:test worker's context suppresses a nested --test runner.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, runnerArgs, {
    cwd: root, stdio: 'inherit', env: {
      ...env,
      GIDD_LIVE_TEST: command === '.test-live' ? '1' : '',
      GIDD_ARCHIVE_DIRECTORY: command === '.test-live' ? argument : '',
    },
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
