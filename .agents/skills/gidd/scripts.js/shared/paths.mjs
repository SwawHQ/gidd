import { fileURLToPath } from 'node:url';

// Resolve packaged resources from one stable location, including relocated skills.
export const skillUrl = new URL('../../', import.meta.url);
export const skillPath = relative => fileURLToPath(new URL(relative, skillUrl));
