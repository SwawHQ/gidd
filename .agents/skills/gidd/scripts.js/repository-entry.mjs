// Runtime entry only. PowerShell owns generation and repair of gidd.link.cmd.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceEntry = fileURLToPath(new URL('./gidd.mjs', import.meta.url));
const schema = 'gidd.repository-entry/v1';
const reasonOf = error => /^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$/.test(error.message) ? error.message : 'repository_entry_failed';
const samePath = (a, b) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

function validateSpec(spec) {
  if (spec?.schema !== schema || typeof spec.entry !== 'string' || !spec.entry ||
      /[\x00-\x1f"<>|]/.test(spec.entry) || !spec.entry.replaceAll('\\', '/').endsWith('/gidd.mjs') ||
      !['bun','node'].includes(spec.runtime) || Object.keys(spec).some(key => !['schema', 'entry', 'runtime'].includes(key))) throw new Error('repository_entry_invalid');
  return spec;
}

export async function runLink(directory, spec, args) {
  try {
    validateSpec(spec);
    const repository = resolve(directory, '../../..');
    if (resolve(repository, '.agents/skills/gidd').toLowerCase() !== resolve(directory).toLowerCase()) throw new Error('repository_entry_location_invalid');
    const entry = resolve(directory, spec.entry);
    // Verify we entered the very skill named by the link, not another copied helper.
    if (!samePath(entry, sourceEntry)) throw new Error('repository_entry_target_mismatch');
    if (!['.gh', '.git'].includes(args[0]?.toLowerCase()) && args.some(arg => arg === '--repository' || arg.startsWith('--repository='))) throw new Error('repository_override_forbidden');
    const { main } = await import('./gidd.mjs');
    return await main([...args], { boundRepository: repository });
  } catch (error) {
    console.error('GIDD repository entry failed. Check the target or rerun gidd.pre.ensure.cmd --repo with the target directory.');
    console.log(JSON.stringify({ schema, status: 'error', reason: reasonOf(error) }));
    return 2;
  }
}

// The generated CMD only imports this function. Decode metadata, bind the
// repository and report failures here, in the installed JavaScript module.
export async function startLink(args = process.argv.slice(1)) {
  const directory = process.env.GIDD_LINK_DIRECTORY;
  const encoded = process.env.GIDD_LINK_SPEC;
  delete process.env.GIDD_LINK_DIRECTORY;
  delete process.env.GIDD_LINK_SPEC;
  delete process.env.GIDD_LINK_LOADER;
  let spec;
  try {
    spec = JSON.parse(Buffer.from(encoded || '', 'base64').toString('utf8'));
  } catch {
    console.error('GIDD repository entry is invalid. Rerun gidd.pre.ensure.cmd --repo with the target directory.');
    console.log(JSON.stringify({ schema, status: 'error', reason: 'repository_entry_invalid' }));
    process.exitCode = 2;
    return;
  }
  process.exitCode = await runLink(directory, spec, args);
}
