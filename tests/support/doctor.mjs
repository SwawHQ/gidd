// Isolate process/runtime state for doctor module tests; this is not a product CLI.
import { doctor } from '../../.agents/skills/gidd/scripts.js/commands/doctor/index.mjs';

const report = await doctor(process.argv[2], { offline: true });
console.log(JSON.stringify(report));
process.exitCode = report.status === 'local_ready' ? 0 : 1;
