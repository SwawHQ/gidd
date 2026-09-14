// Initialize Node's test module through a CommonJS file before loading ESM tests.
// The runner still uses a separate process and requires each suite's after hook.
require('node:test');
