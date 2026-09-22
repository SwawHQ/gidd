import { validateGitField } from '../../../shared/git-settings.mjs';
import { configurationUnavailable } from '../shared/git-settings.mjs';

export const id = 'config.git.credential.mode';
export function run(context) {
  const unavailable = configurationUnavailable(context, id);
  if (unavailable) return unavailable;
  try {
    const mode = context.configuration().git?.credential?.mode;
    if (mode === undefined) throw new Error('config_missing_git_credential_mode');
    validateGitField('credential.mode', mode);
    return { id, status: 'ready', details: { mode,
      note: mode === 'gh' ? 'gh credentials apply to HTTPS; SSH uses its native configuration.' :
        'Git authentication is inherited; the push account is not verified.' } };
  } catch (error) { return { id, status: 'invalid', reason: error.message }; }
}
