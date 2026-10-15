import { boundExecutor, boundTools } from './bindings.mjs';
import { resolveRemoteBinding, remoteTarget, verifyRemoteBinding, sameRemoteBinding } from './remote-binding.mjs';
import { selectRepositoryAccount } from './repository-auth.mjs';
import { locateStorage } from './managed-storage.mjs';
import { toolEnvironment } from './tools.mjs';
import { noninteractiveEnvironment } from './noninteractive.mjs';
import { toolsRoot } from './storage.mjs';

// Delivery operations verify repository identities and resolve current
// transports. Git inherits native credentials; API identity is discovered or task-bound.
export async function repositoryConnection(repository, { execute, signal, github = false, prefix = 'delivery', record, branch } = {}) {
  const needsGh = github;
  const bindings = boundTools(toolsRoot(), needsGh ? ['git', 'gh'] : ['git']);
  const invoke = boundExecutor(bindings, execute);
  const inspect = async (path, args) => {
    const result = await invoke(bindings.git.path, ['-C', path, ...args],
      { env: noninteractiveEnvironment(bindings.git.path, process.env), signal, timeoutMs: 60000 });
    if (!result.ok) throw new Error(prefix + '_remote_failed');
    return result.text;
  };
  const remote = record ? await verifyRemoteBinding(inspect, repository, record) : await resolveRemoteBinding(inspect, repository, branch);
  const target = remoteTarget(remote, record?.github_account);
  let env = noninteractiveEnvironment(bindings.git.path,
    toolEnvironment(bindings.git.path, process.env));
  if (github) {
    const storage = await locateStorage(repository, inspect);
    const selected = await selectRepositoryAccount({ gh: bindings.gh.path, ...target },
      { storage, env, cwd: repository, signal, execute: invoke });
    env = selected.env;
    target.account = selected.identity.details.actual;
  }
  const call = async (tool, args, cwd = repository, input) => {
    const result = await invoke(bindings[tool].path, args, { cwd, env: tool === 'git'
      ? noninteractiveEnvironment(bindings.git.path, toolEnvironment(bindings.git.path, process.env)) : env,
      signal, timeoutMs: 60000, input });
    if (!result.ok) throw new Error(result.reason === 'command_failed' ? prefix + '_remote_failed' : result.reason);
    return result.text;
  };
  const git = (path, args) => call('git', ['-C', path, ...args]);
  const verifyRemote = async () => {
    const actual = record ? await verifyRemoteBinding(inspect, repository, record) : await resolveRemoteBinding(inspect, repository, branch);
    if (!sameRemoteBinding(actual, remote)) throw new Error('delivery_remote_changed');
    Object.assign(remote, actual);
    Object.assign(target, remoteTarget(actual, target.account));
  };
  await verifyRemote();
  return { target, remote, git, verifyRemote, call };
}
