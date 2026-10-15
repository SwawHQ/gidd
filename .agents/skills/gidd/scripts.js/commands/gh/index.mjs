import { boundExecutor, boundTools } from '../../shared/bindings.mjs';
import { authorizeRepositoryGitHub } from '../../shared/repository-auth.mjs';
import { repositoryCommandContext } from '../../shared/repository-command.mjs';
import { resolveRemoteBinding, remoteTarget } from '../../shared/remote-binding.mjs';
import { toolEnvironment } from '../../shared/tools.mjs';
import { toolsRoot } from '../../shared/storage.mjs';
import { withSignals } from '../../shared/signals.mjs';

export function parseGhArguments(route, args) {
  if (route !== 'gh.auth' || args.length) throw new Error('invalid_arguments');
  return { action: 'auth' };
}

export async function ghCommand(repository, options, { execute, signal, cwd = process.cwd(), login } = {}) {
  if (options.action !== 'auth') throw new Error('invalid_arguments');
  const context = await repositoryCommandContext(repository, { execute, signal, cwd, required: false });
  const { storage, git, ensureData, lease } = context;
  try {
    const tools = boundTools(toolsRoot(), ['git', 'gh']);
    const remote = await resolveRemoteBinding(git, storage.main);
    await ensureData();
    const github = await authorizeRepositoryGitHub({ gh: tools.gh.path, ...remoteTarget(remote) },
      { storage, env: toolEnvironment(tools.git.path), execute: boundExecutor(tools, execute), cwd: repository, signal, login });
    return { schema: 'gidd.task-command/v1', status: 'ready', target_repository: repository, github };
  } finally { lease.release(); }
}

export const runGh = (repository, options) => withSignals(signal => ghCommand(repository, options, { signal }));
