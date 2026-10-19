export const id = 'folder.git.worktree';
export const run = async context => (await context.worktree()).result;
