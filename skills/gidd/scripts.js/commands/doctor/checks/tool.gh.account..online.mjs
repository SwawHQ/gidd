export const id = 'tool.gh.account..online';
export const online = true;
export const run = async context => (await context.account()).result;
