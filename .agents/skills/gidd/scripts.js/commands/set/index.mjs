import { configure } from '../../shared/config.mjs';

export const set = (repository, key, value) => configure(repository, 'set', key, value);
