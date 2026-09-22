import { validateGitField } from '../../../shared/git-settings.mjs';
import { configurationUnavailable } from '../shared/git-settings.mjs';

export const id = 'config.git.user.mode';
export function run(context) {
  const unavailable = configurationUnavailable(context, id);
  if (unavailable) return unavailable;
  try {
    const user = context.configuration().git?.user || {};
    if (user.mode === undefined) throw new Error('config_missing_git_user_mode');
    validateGitField('user.mode', user.mode);
    return { id, status: 'ready', details: { mode: user.mode, source: user.mode === 'managed' ? 'config.toml' : 'git' } };
  } catch (error) { return { id, status: 'invalid', reason: error.message }; }
}
