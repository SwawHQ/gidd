import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, readJson, samePath } from './managed-storage.mjs';
import { deliveryModeDirectoryPattern, parsePolicySelector, validPolicySnapshot } from './policy-definition.mjs';
import { plainPath } from './storage.mjs';

export function policyStorage(repository) {
  const path = repository + '.gidd';
  if (!existsSync(join(path, 'storage.json'))) throw new Error('data_missing');
  const owner = readJson(join(path, 'storage.json'));
  if (owner?.schema !== 'gidd.storage/v1' || typeof owner.repository !== 'string' || !samePath(owner.repository, repository)) throw new Error('data_repository_mismatch');
  return { path, lock: join(path, '.lock') };
}
function historyFile(storage) {
  const path = join(storage.path, 'policy-history.jsonl');
  plainPath(path);
  if (!existsSync(path)) return { path, entries: [], size: 0, incomplete: false };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('policy_history_invalid');
  const bytes = readFileSync(path), size = bytes.lastIndexOf(10) + 1;
  try {
    if (bytes.length > 1024 * 1024) throw new Error();
    // A newline commits an entry; an interrupted final append is discarded on the next write.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    const entries = text ? text.slice(0, -1).split('\n').map(line => {
      const entry = JSON.parse(line);
      if (!entry || !Object.keys(entry).every(key => ['at', 'selector', 'id'].includes(key)) ||
          (entry.id !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.id)) || typeof entry.at !== 'string' ||
          new Date(entry.at).toISOString() !== entry.at || typeof entry.selector !== 'string' || entry.selector.length > 512 ||
          !deliveryModeDirectoryPattern.test(parsePolicySelector(entry.selector).mode)) throw new Error();
      return entry;
    }) : [];
    return { path, entries, size, incomplete: size !== bytes.length };
  } catch { throw new Error('policy_history_invalid'); }
}
export const readPolicyHistory = storage => historyFile(storage).entries;
// The caller holds the storage lease when binding or changing a task policy.
export function recordPolicyUse(storage, policy, id) {
  if (!validPolicySnapshot(policy) || policy.selector.length > 512) throw new Error('policy_history_invalid');
  const { path, entries, size, incomplete } = historyFile(storage);
  if (id !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error('policy_history_invalid');
  const existing = id && entries.find(entry => entry.id === id);
  if (existing) {
    if (existing.selector !== policy.selector) throw new Error('policy_history_invalid');
    return;
  }
  const entry = { at: new Date().toISOString(), selector: policy.selector, ...(id ? { id } : {}) };
  entries.push(entry);
  if (entries.length > 500) {
    atomicWrite(path, entries.slice(-200).map(item => JSON.stringify(item)).join('\n') + '\n');
    return;
  }
  if (incomplete) truncateSync(path, size);
  const fd = openSync(path, 'a');
  try {
    try { writeFileSync(fd, JSON.stringify(entry) + '\n'); fsyncSync(fd); }
    catch (error) { truncateSync(path, size); throw error; }
  } finally { closeSync(fd); }
}
