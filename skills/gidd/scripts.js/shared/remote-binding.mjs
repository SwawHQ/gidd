import { remoteAddress } from './config.mjs';

export const dedicatedRemote = 'for.swaw.gidd';
const fail = reason => { throw new Error(reason); };
const fields = (value, names) => value && typeof value === 'object' &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

export async function gitConfiguration(git, path) {
  const values = new Map();
  for (const entry of (await git(path, ['config', '--null', '--list'])).split('\0')) {
    if (!entry) continue;
    const index = entry.indexOf('\n'), key = index < 0 ? entry : entry.slice(0, index);
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(index < 0 ? '' : entry.slice(index + 1));
  }
  return values;
}

// Let Git expand insteadOf/pushInsteadOf. Never persist an address containing
// embedded credentials. A binding captures transport addresses as well as repo identity.
async function endpoint(git, path, name, push, remotes) {
  if (!remotes.includes(name)) fail('remote_name_unavailable');
  const urls = (await git(path, ['remote', 'get-url', ...(push ? ['--push'] : []), '--all', name])).split('\n');
  if (push && urls.length !== 1) fail('remote_multiple_push_urls');
  const url = urls[0], address = remoteAddress(url);
  if (!address) fail('remote_address_unsupported');
  return { name, url, repository: address.identity };
}

export async function resolveRemoteBinding(git, path, branch) {
  const remotes = (await git(path, ['remote'])).split('\n').filter(Boolean);
  const config = await gitConfiguration(git, path);
  const last = key => config.get(key)?.at(-1);
  if (branch === undefined) branch = (await git(path, ['branch', '--show-current'])) || null;
  const dedicated = remotes.includes(dedicatedRemote);
  if (dedicated && ((config.get(`remote.${dedicatedRemote}.url`)?.length ?? 0) !== 1 ||
      (config.get(`remote.${dedicatedRemote}.pushurl`)?.length ?? 0) > 1)) fail('remote_dedicated_urls_invalid');
  const fetchName = dedicated ? dedicatedRemote : (branch && last(`branch.${branch}.remote`)) ||
    (remotes.length === 1 ? remotes[0] : 'origin');
  const pushName = dedicated ? dedicatedRemote : (branch && last(`branch.${branch}.pushremote`)) || last('remote.pushdefault') || fetchName;
  const merges = branch ? config.get(`branch.${branch}.merge`) ?? [] : [];
  if (merges.length > 1 || (merges.length && !merges[0].startsWith('refs/heads/'))) fail('remote_upstream_branch_unsupported');
  const fetch = await endpoint(git, path, fetchName, false, remotes);
  const push = await endpoint(git, path, pushName, true, remotes);
  return { selection: dedicated ? 'dedicated' : 'branch',
    fetch: { ...fetch, branch: merges[0]?.slice('refs/heads/'.length) || branch }, push };
}

// Persist repository identity, not a local alias or a transport choice.
export function remoteIdentity(value) {
  return { fetch: { repository: value.fetch.repository, branch: value.fetch.branch },
    push: { repository: value.push.repository } };
}

export function validRemoteBinding(value) {
  if (!fields(value, ['fetch', 'push'])) return false;
  for (const direction of ['fetch', 'push']) {
    const item = value[direction];
    if (!fields(item, direction === 'fetch' ? ['repository', 'branch'] : ['repository']) ||
        typeof item.repository !== 'string' || remoteAddress(item.repository)?.identity !== item.repository) return false;
  }
  return typeof value.fetch.branch === 'string' && !!value.fetch.branch &&
    !/^[-/.]|[\x00-\x20\x7f\\:]/.test(value.fetch.branch);
}

export function remoteTarget(binding, account) {
  return { hostname: new URL(binding.push.repository).hostname,
    repository: binding.push.repository, address: binding.push.url, remote: binding.push.name, account };
}

export function sameRemoteBinding(left, right) {
  return ['fetch', 'push'].every(direction =>
    ['repository', ...(direction === 'fetch' ? ['branch'] : [])]
      .every(field => left[direction][field] === right[direction][field]));
}

export async function verifyRemoteBinding(git, path, record) {
  const actual = await resolveRemoteBinding(git, path, record.target_branch);
  if (!sameRemoteBinding(actual, record.delivery.remote)) throw Object.assign(new Error('delivery_remote_changed'), {
    details: { expected: record.delivery.remote, actual: remoteIdentity(actual) },
  });
  // Working-branch defaults do not select delivery destinations. All managed
  // network operations use this verified target-branch resolution explicitly.
  return actual;
}
