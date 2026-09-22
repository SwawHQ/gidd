import { validateGitField } from '../../../shared/git-settings.mjs';

export function configurationUnavailable(context, id) {
  return context.configuration().result.status !== 'ready'
    ? { id, status: 'not_checked', reason: 'configuration_unavailable', blocked_by: 'config.toml' } : null;
}

export async function identityField(context, field) {
  const id = 'config.git.user.' + field, unavailable = configurationUnavailable(context, id);
  if (unavailable) return unavailable;
  if ((await context.run('config.git.user.mode')).status !== 'ready') {
    return { id, status: 'not_checked', reason: 'dependency_unavailable', blocked_by: 'config.git.user.mode' };
  }
  try {
    const user = context.configuration().git.user || {}, present = Object.hasOwn(user, field);
    if (user.mode === 'inherit') {
      if (present) throw new Error('config_git_user_inherit_conflict');
      return { id, status: 'ready', details: { omitted: true } };
    }
    if (!present) throw new Error('config_missing_git_user_' + field);
    validateGitField('user.' + field, user[field]);
    return { id, status: 'ready', details: { configured: user[field] } };
  } catch (error) { return { id, status: 'invalid', reason: error.message }; }
}

export async function identityBlocker(context) {
  for (const field of ['mode', 'name', 'email']) {
    const result = await context.run('config.git.user.' + field);
    if (result.status !== 'ready') return result;
  }
}
