import { readBindings } from '../../../shared/bindings.mjs';
import { toolsRoot, compareVersions } from '../../../shared/storage.mjs';
import { patterns, minimums, toolEnvironment } from '../../../shared/tools.mjs';
import { check, safeReason } from './result.mjs';

export function inspectBindings() {
  try { return { bindings: readBindings(toolsRoot()).tools }; }
  catch (error) { return { bindings: {}, reason: safeReason(error, 'tool_bindings_invalid') }; }
}

// Inspect only published bindings; doctor never discovers or installs replacements.
export async function inspectTool(context, name) {
  const { bindings, reason } = context.bindings();
  const tool = bindings[name];
  let failure = reason || (!tool ? 'tool_binding_missing' : null), version;
  if (!failure) {
    const probe = await context.execute(tool.path, ['--version'], { timeoutMs: 5000, env: toolEnvironment(bindings.git?.path) });
    version = probe.ok && patterns[name].exec(probe.text)?.[1];
    failure = !probe.ok ? probe.reason : !version ? 'unrecognized_version' :
      compareVersions(version, minimums[name]) < 0 ? 'version_below_minimum' :
        version !== tool.version ? 'tool_binding_version_changed' : null;
  }
  return failure ? check('tool.' + name, !tool && (!reason || reason === 'tool_bindings_missing') ? 'missing' : 'invalid', failure) :
    check('tool.' + name, 'ready', undefined, { path: tool.path, version, gidd_managed: tool.source === 'managed' });
}
