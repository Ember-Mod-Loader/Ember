const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { extractArchive } = require('./archive.cjs');
const { normalizeConfigFiles } = require('./config-files.cjs');

const GAME = 'lethal-company';
const GAMES = new Map([['lethal-company', 'Lethal Company'], ['repo', 'R.E.P.O.'], ['peak', 'PEAK']]);
const PRELOADER = 'BepInEx/core/BepInEx.Preloader.dll';
const LOADER_FILES = new Set(['winhttp.dll', 'doorstop_config.ini', '.doorstop_version']);
const PACKAGE_META = /^(?:manifest\.json|icon\.png|readme(?:\..*)?|changelog(?:\..*)?|license(?:\..*)?)$/i;
const FORMAT = 1;

function profileDirectory(root, id, gameId) {
  if (typeof id !== 'string' || (id !== `${gameId}-default` && !/^[0-9a-f-]{36}$/i.test(id))) {
    throw new Error(`Choose a valid ${GAMES.get(gameId)} profile.`);
  }
  return path.join(root, gameId, id.toLowerCase());
}

async function fileInfo(file) {
  return lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function copyTree(source, target, overwrite = false) {
  const info = await fileInfo(source);
  if (!info) return;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source)) await copyTree(path.join(source, name), path.join(target, name), overwrite);
  } else if (info.isFile()) {
    await copyFile(source, target, overwrite ? 0 : constants.COPYFILE_EXCL);
  } else {
    throw new Error('Profile files must be regular files or folders.');
  }
}

function loaderEntry(entry, packName) {
  const prefix = `${packName}/`;
  const file = entry.toLowerCase().startsWith(prefix.toLowerCase()) ? entry.slice(prefix.length) : entry;
  const known = /^(bepinex)\/(core|config)\/(.+)$/i.exec(file);
  if (known) return `BepInEx/${known[2].toLowerCase()}/${known[3]}`;
  return LOADER_FILES.has(file.toLowerCase()) ? file.toLowerCase() : null;
}

function modEntry(entry, directory) {
  if (PACKAGE_META.test(entry)) return null;
  const sharedCore = /^bepinex\/core\/(.+)$/i.exec(entry);
  if (sharedCore) return `BepInEx/core/${sharedCore[1]}`;
  const known = /^(?:bepinex\/)?(plugins|patchers|config)\/(.+)$/i.exec(entry);
  if (known) {
    const kind = known[1].toLowerCase();
    return kind === 'config' ? `BepInEx/config/${known[2]}` : `BepInEx/${kind}/${directory}/${known[2]}`;
  }
  if (/^bepinex\//i.test(entry) || LOADER_FILES.has(entry.toLowerCase())) {
    throw new Error('This package uses a game layout Ember cannot deploy.');
  }
  return `BepInEx/plugins/${directory}/${entry}`;
}

function createProfileBuilder(root, cache, { gameId = GAME } = {}) {
  if (!GAMES.has(gameId)) throw new Error('Choose a supported game for profile preparation.');
  const active = new Map();

  async function prepareProfile(id, entries, importedConfigFiles = {}) {
    const base = profileDirectory(root, id, gameId);
    const configFiles = normalizeConfigFiles(importedConfigFiles);
    if (!Array.isArray(entries) || entries.length > 200) throw new Error('Choose up to 200 enabled packages for this profile.');
    const refs = entries.map(entry => {
      if (typeof entry?.namespace !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(entry.namespace) ||
          typeof entry.name !== 'string' || !/^[a-z0-9_]{1,128}$/i.test(entry.name) ||
          typeof entry.version !== 'string' || !/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(entry.version)) {
        throw new Error('This profile contains an invalid package.');
      }
      return { namespace: entry.namespace, name: entry.name, version: entry.version };
    }).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
    const loaderName = gameId === 'peak' ? 'BepInExPack_PEAK' : 'BepInExPack';
    const loader = refs.find(ref => ref.namespace === 'BepInEx' && ref.name === loaderName);
    if (!loader) throw new Error(`Download and enable ${loaderName} in this ${GAMES.get(gameId)} profile.`);
    const key = createHash('sha256').update(JSON.stringify({ format: FORMAT, refs,
      ...(Object.keys(configFiles).length ? { configFiles } : {}) })).digest('hex');
    if (active.has(base)) throw new Error('This profile is already being prepared.');
    const operation = build(base, key, loader, refs, configFiles);
    active.set(base, operation);
    try {
      return await operation;
    } finally {
      active.delete(base);
    }
  }

  async function build(base, key, loader, refs, configFiles) {
    const runtime = path.join(base, 'runtime');
    const marker = '.modspindle-profile';
    const current = await fileInfo(runtime);
    if (current && (!current.isDirectory() || current.isSymbolicLink())) throw new Error('The profile folder is invalid.');
    const previousKey = await readFile(path.join(runtime, marker), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (previousKey === key && (await fileInfo(path.join(runtime, PRELOADER)))?.isFile()) return runtime;

    await mkdir(base, { recursive: true });
    const stage = await mkdtemp(path.join(base, 'stage-'));
    const next = path.join(stage, 'runtime');
    const backup = path.join(base, `backup-${randomUUID()}`);
    try {
      await mkdir(next);
      const packageList = [loader, ...refs.filter(ref => ref !== loader &&
        !(gameId === 'peak' && ref.namespace === 'BepInEx' && ref.name === 'BepInExPack'))];
      for (const [index, ref] of packageList.entries()) {
        const { filename } = await cache.downloadPackage({ gameId, ...ref });
        const archive = path.join(cache.root, gameId, filename);
        const part = path.join(stage, `package-${index}`);
        const identity = `${ref.namespace}/${ref.name}`;
        const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 12);
        const folder = `${ref.namespace.slice(0, 20)}-${ref.name.slice(0, 40)}-${suffix}`;
        await mkdir(part);
        try {
          await extractArchive(archive, part, ref === loader ? entry => loaderEntry(entry, loader.name) : entry => modEntry(entry, folder));
          if (ref === loader && (!(await fileInfo(path.join(part, PRELOADER)))?.isFile() ||
              !(await fileInfo(path.join(part, 'winhttp.dll')))?.isFile() ||
              !(await fileInfo(path.join(part, 'doorstop_config.ini')))?.isFile())) {
            throw new Error('BepInExPack is missing its Windows loader files.');
          }
          await copyTree(part, next);
          await rm(part, { recursive: true, force: true });
        } catch (error) {
          throw new Error(`Could not deploy ${ref.name} v${ref.version}. ${error.code === 'EEXIST' ? 'Another package supplies the same file.' : error.message}`);
        }
      }
      for (const [relative, content] of Object.entries(configFiles)) {
        const target = path.join(next, 'BepInEx', 'config', ...relative.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
      }
      if (current) await copyTree(path.join(runtime, 'BepInEx', 'config'), path.join(next, 'BepInEx', 'config'), true);
      await writeFile(path.join(next, marker), key, { flag: 'wx' });
      if (current) await rename(runtime, backup);
      try {
        await rename(next, runtime);
      } catch (error) {
        if (current) await rename(backup, runtime);
        throw error;
      }
      if (current) await rm(backup, { recursive: true, force: true }).catch(() => {});
      return runtime;
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function openProfilePath(id) {
    const runtime = path.join(profileDirectory(root, id, gameId), 'runtime');
    if (!(await fileInfo(runtime))?.isDirectory()) throw new Error('Prepare this profile first.');
    return runtime;
  }

  return { prepareProfile, openProfilePath };
}

module.exports = { createProfileBuilder };
