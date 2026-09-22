import { check } from '../shared/result.mjs';

export const id = 'tool.platform';
export const run = () => process.platform !== 'win32' || process.arch !== 'x64'
  ? check(id, 'unsupported', 'unsupported_platform') : null;
