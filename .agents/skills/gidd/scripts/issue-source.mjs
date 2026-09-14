import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { toolsRoot } from './storage.mjs';
import { normalizeRepositoryIdentity, readGitHubConfiguration } from './config.mjs';
import { boundTools, boundExecutor } from './bindings.mjs';
import { checkGitHubIdentity, runCommand } from './github.mjs';
import { inspectRepositoryEntry } from './repository-check.mjs';

const limit = 1024 * 1024;
export async function readIssueSource(repository, input, { execute = runCommand } = {}) {
  if (!input || /[\x00-\x1f]/.test(input)) throw new Error('invalid_issue_source');
  if (!/^#?\d+$/.test(input)) {
    if (input.startsWith('#')) throw new Error('invalid_issue_number');
    const path = resolve(input);
    let bytes;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error('issue_source_not_file');
      if (stat.size > limit) throw new Error('issue_source_too_large');
      bytes = readFileSync(path);
    } catch (error) {
      throw new Error(error.message.startsWith('issue_source_') ? error.message : 'issue_source_unreadable');
    }
    if (bytes.length > limit) throw new Error('issue_source_too_large');
    let body;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('issue_source_invalid_utf8'); }
    if (body.includes('\0')) throw new Error('issue_source_invalid_utf8');
    return { body, source: { kind: 'file', path } };
  }
  const number = Number(input.replace(/^#/, ''));
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid_issue_number');
  const github = readGitHubConfiguration(repository, ['hostname', 'account', 'remote', 'repository']);
  const bindings = boundTools(toolsRoot());
  const invoke = boundExecutor(bindings, execute);
  const canonical = normalizeRepositoryIdentity(github.repository);
  const inspected = await inspectRepositoryEntry(repository, bindings.git.path, github, invoke);
  if (inspected.remotes.length !== 1 || normalizeRepositoryIdentity('https://' + inspected.remotes[0].hostname + '/' + inspected.remotes[0].repository).toLowerCase() !== canonical.toLowerCase()) {
    throw new Error('issue_repository_mismatch');
  }
  const identity = await checkGitHubIdentity({ gh: bindings.gh.path, hostname: github.hostname, account: github.account }, invoke);
  if (identity.status !== 'ready') throw new Error(identity.reason === 'unexpected_account' ? 'unexpected_account' : 'issue_identity_unverified');
  const result = await invoke(bindings.gh.path, ['issue', 'view', String(number), '--repo', canonical.slice('https://'.length), '--json', 'body,number,url']);
  if (!result.ok) throw new Error('issue_read_failed');
  let issue;
  try { issue = JSON.parse(result.text); } catch { throw new Error('issue_response_invalid'); }
  const url = canonical + '/issues/' + number;
  if (issue?.number !== number || typeof issue.body !== 'string' || typeof issue.url !== 'string' || issue.url.toLowerCase() !== url.toLowerCase()) throw new Error('issue_response_invalid');
  if (Buffer.byteLength(issue.body) > limit) throw new Error('issue_source_too_large');
  return { body: issue.body, source: { kind: 'github', repository: canonical, number, url } };
}
