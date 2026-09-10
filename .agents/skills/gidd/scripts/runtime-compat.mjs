// Bootstrap/test protocol. Keep this module independent of all business modules:
// a runtime unable to execute it is an incompatible candidate, not a CLI failure.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkRuntime(versions = process.versions) {
  const name = versions.bun ? 'bun' : 'node';
  const version = versions[name] || '';
  const minimum = name === 'bun' ? '1.4.2' : '24.19.0';
  const actual = version.split('.').map(Number), required = minimum.split('.').map(Number);
  let compatible = /^\d+\.\d+\.\d+$/.test(version);
  for (let i = 0; compatible && i < 3; i++) {
    if (actual[i] !== required[i]) { compatible = actual[i] > required[i]; break; }
  }
  return { schema: 'gidd.runtime-compat/v1', status: compatible ? 'compatible' : 'incompatible', name, version, minimum };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkRuntime();
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'compatible' ? 0 : 1;
}
