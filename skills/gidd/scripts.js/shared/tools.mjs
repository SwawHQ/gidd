import { delimiter, dirname } from 'node:path';

export const minimums = { bun: '0.0.0', node: '0.0.0', git: '2.38.0', gh: '2.98.0' };
export const patterns = { bun: /^(\d+\.\d+\.\d+)$/, node: /^v(\d+\.\d+\.\d+)$/, gh: /^gh version (\d+\.\d+\.\d+)(?:\s|$)/, git: /^git version (\d+\.\d+\.\d+)/ };

// One process-local environment per command, shared by Git and gh subprocesses.
// A launcher is unnecessary after JS starts; execute the selected absolute path.
export function toolEnvironment(git, env = process.env) {
  const result = { ...env };
  if (!git) return result;
  const path = Object.entries(result).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const key of Object.keys(result)) if (/^(path|git_exec_path)$/i.test(key)) delete result[key];
  result.PATH = dirname(git) + (path ? delimiter + path : '');
  return result;
}
