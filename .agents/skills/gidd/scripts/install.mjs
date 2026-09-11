import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { compareVersions, hashFile, inspectToolTree, managedToolValid, managedExecutable, payloadFiles, safePayloadName, plainPath, platformName, validateToolSettings, versionPattern } from './storage.mjs';
import { patterns } from './tools.mjs';
import { runCommand } from './github.mjs';

export function durableFile(path, bytes) {
  plainPath(path);
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function releaseMarker(lock, marker) {
  try { unlinkSync(join(lock, marker)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { rmdirSync(lock); } catch (error) { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error; }
}

// Publish a nonempty directory atomically. A unique owner filename prevents a
// stale reclaimer from deleting a successor's marker. Never recursively remove a lock.
export function acquireInstallLock(root) {
  inspectToolTree(root);
  const cache = join(root, '.cache'); plainPath(cache); mkdirSync(cache, { recursive: true });
  const lock = join(cache, 'install.lock'), token = randomUUID(), marker = `owner-${token}.json`, prepared = join(cache, `lock-${token}`);
  mkdirSync(prepared);
  durableFile(join(prepared, marker), JSON.stringify({ schema: 'gidd.lock/v1', pid: process.pid, token }));
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      plainPath(lock);
      if (existsSync(lock)) {
        const stat = lstatSync(lock);
        if (stat.isFile() && stat.size === 0) {
          // Old stage0 holds this file with FileShare.None. Unlink fails while
          // it is running. File-only operations cannot move a new directory
          // owner into the retired path if another contender won this race.
          const retired = join(cache, `legacy-${token}`);
          try { linkSync(lock, retired); unlinkSync(lock); }
          catch { throw new Error('install_locked_or_unwritable'); }
          finally { if (existsSync(retired)) unlinkSync(retired); }
        } else if (stat.isDirectory()) {
          const entries = readdirSync(lock);
          if (!entries.length) { try { rmdirSync(lock); } catch {} continue; }
          if (entries.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(entries[0])) throw new Error('install_locked_or_unwritable');
          const ownerPath = join(lock, entries[0]); plainPath(ownerPath);
          if (lstatSync(ownerPath).size > 1024) throw new Error('install_locked_or_unwritable');
          const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
          if (owner.schema !== 'gidd.lock/v1' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || entries[0] !== `owner-${owner.token}.json`) throw new Error('install_locked_or_unwritable');
          let dead = false;
          try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
          if (!dead) throw new Error('install_locked_or_unwritable');
          releaseMarker(lock, entries[0]); continue;
        } else throw new Error('install_locked_or_unwritable');
      }
      try { renameSync(prepared, lock); return () => releaseMarker(lock, marker); }
      catch (error) { if (!existsSync(lock)) throw error; }
    }
    throw new Error('install_locked_or_unwritable');
  } finally {
    if (existsSync(prepared)) releaseMarker(prepared, marker);
  }
}

export function removeStage(root, name) {
  if (!['bun','node','gh','git'].includes(name)) throw new Error('invalid_tool_name');
  const stage = resolve(root, '.cache', name), expected = resolve(root) + sep + '.cache' + sep + name;
  if (stage !== expected) throw new Error('stage_outside_root');
  inspectToolTree(stage);
  if (existsSync(stage)) rmSync(stage, { recursive: true });
}

export function writeInstallationGuide(root) {
  const path = join(root, 'INSTALLATION.md'), temporary = join(root, `.INSTALLATION-${randomUUID()}.tmp`);
  plainPath(path);
  const text = readFileSync(new URL('../references/INSTALLATION.md', import.meta.url));
  if (existsSync(path) && readFileSync(path).equals(text)) return;
  try { durableFile(temporary, text); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export async function download(url, limit = 256 * 1024 * 1024) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    for (let redirects = 0; redirects < 6; redirects++) {
      if (new URL(url).protocol !== 'https:') throw new Error('https_required');
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'GIDD-bootstrap' } });
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel(); url = new URL(response.headers.get('location'), url).href; continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('download_failed'); }
      const chunks = []; let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length; if (total > limit) { controller.abort(); throw new Error('download_too_large'); }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, total);
    }
    throw new Error('too_many_redirects');
  } finally { clearTimeout(timer); }
}

export async function releaseText(url) {
  return new TextDecoder('utf-8', { fatal: true }).decode(await download(url, 4 * 1024 * 1024));
}
export function checksum(text, archive) {
  const hashes = text.split(/\r?\n/).map(line => /^([a-f0-9]{64})[ \t]+\*?(.+)$/i.exec(line))
    .filter(match => match?.[2] === archive).map(match => match[1].toLowerCase());
  if (hashes.length !== 1) throw new Error(`missing_or_duplicate_release_checksum:${archive}`);
  return hashes[0];
}

export async function resolveRelease(name, settings, pinned, readText = releaseText) {
  if (!['bun','node','gh','git'].includes(name)) throw new Error('invalid_tool_name');
  if (name === 'git') return resolveGitRelease(readText);
  let { version, source } = validateToolSettings(name, settings);
  if (pinned && pinned.version === version) {
    const definition = structuredClone(pinned), tag = name === 'bun' ? `bun-v${version}` : `v${version}`;
    definition.url = name === 'node' ? `${source}/${tag}/${definition.archive}` : `${source}/download/${tag}/${definition.archive}`;
    return definition;
  }
  const metadata = []; let archive, url, files, supplements = [], checksumUrl;
  if (name === 'node') {
    if (['latest','lts'].includes(version)) {
      const indexUrl = 'https://nodejs.org/dist/index.json'; metadata.push(indexUrl);
      const index = JSON.parse(await readText(indexUrl));
      const versions = index.filter(item => /^v\d+\.\d+\.\d+$/.test(item.version) && item.files.includes('win-x64-zip') &&
        (version === 'latest' || typeof item.lts === 'string' && item.lts)).map(item => item.version.slice(1)).sort((a,b) => compareVersions(b,a));
      if (!versions.length) throw new Error('node_release_unavailable');
      version = versions[0];
    }
    archive = `node-v${version}-win-x64.zip`; checksumUrl = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
    url = `${source}/v${version}/${archive}`;
    files = [{ entry: `node-v${version}-win-x64/node.exe`, name: 'node.exe' }, { entry: `node-v${version}-win-x64/LICENSE`, name: 'LICENSE' }];
  } else {
    const repo = name === 'bun' ? 'oven-sh/bun' : 'cli/cli'; let tag = name === 'bun' ? `bun-v${version}` : `v${version}`;
    if (version === 'latest') {
      const releaseUrl = `https://api.github.com/repos/${repo}/releases/latest`; metadata.push(releaseUrl);
      const release = JSON.parse(await readText(releaseUrl)), match = (name === 'bun' ? /^bun-v(\d+\.\d+\.\d+)$/ : /^v(\d+\.\d+\.\d+)$/).exec(release.tag_name);
      if (release.draft || release.prerelease || !match) throw new Error(`invalid_stable_release:${name}`);
      version = match[1]; tag = release.tag_name;
    }
    archive = name === 'bun' ? 'bun-windows-x64.zip' : `gh_${version}_windows_amd64.zip`;
    checksumUrl = `https://github.com/${repo}/releases/download/${tag}/${name === 'bun' ? 'SHASUMS256.txt' : `gh_${version}_checksums.txt`}`;
    url = `${source}/download/${tag}/${archive}`;
    files = name === 'bun' ? [{ entry: 'bun-windows-x64/bun.exe', name: 'bun.exe' }] : [{ entry: 'bin/gh.exe', name: 'gh.exe' }, { entry: 'LICENSE', name: 'LICENSE' }];
    if (name === 'bun') {
      const licenseUrl = `https://raw.githubusercontent.com/oven-sh/bun/${tag}/LICENSE.md`; metadata.push(licenseUrl);
      const license = await readText(licenseUrl); if (!license.trim()) throw new Error('empty_bun_license');
      supplements = [{ name: 'LICENSE.md', url: licenseUrl, sha256: createHash('sha256').update(license).digest('hex') }];
    }
  }
  metadata.push(checksumUrl);
  return { name, version, archive, url, sha256: checksum(await readText(checksumUrl), archive), files, supplements, metadata_sources: metadata };
}

export async function resolveGitRelease(readText = releaseText) {
  const metadataUrl = 'https://api.github.com/repos/git-for-windows/git/releases/latest';
  const release = JSON.parse(await readText(metadataUrl));
  const tag = /^v(\d+\.\d+\.\d+)\.windows\.([1-9]\d*)$/.exec(release.tag_name);
  if (!tag || !versionPattern.test(tag[1]) || release.draft || release.prerelease) throw new Error('invalid_stable_release:git');
  const version = tag[1], revision = tag[2], archive = 'MinGit-' + version + (revision === '1' ? '' : '.' + revision) + '-64-bit.zip';
  const assets = release.assets?.filter(item => item.name === archive);
  const url = 'https://github.com/git-for-windows/git/releases/download/' + release.tag_name + '/' + archive;
  if (assets?.length !== 1 || assets[0].browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(assets[0].digest) ||
      !Number.isSafeInteger(assets[0].size) || assets[0].size <= 0 || assets[0].size > 256 * 1024 * 1024) throw new Error('git_release_asset_or_checksum_missing');
  return { name: 'git', version, archive, url, sha256: assets[0].digest.slice(7),
    reported_version: version + '.windows.' + revision, release_tag: release.tag_name, metadata_sources: [metadataUrl] };
}

// Windows upstream assets use ordinary ZIP (stored/deflated entries). Git
// retains its file tree; other tools use allowlists. ZIP64/encryption/multidisk
// are rejected.
export function extractPayload(bytes, destination, definition) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error('invalid_zip');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count || count === 65535 || start + size !== end) throw new Error('unsupported_zip');
  let offset = start, total = 0; const entries = new Map(), windowsNames = new Set();
  const nested = definition.name === 'git';
  if (nested && count > 10000) throw new Error('too_many_payload_files');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('invalid_zip');
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extra + comment; if (next > end) throw new Error('invalid_zip');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (/(^[/\\]|:|(^|[/\\])\.\.([/\\]|$))/.test(name) || name.includes('\0')) throw new Error('unsafe_zip_entry');
    const length = bytes.readUInt32LE(offset + 24), compressed = bytes.readUInt32LE(offset + 20), local = bytes.readUInt32LE(offset + 42);
    if (length > 256 * 1024 * 1024) throw new Error('zip_entry_too_large');
    if (entries.has(name)) throw new Error('missing_or_duplicate_payload');
    if (nested) {
      const clean = name.endsWith('/') ? name.slice(0,-1) : name;
      const type = (bytes.readUInt32LE(offset + 38) >>> 16) & 0xf000;
      if (!safePayloadName(clean) || windowsNames.has(clean.toLowerCase())) throw new Error('unsafe_zip_entry');
      if (![0, 0x4000, 0x8000].includes(type) || (type === 0x4000 && !name.endsWith('/'))) throw new Error('unsupported_zip_entry_type');
      windowsNames.add(clean.toLowerCase()); total += length;
      if (total > 512 * 1024 * 1024) throw new Error('zip_payload_too_large');
    }
    if (bytes.readUInt16LE(offset + 34) || bytes.readUInt16LE(offset + 8) & 1) throw new Error('unsupported_zip');
    entries.set(name, { length, compressed, local, method: bytes.readUInt16LE(offset + 10), crc: bytes.readUInt32LE(offset + 16) }); offset = next;
  }
  if (offset !== end) throw new Error('invalid_zip');
  const files = nested ? [...entries.keys()].filter(name => !name.endsWith('/')).map(name => ({ entry: name, name })) : definition.files;
  if (nested && !['cmd/git.exe', 'mingw64/bin/git.exe', 'LICENSE.txt'].every(name => entries.get(name)?.length)) throw new Error('missing_git_payload');
  for (const file of files) {
    if (!(nested ? safePayloadName(file.name) : /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(file.name))) throw new Error('invalid_payload_name');
    const entry = entries.get(file.entry); if (!entry || (!nested && !entry.length)) throw new Error('missing_or_duplicate_payload');
    const { local, compressed, length, method } = entry;
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) & 1) throw new Error('invalid_zip');
    const nameLength = bytes.readUInt16LE(local + 26), data = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    if (data + compressed > start || bytes.subarray(local + 30, local + 30 + nameLength).toString('utf8') !== file.entry) throw new Error('invalid_zip');
    const input = bytes.subarray(data, data + compressed);
    const output = method === 0 ? input : method === 8 ? inflateRawSync(input, { maxOutputLength: Math.max(1, length) }) : null;
    if (!output || output.length !== length) throw new Error('invalid_zip_payload');
    let crc = 0xffffffff;
    for (const byte of output) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error('invalid_zip_crc');
    if (nested) mkdirSync(dirname(join(destination, file.name)), { recursive: true });
    durableFile(join(destination, file.name), output);
  }
}

export async function installTool(root, definition, { receive = download, onPhase = () => {}, replace = false } = {}) {
  const name = definition.name;
  if (!['bun','node','gh','git'].includes(name) || !versionPattern.test(definition.version)) throw new Error('invalid_tool_definition');
  const target = join(root, name); plainPath(target);
  if (['bun','node'].includes(name) && existsSync(join(root,'.cache',`previous-${name}`))) throw new Error(`pending_runtime_recovery:${name}`);
  if (replace && (!['git','gh'].includes(name) || !managedToolValid(target,name,{allowDamaged:true}))) throw new Error('unknown_tool_ownership:' + name);
  const backup = join(root,'.cache','previous-' + name);
  if (replace && existsSync(backup)) throw new Error('pending_tool_recovery:' + name);
  if (existsSync(target) && !replace) {
    if (!managedToolValid(target,name)) throw new Error(`occupied_or_invalid_target:${name}`);
    if (JSON.parse(readFileSync(join(target,'install.json'),'utf8')).version !== definition.version) throw new Error(`installed_version_conflict:${name}`);
    removeStage(root,name); return { name, action: 'reused', path: join(target, managedExecutable(name)) };
  }
  removeStage(root,name);
  const stage = join(root,'.cache',name), payload = join(stage,'payload'); plainPath(payload); mkdirSync(payload,{ recursive: true });
  const receiveChecked = async (url, hash, destination) => {
    if (!/^[a-f0-9]{64}$/.test(hash) || new URL(url).protocol !== 'https:') throw new Error('invalid_download_definition');
    const bytes = await receive(url);
    if (bytes.length > 256 * 1024 * 1024) throw new Error('download_too_large');
    durableFile(destination, bytes);
    if (hashFile(destination) !== hash) throw new Error('download_hash_mismatch');
    return bytes;
  };
  const archive = await receiveChecked(definition.url,definition.sha256,join(stage,'download.part')); await onPhase('downloaded');
  extractPayload(archive,payload,definition);
  for (const file of definition.supplements || []) {
    if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(file.name)) throw new Error('invalid_supplement_name');
    await receiveChecked(file.url,file.sha256,join(payload,file.name));
  }
  await onPhase('extracted');
  const probe = await runCommand(join(payload,managedExecutable(name)),['--version'],{ timeoutMs: 5000 });
  if (!probe.ok || patterns[name].exec(probe.text)?.[1] !== definition.version ||
      (name === 'git' && probe.text !== 'git version ' + definition.reported_version)) throw new Error('installed_version_mismatch');
  const files = payloadFiles(payload, name === 'git').map(name => ({ name, length: lstatSync(join(payload,name)).size, sha256: hashFile(join(payload,name)) }));
  durableFile(join(payload,'install.json'),JSON.stringify({ schema: name === 'git' ? 'gidd.install/v2' : 'gidd.install/v1', name, installation_id: ['git','gh'].includes(name) ? randomUUID() : undefined, release_tag: definition.release_tag, platform: platformName(), version: definition.version,
    source: definition.url, archive_sha256: definition.sha256, files, metadata_sources: definition.metadata_sources }));
  if (!managedToolValid(payload,name)) throw new Error('staged_integrity_failed'); await onPhase('verified');
  // Caller holds the common install lock; unknown occupied destinations survive.
  if (replace) {
    if (!managedToolValid(target,name,{allowDamaged:true})) throw new Error('unknown_tool_ownership:' + name);
    renameSync(target,backup); await onPhase('backed_up');
  } else if (existsSync(target)) throw new Error(`occupied_or_invalid_target:${name}`);
  renameSync(payload,target); await onPhase('published');
  if (!managedToolValid(target,name)) throw new Error('published_integrity_failed'); removeStage(root,name);
  return { name, action: 'installed', path: join(target, managedExecutable(name)) };
}
