// Semantic validation is separate from TOML parsing so config set can repair
// individual fields, including the two halves of a name/email pair.
export function validateGitField(key, value) {
  if (key === 'credential.mode') {
    if (!['gh', 'inherit'].includes(value)) throw new Error('config_invalid_git_credential_mode');
  } else if (['user.name', 'user.email'].includes(key)) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\x00-\x1f\x7f<>]/.test(value)) {
      throw new Error('config_invalid_git_' + key.replace('.', '_'));
    }
  } else throw new Error('config_unknown_key');
}

export function validateGitUser(user = {}) {
  for (const [key, value] of Object.entries(user)) validateGitField('user.' + key, value);
  if (Object.hasOwn(user, 'name') !== Object.hasOwn(user, 'email')) throw new Error('config_incomplete_git_user');
  return user;
}

export function validateGitSettings(settings = {}) {
  validateGitUser(settings.user);
  if (!Object.hasOwn(settings.credential || {}, 'mode')) throw new Error('config_missing_git_credential_mode');
  validateGitField('credential.mode', settings.credential.mode);
  return settings;
}
