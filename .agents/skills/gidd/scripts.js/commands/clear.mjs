import { configure } from '../shared/config.mjs';

export const clear = (repository, key) => configure(repository, 'clear', key);
