import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [command, argument = '', ...extra] = process.argv.slice(2);
const suites = ['doctor', 'setup', 'process', 'dev'];
if (!process.versions.bun || process.platform !== 'win32') {
  console.error('Development tests currently require Bun on Windows. Other platforms are not yet verified.');
  process.exit(1);
}
if (extra.length || !['.test', '.test-live'].includes(command) ||
    (command === '.test' && argument && argument !== 'all' && !suites.includes(argument))) {
  console.error('Use dev.cmd .test [all|doctor|setup|process|dev] or .test-live [archive-directory].');
  process.exit(1);
}
const files = command === '.test-live' ? ['tests/live.test.mjs'] :
  (argument && argument !== 'all' ? [argument] : suites).map(suite => `tests/${suite}.test.mjs`);
const result = spawnSync(process.execPath, ['test', ...files, '--timeout', '60000'], {
  cwd: root, stdio: 'inherit', env: {
    ...process.env,
    GIDD_LIVE_TEST: command === '.test-live' ? '1' : '',
    GIDD_ARCHIVE_DIRECTORY: command === '.test-live' ? argument : '',
  },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
