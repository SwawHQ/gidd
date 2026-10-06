import { boundExecutor, boundTools } from './bindings.mjs';
import { githubTarget, readConfiguration, remoteAddress, validateRemoteSettings } from './config.mjs';
import { gitEnvironment, githubEnvironment, selectGitHubAccount } from './execution-env.mjs';
import { validateGitSettings } from './git-settings.mjs';
import { noninteractiveEnvironment } from './noninteractive.mjs';
import { toolsRoot } from './storage.mjs';

// Internal workflow operations select a named, verified remote and use the
// entry's identity/credentials. Native .git/.gh target overrides are separate.
export async function repositoryConnection(repository, { execute, signal, github = false, prefix = 'workflow' } = {}) {
  const settings = readConfiguration(repository);
  validateGitSettings(settings.git);
  const needsGh = github || settings.git.credential.mode === 'gh';
  validateRemoteSettings(settings.repo.remote, needsGh ? ['name', 'url', 'account'] : ['name', 'url']);
  const target = githubTarget(settings.repo.remote);
  const bindings = boundTools(toolsRoot(), needsGh ? ['git', 'gh'] : ['git']);
  const invoke = boundExecutor(bindings, execute);
  let env = noninteractiveEnvironment(bindings.git.path,
    gitEnvironment(settings.git, bindings, target, needsGh ? githubEnvironment(target) : process.env));
  if (github) env = (await selectGitHubAccount({ gh: bindings.gh.path, ...target },
    { env, cwd: repository, signal, execute: invoke })).env;
  const fail = suffix => { throw new Error(prefix + '_' + suffix); };
  const call = async (tool, args, cwd = repository) => {
    const result = await invoke(bindings[tool].path, args, { cwd, env, signal, timeoutMs: 60000 });
    if (!result.ok) throw new Error(result.reason === 'command_failed' ? prefix + '_remote_failed' : result.reason);
    return result.text;
  };
  const git = (path, args) => call('git', ['-C', path, ...args]);
  const verifyRemote = async () => {
    for (const direction of [[], ['--push']]) {
      const urls = (await git(repository, ['remote', 'get-url', ...direction, '--all', target.remote])).split('\n');
      if (urls.length !== 1 || remoteAddress(urls[0])?.identity !== target.repository) fail('remote_mismatch');
    }
  };
  await verifyRemote();
  return { target, git, verifyRemote, call };
}
