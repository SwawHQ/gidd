import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [command, argument = '', ...extra] = process.argv.slice(2);
const suites = ['doctor', 'setup', 'process', 'dev', 'config', 'github', 'entry'];
if (process.platform !== 'win32') {
  console.error('Development tests currently require Windows. Other platforms are not yet verified.');
  process.exit(1);
}
if (extra.length || !['.test', '.test-live'].includes(command) ||
    (command === '.test-live' && argument) ||
    (command === '.test' && argument && argument !== 'all' && !suites.includes(argument))) {
  console.error('Use dev.cmd .test [all|doctor|setup|process|dev|config|github|entry] or .test-live.');
  process.exit(1);
}
const files = command === '.test-live' ? ['tests/live.test.mjs'] :
  (argument && argument !== 'all' ? [argument] : suites).map(suite => `tests/${suite}.test.mjs`);
console.log(`Runtime: ${process.versions.bun ? 'Bun ' + process.versions.bun : 'Node ' + process.versions.node}`);
const started = performance.now();
const results = [];
// Bun 1.2.15 caches node:test registration against the first loaded test file.
// A fresh process per file ensures every suite runs and isolates test state.
for (const file of files) {
  console.log(`\nRunning ${file}`);
  const suiteStarted = performance.now();
  const runnerArgs = process.versions.bun ? ['test', file, '--timeout', '60000'] : ['--test', file];
  const env = { ...process.env };
  // A parent node:test worker's context suppresses a nested --test runner.
  delete env.NODE_TEST_CONTEXT;
  const completion = join(tmpdir(), `gidd-test-${randomUUID()}.complete`);
  const result = spawnSync(process.execPath, runnerArgs, {
    cwd: root, stdio: 'inherit', env: {
      ...env,
      GIDD_LIVE_TEST: command === '.test-live' ? '1' : '',
      GIDD_TEST_COMPLETION: completion,
    },
  });
  if (result.error) console.error(result.error.message);
  let completed = false;
  try { completed = existsSync(completion) && readFileSync(completion, 'utf8') === 'completed'; }
  finally { rmSync(completion, { force: true }); }
  if (!completed) console.error(`Test worker did not complete: ${file}`);
  const passed = !result.error && result.status === 0 && completed;
  const seconds = ((performance.now() - suiteStarted) / 1000).toFixed(2);
  results.push({ file, passed, seconds });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${file} (${seconds}s)`);
}
const failures = results.filter(result => !result.passed);
console.log(`\nSuite summary: ${results.length - failures.length} passed, ${failures.length} failed (${((performance.now() - started) / 1000).toFixed(2)}s)`);
const quote = value => `'${value.replaceAll("'", "''")}'`;
for (const { file, seconds } of failures) {
  const rerun = command === '.test-live' ? '.test-live' :
    `.test-${process.versions.bun ? 'bun' : 'node'} ${file.split('/').at(-1).replace('.test.mjs', '')}`;
  console.log(`FAIL ${file} (${seconds}s)\nRerun (PowerShell): & ${quote(fileURLToPath(new URL('../../dev.cmd', import.meta.url)))} ${rerun}`);
}
process.exit(failures.length ? 1 : 0);
