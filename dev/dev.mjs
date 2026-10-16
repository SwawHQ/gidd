import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disposeTestProcesses, startTestProcess, testProcessExecutable } from './test-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [command, argument = '', ...extra] = process.argv.slice(2);
const suites = ['doctor', 'setup', 'process', 'dev', 'skill', 'config', 'github', 'entry', 'policy', 'worktree', 'gh', 'issue', 'issue-task', 'data', 'init'];
if (process.platform !== 'win32') {
  console.error('Development tests currently require Windows. Other platforms are not yet verified.');
  process.exit(1);
}
if (extra.length || !['.test', '.test-live'].includes(command) ||
    (command === '.test-live' && argument) ||
    (command === '.test' && argument && argument !== 'all' && !suites.includes(argument))) {
  console.error('Use dev.cmd .test [all|doctor|setup|process|dev|skill|config|github|entry|policy|worktree|gh|issue|issue-task|data|init] or .test-live.');
  process.exit(1);
}
const files = command === '.test-live' ? ['tests/live.test.mjs'] :
  (argument && argument !== 'all' ? [argument] : suites).flatMap(suite => suite === 'gh'
    ? ['tests/repository-auth.test.mjs', 'tests/gh.test.mjs'] : suite === 'issue'
    ? ['tests/issues.test.mjs', 'tests/issue.test.mjs'] : suite === 'entry'
    ? ['tests/entry.test.mjs', 'tests/repository-entry.test.mjs'] : suite === 'github'
      ? ['tests/github.test.mjs', 'tests/execution.test.mjs'] : suite === 'config'
      ? ['tests/config.test.mjs', 'tests/remotes.test.mjs'] : suite === 'issue-task'
      ? ['tests/issue-task.test.mjs', 'tests/issue-task-create.test.mjs', 'tests/issue-task-prepare.test.mjs', 'tests/issue-task-delivery.test.mjs', 'tests/issue-task-merge.test.mjs'] : [`tests/${suite}.test.mjs`]);
console.log(`Runtime: ${process.versions.bun ? 'Bun ' + process.versions.bun : 'Node ' + process.versions.node}`);
const started = performance.now();
const results = [];
const suiteTimeout = Number(process.env.GIDD_TEST_SUITE_TIMEOUT_MS || (command === '.test-live' ? 1800000 : 900000));
if (!Number.isSafeInteger(suiteTimeout) || suiteTimeout <= 0) throw new Error('Invalid test suite timeout.');
let active, interrupted = false;
const interrupt = () => { interrupted = true; active?.stop(); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
// Bun 1.2.15 caches node:test registration against the first loaded test file.
// A fresh process per file ensures every suite runs and isolates test state.
try {
  const owner = testProcessExecutable();
  for (const file of files) {
    if (interrupted) break;
    console.log(`\nRunning ${file}`);
    const suiteStarted = performance.now();
    // A file-based CommonJS preload avoids Node 24's premature exit with these
    // synchronous Windows fixtures; preloading only the builtin does not suffice.
    // Keep the completion check below so an early exit can never count as a pass.
    const runnerArgs = process.versions.bun ? ['test', file, '--timeout', command === '.test-live' ? '300000' : '120000'] :
      ['--require', fileURLToPath(new URL('./node-test.cjs', import.meta.url)), '--test', file];
    const env = { ...process.env };
    // A parent node:test worker's context suppresses a nested --test runner.
    delete env.NODE_TEST_CONTEXT;
    const completion = join(tmpdir(), `gidd-test-${randomUUID()}.complete`);
    let result;
    try {
      active = startTestProcess(process.execPath, runnerArgs, {
        cwd: root, stdio: 'inherit', timeout: suiteTimeout, env: {
          ...env,
          GIDD_LIVE_TEST: command === '.test-live' ? '1' : '',
          GIDD_TEST_COMPLETION: completion,
          GIDD_TEST_PROCESS_EXECUTABLE: owner,
        },
      });
      result = await active.result;
    } catch (error) { result = { error }; }
    finally { active = undefined; }
    if (result.error) console.error(result.error.message);
    let completed = false;
    try { completed = existsSync(completion) && readFileSync(completion, 'utf8') === 'completed'; }
    finally { rmSync(completion, { force: true }); }
    if (!completed) console.error(`Test worker did not complete: ${file} (exit ${result.status ?? 'unknown'})`);
    const passed = !result.error && result.status === 0 && completed;
    const seconds = ((performance.now() - suiteStarted) / 1000).toFixed(2);
    results.push({ file, passed, seconds });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${file} (${seconds}s)`);
  }
} finally {
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  await disposeTestProcesses();
}
const failures = results.filter(result => !result.passed);
console.log(`\nSuite summary: ${results.length - failures.length} passed, ${failures.length} failed (${((performance.now() - started) / 1000).toFixed(2)}s)`);
const quote = value => `'${value.replaceAll("'", "''")}'`;
for (const { file, seconds } of failures) {
  const rerun = command === '.test-live' ? '.test-live' :
    `.test-${process.versions.bun ? 'bun' : 'node'} ${file.includes('repository-auth') ? 'gh' : file.includes('issues') ? 'issue' : file.includes('repository-entry') ? 'entry' : file.includes('execution.test') ? 'github' : file.includes('remotes.test') ? 'config' : file.includes('issue-task') ? 'issue-task' : file.split('/').at(-1).replace('.test.mjs', '')}`;
  console.log(`FAIL ${file} (${seconds}s)\nRerun (PowerShell): & ${quote(fileURLToPath(new URL('../dev.cmd', import.meta.url)))} ${rerun}`);
}
process.exit(interrupted ? 130 : failures.length ? 1 : 0);
