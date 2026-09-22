import { authorize } from './authorize.mjs';
import { readAuthorizationConfiguration } from '../../shared/config.mjs';
import { toolsRoot } from '../../shared/storage.mjs';
import { boundTools, boundExecutor } from '../../shared/bindings.mjs';
import { withSignals } from '../../shared/signals.mjs';

export function auth(repository) {
  const github = readAuthorizationConfiguration(repository);
  const { gh } = boundTools(toolsRoot(), ['gh']);
  const execute = boundExecutor({ gh });
  return withSignals(signal => authorize({ repository, ...github, gh: gh.path },
    { execute, signal, onEvent: event => console.error(JSON.stringify(event)) }));
}
