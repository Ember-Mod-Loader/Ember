const { once } = require('node:events');
const { createWriteStream } = require('node:fs');
const { lstat, mkdir, readdir, realpath } = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { crc32 } = require('node:zlib');
const yauzl = require('yauzl');

const MAX_ENTRIES = 20_000;
const MAX_EXPANDED_BYTES = 1024 ** 3;
const INVALID_CHARACTERS = /[<>:"\\|?*\x00-\x1f\x7f]/;
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

function pathParts(relative) {
  if (typeof relative !== 'string' || relative.length > 1024) {
    throw new Error('The archive contains an invalid path.');
  }
  const parts = relative.split('/');
  if (parts.length > 32 || parts.some(part =>
    !part || part.length > 255 || part === '.' || part === '..' ||
    INVALID_CHARACTERS.test(part) || /[. ]$/.test(part) ||
    RESERVED_DEVICE.test(part.split('.', 1)[0].trimEnd())
  )) {
    throw new Error('The archive contains an unsafe Windows path.');
  }
  return parts;
}

function addPath(registry, parts, isDirectory) {
  const newDirectories = [];
  let relative = '';
  for (let index = 0; index < parts.length; index++) {
    relative += (index === 0 ? '' : '/') + parts[index];
    const directory = isDirectory || index < parts.length - 1;
    const key = relative.normalize('NFC').toUpperCase();
    const existing = registry.get(key);
    if (existing) {
      if (existing.relative !== relative || !existing.directory || !directory) {
        throw new Error('The archive contains conflicting paths.');
      }
      continue;
    }
    registry.set(key, { relative, directory });
    if (directory) newDirectories.push(relative);
  }
  return newDirectories;
}

function validateEntry(entry, directory) {
  const attributes = entry.externalFileAttributes;
  const type = (attributes >>> 16) & 0o170000;
  if ((attributes & 0x400) || (type && type !== 0o100000 && type !== 0o040000)) {
    throw new Error('The archive contains a link or special file.');
  }
  if ((!directory && (type === 0o040000 || (attributes & 0x10))) ||
      (directory && (type === 0o100000 || entry.uncompressedSize !== 0))) {
    throw new Error('The archive contains invalid directory data.');
  }
  if ((entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) {
    throw new Error('The archive uses unsupported encryption or compression.');
  }
}

function verifyChecksum(expected) {
  let checksum = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      checksum = crc32(chunk, checksum);
      callback(null, chunk);
    },
    flush(callback) {
      callback(checksum === expected ? null : new Error('An archive entry failed its checksum.'));
    },
  });
}

// The caller owns the empty staging directory and discards it if extraction fails.
async function extractArchive(zipPath, destination, mapEntry = relative => relative) {
  if (!(await lstat(zipPath)).isFile()) {
    throw new Error('Choose a regular ZIP archive.');
  }
  if (!(await lstat(destination)).isDirectory() || (await readdir(destination)).length) {
    throw new Error('Archive extraction requires an empty staging directory.');
  }
  const root = await realpath(destination);
  const archive = await yauzl.openPromise(zipPath, {
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  });

  try {
    if (archive.entryCount > MAX_ENTRIES) {
      throw new Error('The archive exceeds the 20,000-entry limit.');
    }
    const sourcePaths = new Map();
    const outputPaths = new Map();
    let expanded = 0;
    let bytes = 0;
    let files = 0;
    for await (const entry of archive.eachEntry()) {
      const directory = entry.fileName.endsWith('/');
      const source = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      const parts = pathParts(source);
      validateEntry(entry, directory);
      addPath(sourcePaths, parts, directory);
      expanded += entry.uncompressedSize;
      if (expanded > MAX_EXPANDED_BYTES) {
        throw new Error('The archive exceeds the 1 GB expanded size limit.');
      }
      if (directory) continue;

      const mapped = mapEntry(source);
      if (mapped === null) continue;
      const output = pathParts(mapped);
      for (const relative of addPath(outputPaths, output, false)) {
        await mkdir(path.join(root, relative));
      }
      const contents = await archive.openReadStreamPromise(entry);
      await pipeline(contents, verifyChecksum(entry.crc32), createWriteStream(path.join(root, ...output), { flags: 'wx' }));
      bytes += entry.uncompressedSize;
      files++;
    }
    return { files, bytes };
  } finally {
    const closed = once(archive, 'close');
    archive.close();
    await closed;
  }
}

module.exports = { extractArchive };

