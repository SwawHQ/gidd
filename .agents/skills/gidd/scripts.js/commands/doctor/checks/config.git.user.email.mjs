import { identityField } from '../shared/git-settings.mjs';

export const id = 'config.git.user.email';
export const run = context => identityField(context, 'email');
