import { validateGitUser, validateGitField } from './git-settings.mjs';

export function gitSettingChecks(settings, available) {
  return ['user', 'credential.mode'].map(key => {
    const id = 'config.git.' + key;
    if (!available) return { id, status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' };
    try {
      if (key === 'user') {
        const user = validateGitUser(settings?.user);
        return { id, status: 'ready', details: { source: user.name ? 'config.toml' : 'git', ...(user.name ? { defaults: user } : {}) } };
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
