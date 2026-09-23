import { resolve } from 'node:path';
import { skillPath } from '../../shared/paths.mjs';
import { reasonRule, render } from './catalog.mjs';

// Blocker relationships and severity are execution semantics, not editable text.
const blockers = {
  target_unavailable: 'folder.git.worktree', git_unavailable: 'tool.git', gh_unavailable: 'tool.gh',
  repository_unavailable: 'folder.git.worktree', configuration_unavailable: 'config.toml',
};
const selectionReasons = ['disabled', 'not_declared'];
const skippedReasons = [...selectionReasons, 'offline'];

function describeCheck(item, context) {
  const { id, status, reason } = item, { catalog, lang } = context;
  const declaration = catalog.checks.get(id);
  item.severity = status === 'ready' || skippedReasons.includes(reason) ? 'info' :
    ['unborn_branch', 'ssh_probe_unsupported', 'online_incomplete'].includes(reason) ? 'warning' : 'error';
  if (status === 'ready') {
    if (id === 'config.git.credential.mode') {
      const note = declaration?.['notes.' + item.details.mode + '.' + lang];
      if (note) item.details.note = note;
    }
    return;
  }
  let schedulerReason = skippedReasons.includes(reason) ? reason : null;
  if (!schedulerReason && status === 'not_checked' && (item.blocked_by || blockers[reason])) {
    item.severity = 'info'; item.blocked_by ||= blockers[reason]; schedulerReason = 'dependency_unavailable';
  }
  const specific = reasonRule(declaration?.reasons || new Map(), reason);
  // Skipped checks use scheduler guidance, never inherit normal repair commands.
  const guidance = schedulerReason ? { ...catalog.reasons.get(schedulerReason), ...specific } : {
    ...catalog.defaults, ...declaration,
    ...reasonRule(catalog.reasons, reason), ...specific,
  };
  const root = context.configRoot || context.target;
  const values = { id, reason, blocked_by: item.blocked_by, repository: root,
    config_key: id.startsWith('config.') ? id.slice(7) : '', configured: item.details?.configured ?? '<name>' };
  item.hint = render(guidance['hint.' + lang], values);
  const commands = [];
  for (const name of guidance.commands || []) {
    const template = catalog.commands.get(name);
    if (!root) continue;
    const executable = template.executable === 'link' ? resolve(root, '.agents/skills/gidd/gidd.link.cmd') :
      template.executable === 'ensure' ? skillPath('gidd.pre.ensure.cmd') : context.bindings().bindings.git?.path;
    if (!executable) continue;
    // Substitution only fills individual arguments. No shell interpolation or execution.
    commands.push({ executable, args: template.args.map(arg => render(arg, values)),
      ...(template.required_inputs?.length ? { required_inputs: template.required_inputs.map(arg => render(arg, values)) } : {}),
      ...(template.requires_configuration_review ? { requires_configuration_review: true } : {}) });
  }
  if (commands.length) item.commands = commands;
}

export function report(context, results) {
  const { offline, target, catalog, lang } = context;
  // Presentation never mutates the observations used by other checks.
  const checks = structuredClone(results);
  for (const item of checks) describeCheck(item, context);
  const hasErrors = checks.some(item => item.severity === 'error');
  const selectionIncomplete = checks.some(item => selectionReasons.includes(item.reason));
  const localIncomplete = checks.some(item => !item.id.endsWith('..online') && item.status === 'not_checked');
  const onlineIncomplete = checks.some(item => item.id.endsWith('..online') && item.status !== 'ready');
  const incomplete = selectionIncomplete || localIncomplete || (!offline && onlineIncomplete);
  const status = hasErrors ? 'needs_attention' : incomplete ? 'checks_incomplete' : offline ? 'local_ready' : 'checks_passed';
  const message = status === 'checks_incomplete' && !selectionIncomplete && !localIncomplete ? 'online_incomplete' : status;
  const hints = [catalog.report[message + '.' + lang]];
  if (checks.some(item => item.severity === 'warning')) hints.push(catalog.report['warning.' + lang]);
  if (offline) hints.push(catalog.report['offline.' + lang]);
  hints.push(catalog.report['push.' + lang]);
  return { schema: 'gidd.doctor/v1', mode: offline ? 'offline' : 'online', status,
    hint: hints.join(' '), folder: target, checks };
}
