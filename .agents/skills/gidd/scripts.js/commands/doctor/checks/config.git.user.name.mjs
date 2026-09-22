import { identityField } from '../shared/git-settings.mjs';

export const id = 'config.git.user.name';
export const run = context => identityField(context, 'name');
