import { runCommand } from '../../shared/process.mjs';
import { registry } from './registry.mjs';
import { createContext } from './context.mjs';
import { report } from './report.mjs';

export async function doctor(target, { offline = false, fixedRepository = false, execute = runCommand } = {}) {
  const entries = new Map(registry.map(entry => [entry.id, entry]));
  const context = createContext(target, { offline, fixedRepository, execute }, entries);
  const results = [];
  for (const entry of registry) {
    const result = await context.run(entry.id);
    if (result) results.push(result);
  }
  return report(context, results);
}
