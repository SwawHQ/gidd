import { validateGitField } from './git-settings.mjs';

export function gitSettingChecks(settings, available) {
  let modeReady = false;
  return ['user.mode', 'user.name', 'user.email', 'credential.mode'].map(key => {
    const id = 'config.git.' + key;
    if (!available) return { id, status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' };
    const identityField = ['user.name', 'user.email'].includes(key);
    if (identityField && !modeReady) return { id, status: 'not_checked', reason: 'dependency_unavailable', blocked_by: 'config.git.user.mode' };
    try {
      const user = settings?.user || {};
      if (key === 'user.mode') {
        if (user.mode === undefined) throw new Error('config_missing_git_user_mode');
        validateGitField(key, user.mode);
        modeReady = true;
        return { id, status: 'ready', details: { mode: user.mode, source: user.mode === 'managed' ? 'config.toml' : 'git' } };
      }
      if (identityField) {
        const field = key.slice(5), present = Object.hasOwn(user, field);
        if (user.mode === 'inherit') {
          if (present) throw new Error('config_git_user_inherit_conflict');
          return { id, status: 'ready', details: { omitted: true } };
        }
        if (!present) throw new Error('config_missing_git_user_' + field);
        validateGitField(key, user[field]);
        return { id, status: 'ready', details: { configured: user[field] } };
      }
      if (settings?.credential?.mode === undefined) throw new Error('config_missing_git_credential_mode');
      validateGitField(key, settings.credential.mode);
      return { id, status: 'ready', details: { mode: settings.credential.mode,
        note: settings.credential.mode === 'gh' ? 'gh credentials apply to HTTPS; SSH uses its native configuration.' :
          'Git authentication is inherited; the push account is not verified.' } };
    } catch (error) { return { id, status: 'invalid', reason: error.message }; }
  });
}

export async function effectiveGitIdentity(invoke) {
  const identities = {};
  for (const [name, variable] of [['author', 'GIT_AUTHOR_IDENT'], ['committer', 'GIT_COMMITTER_IDENT']]) {
    const result = await invoke(['var', variable]);
    const match = result.ok && /^(.+) <([^<>\r\n]+)> \d+ [+-]\d{4}$/.exec(result.text);
    if (!match) return { id: 'folder.git.author', status: 'failed', reason: result.ok ? 'invalid_author_response' : result.reason };
    identities[name] = { name: match[1], email: match[2] };
  }
  return { id: 'folder.git.author', status: 'ready', details: { ...identities.author, committer: identities.committer } };
}
