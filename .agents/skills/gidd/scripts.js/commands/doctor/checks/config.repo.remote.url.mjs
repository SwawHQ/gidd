import { remoteAddress } from '../../../shared/config.mjs';
import { blockCheck } from '../shared/result.mjs';

export const id = 'config.repo.remote.url';
export async function run(context) {
  const field = context.remote('url'), nameId = 'config.repo.remote.name';
  if (!(await context.worktree()).readable) return blockCheck(field, nameId);
  const name = await context.run(nameId);
  if (name.status !== 'ready') return blockCheck(field, name.id);
  const selected = name.details.expected;
  const output = await context.invoke(['remote', 'get-url', '--all', selected]);
  const urls = output.ok ? output.text.split(/\r?\n/).filter(Boolean) : [];
  const address = urls.length === 1 && remoteAddress(urls[0]);
  const reason = !output.ok ? output.reason : urls.length !== 1 ? 'remote_url_ambiguous' : !address ? 'unsupported_remote_url' : undefined;
  if (reason) return field.status === 'ready' ? { ...field, status: 'invalid', reason } : field;
  const result = { ...field, details: { ...field.details, actual: address.identity, remote: selected, protocol: address.protocol } };
  if (result.status === 'ready' && result.details.expected !== address.identity) {
    result.status = 'mismatch'; result.reason = 'repository_address_mismatch';
  }
  return result;
}
