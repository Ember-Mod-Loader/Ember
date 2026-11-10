const MAX_CONFIG_FILES = 128;
const MAX_CONFIG_FILE_BYTES = 256 * 1024;
const MAX_CONFIG_TOTAL_BYTES = 1024 * 1024;
const CONFIG_EXTENSION = /\.(?:cfg|json|txt|ya?ml|xml|ini|conf|toml|done)$/i;
const INVALID_CHARACTER = /[<>:"\\|?*\x00-\x1f\x7f]/;
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

function normalizeConfigFiles(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length > MAX_CONFIG_FILES) throw new Error('Choose up to 128 configuration files.');
  const paths = new Map();
  const files = [];
  let bytes = 0;
  for (const [relative, content] of Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const parts = relative.split('/');
    if (!relative.isWellFormed() || relative.length > 512 || parts.length > 16 || !CONFIG_EXTENSION.test(relative) || parts.some(part =>
      !part || part.length > 255 || part === '.' || part === '..' || INVALID_CHARACTER.test(part) ||
      /[. ]$/.test(part) || RESERVED_DEVICE.test(part.split('.', 1)[0].trimEnd()))) {
      throw new Error('This profile contains an unsupported configuration path.');
    }
    let combined = '';
    for (const [index, part] of parts.entries()) {
      combined += (index ? '/' : '') + part;
      const key = combined.normalize('NFC').toUpperCase();
      const directory = index < parts.length - 1;
      const existing = paths.get(key);
      if (existing && (existing.path !== combined || !existing.directory || !directory)) {
        throw new Error('This profile contains conflicting configuration paths.');
      }
      paths.set(key, { path: combined, directory });
    }
    if (typeof content !== 'string' || !content.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) || Buffer.byteLength(content, 'utf8') > MAX_CONFIG_FILE_BYTES) {
      throw new Error('Configuration files must be text up to 256 KB each.');
    }
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_CONFIG_TOTAL_BYTES) throw new Error('Profile configuration files exceed 1 MB.');
    files.push([relative, content]);
  }
  return Object.fromEntries(files);
}

module.exports = { normalizeConfigFiles, CONFIG_EXTENSION, MAX_CONFIG_FILES, MAX_CONFIG_FILE_BYTES, MAX_CONFIG_TOTAL_BYTES };
