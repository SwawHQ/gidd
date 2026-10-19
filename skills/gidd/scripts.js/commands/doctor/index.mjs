import { runCommand } from '../../shared/process.mjs';
import { resolveLanguage } from '../../shared/language.mjs';
import { registry } from './registry.mjs';
import { createContext } from './context.mjs';
import { report } from './report.mjs';
import { loadCatalog } from './catalog.mjs';
import { diagnostic } from '../../shared/diagnostics.mjs';
import { repositoryRoot } from '../../shared/storage.mjs';

export function parseDoctorArguments(args) {
  const input = [...args];
  let offline = false, lang;
  while (input.length) {
    const flag = input.shift();
    if (flag === '--offline' && !offline) { offline = true; continue; }
    if (flag === '--lang' && lang === undefined && input[0] && !input[0].startsWith('--')) { lang = input.shift(); continue; }
    throw new Error('invalid_arguments');
  }
  return { offline, lang: lang === undefined ? undefined : resolveLanguage(lang, 'unsupported_doctor_language') };
}

export async function doctor(target, { offline = false, fixedRepository = false, execute = runCommand, catalogPath, lang } = {}) {
  let languageRoot = target;
  if (target && !fixedRepository) {
    try { languageRoot = repositoryRoot(target); } catch { /* Target checks report unreadable directories. */ }
  }
  lang = resolveLanguage(lang, 'unsupported_doctor_language', languageRoot);
  const entries = new Map(registry.map(entry => [entry.id, entry]));
  let catalog;
  try { catalog = loadCatalog(new Set(entries.keys()), catalogPath); }
  catch (error) {
    // A damaged catalog cannot supply its own recovery message. Do not probe or
    // silently fall back to a different selection when declarations cannot load.
    return { schema: 'gidd.doctor/v1', mode: offline ? 'offline' : 'online', status: 'needs_attention',
      details: diagnostic(error.message), hint: lang === 'zh-CN'
        ? '请修复或恢复本技能中的 references/doctor.toml，然后重新运行 doctor。'
        : 'Repair or restore references/doctor.toml in this skill, then rerun doctor.',
      folder: target ?? null, checks: [] };
  }
  const context = createContext(target, { offline, fixedRepository, execute, catalog, lang }, entries);
  const results = [];
  for (const entry of registry) {
    const result = await context.run(entry.id);
    if (result) results.push(result);
  }
  return report(context, results);
}
