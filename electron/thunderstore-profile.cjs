const { crc32 } = require('node:zlib');
const { buffer: readStream } = require('node:stream/consumers');
const yauzl = require('yauzl');
const { ZipFile } = require('yazl');
const yaml = require('js-yaml');
const { normalizeConfigFiles, CONFIG_EXTENSION, MAX_CONFIG_TOTAL_BYTES } = require('./config-files.cjs');
const { MAX_PROFILE_MODS } = require('./profile-limits.json');

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_NATIVE_PROFILE_BYTES = Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4 + 128;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_PROFILE_METADATA_BYTES = 256 * 1024;
const MAX_ARCHIVE_ENTRIES = 10000;
const PROFILE_MARKER = '#r2modman';
const GAMES = new Set(['lethal-company', 'repo', 'peak', 'mimesis']);
// Mod lists come from export.r2x; Ember uses the selected loader's configuration.
const MANAGER_FILE = /^(?:mods\.yml|doorstop_config\.ini)$/i;
const INVALID_CHARACTER = /[<>:"\\|?*\x00-\x1f\x7f]/;
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

function validatePath(name, registry, directory) {
  const relative = directory ? name.slice(0, -1) : name;
  const parts = relative.split('/');
  if (relative.length > 512 || parts.length > 16 || parts.some(part => !part || part.length > 255 ||
      part === '.' || part === '..' || INVALID_CHARACTER.test(part) || /[. ]$/.test(part) ||
      RESERVED_DEVICE.test(part.split('.', 1)[0].trimEnd()))) throw new Error('The profile contains an unsafe Windows path.');
  let current = '';
  for (const [index, part] of parts.entries()) {
    current += (index ? '/' : '') + part;
    const key = current.normalize('NFC').toUpperCase();
    const isDirectory = directory || index < parts.length - 1;
    const old = registry.get(key);
    if (old && (old.path !== current || !old.directory || !isDirectory)) throw new Error('The profile contains conflicting paths.');
    registry.set(key, { path: current, directory: isDirectory });
  }
}

function decodeText(data) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new Error('Profile configuration files must contain UTF-8 text.'); }
  if (text.includes('\0')) throw new Error('The profile contains a binary configuration file.');
  return text;
}

function parseManifest(text) {
  let value;
  try {
    value = yaml.load(text, { schema: yaml.JSON_SCHEMA, listener(event, state) {
      if (event === 'close' && state.anchor) throw new Error('Aliases are unsupported.');
    } });
  } catch { throw new Error('The Thunderstore profile manifest is invalid.'); }
  if (!value || typeof value.profileName !== 'string' || !value.profileName.trim() ||
      value.profileName.trim().length > 60 || !Array.isArray(value.mods) || value.mods.length > MAX_PROFILE_MODS) {
    throw new Error(`Choose a Thunderstore profile with a name up to 60 characters and up to ${MAX_PROFILE_MODS} mods.`);
  }
  const seen = new Set();
  const mods = value.mods.map(mod => {
    const match = typeof mod?.name === 'string' && /^([a-z0-9_-]{1,64})-([a-z0-9_]{1,128})$/i.exec(mod.name);
    if (!match || !mod.version || ['major', 'minor', 'patch'].some(part =>
      !Number.isSafeInteger(mod.version[part]) || mod.version[part] < 0 || mod.version[part] > 9999999999) ||
      (mod.enabled !== undefined && typeof mod.enabled !== 'boolean')) throw new Error('The profile contains an invalid mod or version.');
    const [, namespace, name] = match;
    const key = `${namespace}/${name}`;
    if (seen.has(key)) throw new Error('The profile contains duplicate mods.');
    seen.add(key);
    return { namespace, name, version: `${mod.version.major}.${mod.version.minor}.${mod.version.patch}`, enabled: mod.enabled ?? true };
  });
  return { name: value.profileName.trim(), mods };
}

async function encodeThunderstoreProfile(profile) {
  if (!profile.mods.length || profile.mods.length > MAX_PROFILE_MODS) {
    throw new Error(`Choose a profile with 1 to ${MAX_PROFILE_MODS} mods to create a Thunderstore code.`);
  }
  const seen = new Set();
  const mods = profile.mods.map(entry => {
    const { namespace, name } = entry?.package ?? {};
    if (typeof namespace !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(namespace) ||
        typeof name !== 'string' || !/^[a-z0-9_]{1,128}$/i.test(name) ||
        entry.id !== `${profile.gameId}/${namespace}/${name}` ||
        typeof entry.version !== 'string' || !/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(entry.version) ||
        entry.version !== entry.package.version || typeof entry.enabled !== 'boolean') {
      throw new Error('The profile contains a mod or version that cannot be shared with Thunderstore.');
    }
    const fullName = `${namespace}-${name}`;
    if (seen.has(fullName)) throw new Error('The profile contains duplicate mods.');
    seen.add(fullName);
    const [major, minor, patch] = entry.version.split('.').map(Number);
    return { name: fullName, version: { major, minor, patch }, enabled: entry.enabled };
  });
  // The recipient's profile name field accepts ASCII letters, digits, and a few separators.
  const name = profile.name.normalize('NFKD').replace(/\p{Mark}/gu, '').replace(/[^a-z0-9_. -]+/gi, ' ')
    .replace(/^[_. -]+/, '');
  const portableName = RESERVED_DEVICE.test(name.split('.', 1)[0].trimEnd()) ? `Ember ${name}` : name;
  const profileName = portableName.slice(0, 60).replace(/[. ]+$/, '') || 'Ember profile';
  const manifest = yaml.dump({ profileName, mods }, { noRefs: true });
  const files = [['export.r2x', manifest]];
  const paths = new Map();
  for (const [folder, settings] of [['config', profile.configFiles], ['UserData', profile.userDataFiles]]) {
    for (const [relative, content] of Object.entries(normalizeConfigFiles(settings))) {
      const path = `${folder}/${relative}`;
      validatePath(path, paths, false);
      files.push([path, content]);
    }
  }

  const zip = new ZipFile();
  // Stable timestamps let the sharing service reuse a code for an unchanged snapshot.
  const mtime = new Date(2020, 0, 1);
  for (const [path, content] of files) zip.addBuffer(Buffer.from(content, 'utf8'), path, { mtime });
  zip.end();
  return `${PROFILE_MARKER}\n${(await readStream(zip.outputStream)).toString('base64')}`;
}

async function parseThunderstoreProfile(value, gameId) {
  if (!GAMES.has(gameId)) throw new Error('Choose a supported game before importing.');
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_NATIVE_PROFILE_BYTES || !value.startsWith(PROFILE_MARKER)) {
    throw new Error('This code does not contain a supported Thunderstore profile.');
  }
  const encoded = value.slice(PROFILE_MARKER.length).trim();
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('The Thunderstore profile archive is invalid.');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > MAX_ARCHIVE_BYTES || buffer.toString('base64') !== encoded) throw new Error('The Thunderstore profile exceeds the 20 MB archive limit.');
  let archive;
  // Windows profile exports can use backslashes. yauzl normalizes them before our path checks.
  try { archive = await yauzl.fromBufferPromise(buffer, { autoClose: false, strictFileNames: false, validateEntrySizes: true }); }
  catch { throw new Error('The Thunderstore profile archive could not be read.'); }
  let manifest;
  const configFiles = Object.create(null);
  const userDataFiles = Object.create(null);
  const skipped = [];
  const registry = new Map();
  let expanded = 0;
  try {
    if (archive.entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('The profile archive contains more than 10,000 files and folders.');
    for await (const entry of archive.eachEntry()) {
      const directory = entry.fileName.endsWith('/');
      validatePath(entry.fileName, registry, directory);
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if ((entry.externalFileAttributes & 0x400) || (type && type !== 0o100000 && type !== 0o040000) ||
          (!directory && (type === 0o040000 || (entry.externalFileAttributes & 0x10))) ||
          (directory && (type === 0o100000 || entry.uncompressedSize !== 0))) throw new Error('Profile archives cannot contain links or special files.');
      if ((entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) throw new Error('The profile uses unsupported archive encryption or compression.');
      expanded += entry.uncompressedSize;
      if (expanded > MAX_EXPANDED_BYTES) throw new Error('The profile exceeds the 16 MB expanded limit.');
      if (directory) continue;
      const isManifest = entry.fileName === 'export.r2x';
      const config = /^(?:BepInEx\/)?config\/(.+)$/i.exec(entry.fileName);
      const userData = /^UserData\/(.+)$/i.exec(entry.fileName);
      const inSettings = Boolean(config || userData);
      const isSettings = inSettings && CONFIG_EXTENSION.test(entry.fileName);
      const readText = isManifest || isSettings || MANAGER_FILE.test(entry.fileName);
      if (isSettings && entry.uncompressedSize > MAX_CONFIG_TOTAL_BYTES) {
        throw new Error(`${entry.fileName} exceeds the 2 MiB configuration size limit.`);
      }
      if ((isManifest || /^doorstop_config\.ini$/i.test(entry.fileName)) && entry.uncompressedSize > MAX_PROFILE_METADATA_BYTES) {
        throw new Error(`${entry.fileName} exceeds the 256 KB size limit for profile metadata.`);
      }
      const stream = await archive.openReadStreamPromise(entry);
      const chunks = [];
      let bytes = 0, checksum = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize) { stream.destroy(); throw new Error('A profile file expands beyond its declared size.'); }
        checksum = crc32(chunk, checksum);
        if (readText) chunks.push(chunk);
      }
      if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error('A profile entry failed its checksum.');
      if (!readText) {
        const reason = inSettings ? 'unsupported settings file type' : 'outside the supported settings folders';
        skipped.push(`${entry.fileName} (${reason})`);
        continue;
      }
      const text = decodeText(Buffer.concat(chunks));
      if (isManifest) manifest = parseManifest(text);
      else if (config) {
        if (Object.hasOwn(configFiles, config[1])) throw new Error('The profile contains conflicting configuration paths.');
        configFiles[config[1]] = text;
      } else if (userData) {
        if (Object.hasOwn(userDataFiles, userData[1])) throw new Error('The profile contains conflicting configuration paths.');
        userDataFiles[userData[1]] = text;
      }
    }
    if (!manifest) throw new Error('The Thunderstore profile is missing export.r2x.');
    const warnings = skipped.slice(0, 10);
    if (skipped.length > 10) warnings.push(`${skipped.length - 10} more files from the export will be skipped.`);
    return { ...manifest, gameId, configFiles: normalizeConfigFiles(configFiles),
      userDataFiles: normalizeConfigFiles(userDataFiles), importWarnings: warnings };
  } finally { archive.close(); }
}

module.exports = { encodeThunderstoreProfile, parseThunderstoreProfile, MAX_NATIVE_PROFILE_BYTES, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES };
