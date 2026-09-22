import { inspectTool } from '../shared/tools.mjs';

export const id = 'tool.gh';
export const run = context => inspectTool(context, 'gh');
