const { createHash, randomUUID } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { lstat, mkdir, open, rename, rm } = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const GAMES = new Set(['lethal-company', 'repo', 'peak', 'mimesis', 'risk-of-rain-2', 'valheim']);
const DOWNLOAD_HOSTS = new Set(['thunderstore.io', 'old.thunderstore.io', 'www.thunderstore.io']);
const ARCHIVE_HOSTS = new Set(['cdn.thunderstore.io', 'ccdn.thunderstore.io', 'gcdn.thunderstore.io']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_ARCHIVE_TRANSFERS = 6;
const MAX_ARCHIVE_BYTES = 1024 ** 3;
const ZIP_HEADER = 0x04034b50;
const ZIP_END = 0x06054b50;
const ZIP_END_LENGTH = 22;

function packageIdentity(input) {
  const { gameId, namespace, name, version } = input ?? {};
  if (!GAMES.has(gameId) || typeof namespace !== 'string' || !/^[\w-]{1,128}$/.test(namespace) ||
      typeof name !== 'string' || !/^\w{1,128}$/.test(name) ||
      typeof version !== 'string' || !/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(version)) {
    throw new Error('Choose a valid Thunderstore package and version.');
  }
  return { gameId, namespace, name, version };
}

function cacheFilename(identity, archiveName) {
  const { namespace, name, version } = identity;
  // Thunderstore names are case-sensitive, while Windows cache paths usually aren't.
  const suffix = createHash('sha256').update(archiveName).digest('hex').slice(0, 16);
  return `${namespace.slice(0, 20)}-${name.slice(0, 52)}-${version}-${suffix}.zip`;
}

function assertDownloadUrl(url, downloadPath, archiveName) {
  const packageRoute = DOWNLOAD_HOSTS.has(url.hostname) && url.pathname === downloadPath;
  const archiveRoute = ARCHIVE_HOSTS.has(url.hostname) && url.pathname.endsWith(`/${archiveName}`);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !(packageRoute || archiveRoute)) {
    throw new Error('Thunderstore returned an unexpected download address.');
  }
}

async function requestArchive(fetchArchive, identity, archiveName, signal) {
  const { namespace, name, version } = identity;
  const downloadPath = `/package/download/${namespace}/${name}/${version}/`;
  let url = new URL(downloadPath, 'https://thunderstore.io');
  for (let count = 0; count < 5; count++) {
    assertDownloadUrl(url, downloadPath, archiveName);
    let response;
    try {
      response = await fetchArchive(url, { signal, redirect: 'manual', credentials: 'omit' });
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      throw new Error('Could not reach Thunderstore. Try the download again.', { cause });
    }
    if (!REDIRECTS.has(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) break;
    try {
      url = new URL(location, url);
    } catch {
      throw new Error('Thunderstore returned an invalid download address.');
    }
  }
  throw new Error('Thunderstore returned too many download redirects.');
}

async function zipSize(file) {
  const info = await lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isFile() || info.size < ZIP_END_LENGTH || info.size > MAX_ARCHIVE_BYTES) return 0;

  const archive = await open(file, 'r');
  try {
    const header = Buffer.alloc(4);
    const tail = Buffer.alloc(Math.min(info.size, ZIP_END_LENGTH + 65535));
    const headerRead = await archive.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length || header.readUInt32LE() !== ZIP_HEADER) return 0;
    const tailRead = await archive.read(tail, 0, tail.length, info.size - tail.length);
    if (tailRead.bytesRead !== tail.length) return 0;
    for (let offset = tail.length - ZIP_END_LENGTH; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) !== ZIP_END ||
          offset + ZIP_END_LENGTH + tail.readUInt16LE(offset + 20) !== tail.length) continue;
      return info.size;
    }
    return 0;
  } finally {
    await archive.close();
  }
}

async function storeArchive(fetchArchive, identity, archiveName, target, report) {
  const signal = AbortSignal.timeout(4 * 60 * 1000);
  const temporary = path.join(path.dirname(target), `.modrelay-${randomUUID()}.download`);
  const maxSizeMessage = 'This package exceeds Ember’s 1 GB download limit.';
  try {
    const response = await requestArchive(fetchArchive, identity, archiveName, signal);
    if (!response.ok || response.status !== 200 || !response.body) {
      await response.body?.cancel();
      const message = response.status === 404 ? 'That package version is unavailable on Thunderstore.'
        : response.status === 429 ? 'Thunderstore is limiting requests. Try again in a moment.'
          : `Thunderstore could not serve this download (HTTP ${response.status}).`;
      throw new Error(message);
    }

    const lengthHeader = response.headers.get('content-length');
    const declaredSize = lengthHeader === null ? null : Number(lengthHeader);
    if (declaredSize > MAX_ARCHIVE_BYTES) {
      await response.body.cancel();
      throw new Error(maxSizeMessage);
    }

    const encoding = response.headers.get('content-encoding');
    const total = (!encoding || encoding === 'identity') && Number.isSafeInteger(declaredSize) && declaredSize >= 0
      ? declaredSize : null;
    let received = 0;
    let lastReported = Date.now();
    report({ received, total, status: 'downloading' });
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_ARCHIVE_BYTES) callback(new Error(maxSizeMessage));
        else {
          const now = Date.now();
          if (now - lastReported >= 100) {
            report({ received, total, status: 'downloading' });
            lastReported = now;
          }
          callback(null, chunk);
        }
      },
    });
    await pipeline(response.body, limit, createWriteStream(temporary, { flags: 'wx' }), { signal });
    report({ received, total, status: 'downloading' });
    const bytes = await zipSize(temporary);
    if (!bytes || (declaredSize !== null && (!encoding || encoding === 'identity') && bytes !== declaredSize)) {
      throw new Error('Thunderstore did not return a complete ZIP archive. Try the download again.');
    }
    await rename(temporary, target);
    return bytes;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (signal.aborted) throw new Error('The Thunderstore download timed out. Try again.');
    if (error.code === 'ENOSPC') throw new Error('There is insufficient disk space to save this package.');
    if (error.code === 'EPERM' || error.code === 'EACCES') throw new Error('Ember could not write to its download folder.');
    if (error.message === 'terminated') throw new Error('The Thunderstore connection was interrupted. Try again.');
    throw error;
  }
}

function createPackageCache(root, fetchArchive = globalThis.fetch) {
  const pending = new Map();
  const waitingTransfers = [];
  let activeTransfers = 0;

  async function downloadPackage(input, onProgress) {
    const identity = packageIdentity(input);
    const { gameId, namespace, name, version } = identity;
    const archiveName = `${namespace}-${name}-${version}.zip`;
    const filename = cacheFilename(identity, archiveName);
    const folder = path.join(root, gameId);
    const target = path.join(folder, filename);
    let transfer = pending.get(target);
    if (!transfer) {
      transfer = { listeners: new Set(), latest: null, promise: null };
      pending.set(target, transfer);
      const report = progress => {
        transfer.latest = Object.freeze(progress);
        for (const listener of transfer.listeners) {
          try { listener(transfer.latest); } catch {}
        }
      };
      transfer.promise = (async () => {
        await mkdir(folder, { recursive: true });
        const bytes = await zipSize(target);
        if (bytes) {
          report({ received: bytes, total: bytes, status: 'complete', cached: true });
          return { filename, bytes, cached: true };
        }
        if (activeTransfers === MAX_ARCHIVE_TRANSFERS) {
          await new Promise(resolve => waitingTransfers.push(resolve));
        } else {
          activeTransfers++;
        }
        try {
          report({ received: 0, total: null, status: 'downloading' });
          const savedBytes = await storeArchive(fetchArchive, identity, archiveName, target, report);
          report({ received: savedBytes, total: savedBytes, status: 'complete', cached: false });
          return { filename, bytes: savedBytes, cached: false };
        } finally {
          // Pass the occupied slot directly to the next transfer in line.
          const next = waitingTransfers.shift();
          if (next) next();
          else activeTransfers--;
        }
      })().finally(() => pending.delete(target));
    }
    const listener = typeof onProgress === 'function' ? onProgress : null;
    if (listener) {
      transfer.listeners.add(listener);
      if (transfer.latest) {
        try { listener(transfer.latest); } catch {}
      }
    }
    try {
      return await transfer.promise;
    } finally {
      if (listener) transfer.listeners.delete(listener);
    }
  }

  async function openFolderPath() {
    await mkdir(root, { recursive: true });
    return root;
  }

  return { root, downloadPackage, openFolderPath };
}

module.exports = { createPackageCache };
