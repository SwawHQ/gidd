export function parseList(text) {
  return text.split('\0\0').filter(Boolean).map(block => {
    const row = {};
    for (const field of block.split('\0').filter(Boolean)) {
      const space = field.indexOf(' ');
      row[space < 0 ? field : field.slice(0, space)] = space < 0 ? true : field.slice(space + 1);
    }
    return { path: row.worktree, head: row.HEAD, branch: row.branch?.replace(/^refs\/heads\//, ''),
      detached: !!row.detached, bare: !!row.bare, locked: Object.hasOwn(row, 'locked'), prunable: Object.hasOwn(row, 'prunable') };
  });
}
