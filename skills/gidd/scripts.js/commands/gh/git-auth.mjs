import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainPath } from '../../shared/storage.mjs';

const shellQuote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";

export async function configureGitAuthentication(storage, hostname, gh, git) {
  const key = `credential.https://${hostname}.helper`;
  const helper = `!GH_CONFIG_DIR=${shellQuote(join(storage.path, 'gh'))} ${shellQuote(gh)} auth git-credential`;
  const config = join(storage.common, 'config'), lock = config + '.lock';
  plainPath(config); plainPath(lock);
  if (!lstatSync(config).isFile()) throw new Error('git_config_invalid');
  let fd;
  try { fd = openSync(lock, 'wx', lstatSync(config).mode); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('git_config_locked'); throw error; }
  try {
    // Hold Git's config lock until both helper values are ready to replace the original.
    try { writeFileSync(fd, readFileSync(config)); } finally { closeSync(fd); }
    await git(storage.main, ['config', '--file', lock, '--replace-all', key, '']);
    await git(storage.main, ['config', '--file', lock, '--add', key, helper]);
    renameSync(lock, config);
    return key;
  } catch (error) {
    // After a successful rename, this lock path can already belong to another Git process.
    if (existsSync(lock)) unlinkSync(lock);
    throw error;
  }
}
