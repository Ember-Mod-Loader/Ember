const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, constants } = require('node:fs');
const { copyFile, lstat, mkdir, readFile, readdir, rename, unlink, rmdir, writeFile } = require('node:fs/promises');

const STATE_DIRECTORY = '.ember-mod-files';
const SOURCE_DIRECTORY = '.ember-game-files';
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

function relativeParts(value) {
  if (typeof value !== 'string' || value.length > 1024) throw new Error('Invalid game mod path.');
  const parts = value.split('/');
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || part.length > 255 ||
    /[<>:"\\|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) || RESERVED.test(part))) throw new Error('Unsafe game mod path.');
  if (/^\.(?:ember|modspindle|modrelay)/i.test(parts[0]) || /\.exe$/i.test(parts.at(-1))) {
    throw new Error('A mod cannot replace the game executable or Ember management files.');
  }
  if (/^(?:bepinex|melonloader|ue4ss|winhttp\.dll|version\.dll|dobby\.dll|doorstop_config\.ini|\.doorstop_version|unityplayer\.dll|dxgi\.dll|dinput8?\.dll|d3d\d+\.dll|winmm\.dll|dsound\.dll)$/i.test(parts[0])) {
    throw new Error('Game-root mods cannot replace loader or engine files. Use the selected loader package.');
  }
  return parts;
}

async function stat(file) {
  return lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
}

async function digest(file) {
  const metadata = await stat(file);
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Game mod files must be regular files.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function safePath(root, relative, createParents = false) {
  const parts = relativeParts(relative);
  let parent = root;
  const base = await stat(root);
  if (!base?.isDirectory() || base.isSymbolicLink()) throw new Error('Game mod folder is invalid.');
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (createParents && !(await stat(parent))) await mkdir(parent);
    const metadata = await stat(parent);
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw new Error('A game mod path crosses a link or non-folder.');
  }
  const file = path.join(root, ...parts);
  const metadata = await stat(file);
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) throw new Error('A game mod target is not a regular file.');
  return file;
}

async function listFiles(root) {
  const result = [];
  const keys = new Set();
  let bytes = 0;
  async function visit(directory, prefix = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + item.name;
      relativeParts(relative);
      const key = relative.normalize('NFC').toUpperCase();
      if (keys.has(key)) throw new Error('Game mod files contain conflicting paths.');
      keys.add(key);
      const full = path.join(directory, item.name);
      const metadata = await lstat(full);
      if (metadata.isSymbolicLink()) throw new Error('Game mod files cannot contain links.');
      if (metadata.isDirectory()) await visit(full, relative + '/');
      else if (metadata.isFile()) {
        bytes += metadata.size;
        result.push(relative);
        if (result.length > 20_000 || bytes > 1024 ** 3) throw new Error('Game mod files exceed the supported size.');
      } else throw new Error('Game mod files cannot contain special files.');
    }
  }
  const metadata = await stat(root);
  if (!metadata) return result;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Game mod source folder is invalid.');
  await visit(root);
  return result.sort();
}

function createGameFileManager(gameDir) {
  const directory = path.join(gameDir, STATE_DIRECTORY);
  const stateFile = path.join(directory, 'state.json');

  async function readState() {
    const metadata = await stat(directory);
    if (!metadata) return null;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Ember game file backups are invalid.');
    const stateInfo = await stat(stateFile);
    if (!stateInfo) {
      if ((await readdir(directory)).length) throw new Error('Ember found incomplete game file backups. Keep this folder for recovery.');
      return null;
    }
    if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.size > 8 * 1024 * 1024) throw new Error('Ember game file backup index is invalid.');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.files) || state.files.length > 20_000 ||
        (state.restored !== undefined && typeof state.restored !== 'boolean')) throw new Error('Ember game file backup index is invalid.');
    const keys = new Set();
    for (const [index, record] of state.files.entries()) {
      relativeParts(record.path);
      const key = record.path.normalize('NFC').toUpperCase();
      if (keys.has(key) || record.backup !== `${index}.bin` || !/^[a-f0-9]{64}$/.test(record.installed) ||
        (record.original !== null && !/^[a-f0-9]{64}$/.test(record.original))) throw new Error('Ember game file backup index is invalid.');
      keys.add(key);
    }
    return state;
  }

  async function saveState(state) {
    const temporary = path.join(directory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx' });
    try { await rename(temporary, stateFile); } finally { await unlink(temporary).catch(() => {}); }
  }

  async function replace(source, destination) {
    const temporary = path.join(path.dirname(destination), `.ember-copy-${randomUUID()}.tmp`);
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    try { await rename(temporary, destination); } finally { await unlink(temporary).catch(() => {}); }
  }

  async function restore() {
    const state = await readState();
    if (!state) return;
    // Keep the journal and originals until every restoration succeeds, including after a crash.
    for (const record of state.restored ? [] : state.files) {
      const target = await safePath(gameDir, record.path, record.original !== null);
      const current = await digest(target);
      const backup = path.join(directory, record.backup);
      if (current === record.original) continue;
      if (record.original !== null && await digest(backup) !== record.original) throw new Error('A game file backup changed. Ember kept the remaining backups for recovery.');
      if (current !== null && current !== record.installed && current !== record.original) {
        const recovery = path.join(directory, 'changed');
        await mkdir(recovery, { recursive: true });
        let saved = await safePath(recovery, record.path, true);
        const savedHash = await digest(saved);
        if (savedHash !== null && savedHash !== current) saved = `${saved}.${randomUUID()}`;
        if (savedHash !== current) await replace(target, saved);
      }
      if (current !== record.original) {
        if (record.original === null) { if (current !== null) await unlink(target); }
        else await replace(backup, target);
      }
    }
    state.restored = true;
    await saveState(state);
    // Cleanup can resume after interruption without requiring backups already removed here.
    for (const name of await readdir(directory)) {
      if (/^(?:\d+\.bin|state-[0-9a-f-]{36}\.tmp)$/.test(name)) {
        const file = path.join(directory, name);
        const metadata = await stat(file);
        if (metadata?.isFile() && !metadata.isSymbolicLink()) await unlink(file);
      }
    }
    // Modified mod files are retained for the user rather than deleted with the journal.
    if ((await readdir(directory)).some(name => name !== 'state.json')) {
      await rename(directory, path.join(gameDir, `.ember-recovered-${randomUUID()}`));
    } else {
      await unlink(stateFile);
      await rmdir(directory);
    }
  }

  async function apply(profileRoot) {
    const source = path.join(profileRoot, SOURCE_DIRECTORY);
    const files = await listFiles(source);
    // Validate the complete new plan before changing the old profile or any game file.
    for (const relative of files) await safePath(gameDir, relative);
    await restore();
    if (!files.length) return;
    await mkdir(directory, { recursive: true });
    const state = { version: 1, files: [] };
    await saveState(state);
    try {
      for (const relative of files) {
        const sourceFile = await safePath(source, relative);
        const target = await safePath(gameDir, relative, true);
        const original = await digest(target);
        const installed = await digest(sourceFile);
        const backup = `${state.files.length}.bin`;
        // Journal first: an interrupted backup copy is safe when the target is still original.
        state.files.push({ path: relative, backup, original, installed });
        await saveState(state);
        if (original !== null) {
          await copyFile(target, path.join(directory, backup), constants.COPYFILE_EXCL);
          if (await digest(target) !== original) throw new Error('A game file changed while preparing mods. Try again with the game closed.');
        }
        await replace(sourceFile, target);
        if (await digest(target) !== installed) throw new Error('A game mod file changed during installation.');
      }
    } catch (error) {
      try { await restore(); } catch { throw new Error(`${error.message} Game file recovery is incomplete; keep ${directory} for recovery.`); }
      throw error;
    }
  }
  return { apply, restore };
}

module.exports = { createGameFileManager, SOURCE_DIRECTORY };
