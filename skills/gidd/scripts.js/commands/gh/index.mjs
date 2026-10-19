import { boundExecutor, boundTools } from '../../shared/bindings.mjs';
import { authorizeRepositoryGitHub, repositoryGitHubEnvironment } from '../../shared/repository-auth.mjs';
import { repositoryCommandContext } from '../../shared/repository-command.mjs';
import { resolveRemoteBinding, remoteTarget } from '../../shared/remote-binding.mjs';
import { toolEnvironment } from '../../shared/tools.mjs';
import { toolsRoot } from '../../shared/storage.mjs';
import { withSignals } from '../../shared/signals.mjs';
import { configureGitAuthentication } from './git-auth.mjs';

export function parseGhArguments(route, args) {
  if (!['gh.auth', 'gh.auth.git'].includes(route) || args.length) throw new Error('invalid_arguments');
  return { action: route === 'gh.auth.git' ? 'auth.git' : 'auth' };
}

export async function ghCommand(repository, options, { execute, signal, cwd = process.cwd(), login } = {}) {
  if (!['auth', 'auth.git'].includes(options.action)) throw new Error('invalid_arguments');
  const context = await repositoryCommandContext(repository, { execute, signal, cwd, required: false });
  const { storage, git, ensureData, lease } = context;
  try {
    const tools = boundTools(toolsRoot(), ['git', 'gh']);
    const remote = await resolveRemoteBinding(git, storage.main);
    if (options.action === 'auth.git') {
      const target = remoteTarget(remote);
      const env = repositoryGitHubEnvironment(storage, target, toolEnvironment(tools.git.path));
      const account = await boundExecutor(tools, execute)(tools.gh.path,
        ['config', 'get', 'user', '--host', target.hostname], { cwd: repository, signal, env });
      if (!account.ok) throw new Error(account.reason === 'command_failed' ? 'gh_auth_required' : account.reason);
      const credential_helper = await configureGitAuthentication(storage, target.hostname, tools.gh.path, git);
      return { schema: 'gidd.task-command/v1', status: 'ready', target_repository: repository,
        github: { hostname: target.hostname, config_directory: env.GH_CONFIG_DIR }, credential_helper };
    }
    await ensureData();
    const github = await authorizeRepositoryGitHub({ gh: tools.gh.path, ...remoteTarget(remote) },
      { storage, env: toolEnvironment(tools.git.path), execute: boundExecutor(tools, execute), cwd: repository, signal, login });
    return { schema: 'gidd.task-command/v1', status: 'ready', target_repository: repository, github };
  } finally { lease.release(); }
}

export const runGh = (repository, options) => withSignals(signal => ghCommand(repository, options, { signal }));
