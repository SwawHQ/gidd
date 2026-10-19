import { inspectTool } from '../shared/tools.mjs';

export const id = 'tool.git';
export const run = context => inspectTool(context, 'git');
