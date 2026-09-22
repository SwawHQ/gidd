export const id = 'config.repo.remote.account..online';
export const online = true;
export const run = async context => (await context.account()).result;
