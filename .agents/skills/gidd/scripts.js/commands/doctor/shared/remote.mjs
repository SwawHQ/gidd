import { validateRemoteField, normalizeRepositoryIdentity } from '../../../shared/config.mjs';

export const remoteId = key => 'config.repo.remote.' + key;

export function remoteField(configuration, key) {
  const id = remoteId(key);
  if (configuration.result.status !== 'ready') return { id, status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' };
  const remote = configuration.remote;
  if (!Object.hasOwn(remote, key)) return { id, status: 'missing', reason: 'config_missing_repo_remote_' + key };
  try {
    validateRemoteField(key, remote[key]);
    return { id, status: 'ready', details: { expected: key === 'url' ? normalizeRepositoryIdentity(remote[key]) : remote[key] } };
  } catch { return { id, status: 'invalid', reason: 'config_invalid_repo_remote_' + key }; }
}
