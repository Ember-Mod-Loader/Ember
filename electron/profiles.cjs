const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { extractArchive } = require('./archive.cjs');
const { normalizeConfigFiles } = require('./config-files.cjs');
const { MAX_PROFILE_MODS } = require('./profile-limits.json');
const { chooseLoader } = require('./loaders.cjs');
const { createPackageMapper } = require('./package-layout.cjs');

const GAME = 'lethal-company';
const GAMES = new Map([['lethal-company', 'Lethal Company'], ['repo', 'R.E.P.O.'], ['peak', 'PEAK'], ['mimesis', 'MIMESIS']]);
const PRELOADER = 'BepInEx/core/BepInEx.Preloader.dll';
const FORMAT = 2;
const DEFAULT_RUNTIME = 'runtime';
const ACTIVE_RUNTIME = '.ember-runtime';
const RUNTIME_MARKER = '.modspindle-profile';
const GENERATED_RUNTIME = /^runtime-[a-f0-9]{16}$/;
const RETIRED_RUNTIME = /^retired-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const LOCK_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);

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

async function selectedRuntime(base) {
  const selection = path.join(base, ACTIVE_RUNTIME);
  const info = await fileInfo(selection);
  if (!info) return DEFAULT_RUNTIME;
  if (!info.isFile() || info.size !== 24) throw new Error('Ember could not read the active profile folder.');
  const name = await readFile(selection, 'utf8');
  if (!GENERATED_RUNTIME.test(name)) throw new Error('Ember could not read the active profile folder.');
  return name;
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

async function hasLoader(directory, kind) {
  const required = kind === 'melonloader'
    ? ['MelonLoader/net35/MelonLoader.dll', 'MelonLoader/net6/MelonLoader.dll']
    : [PRELOADER, 'winhttp.dll', 'doorstop_config.ini'];
  for (const file of required) {
    if (!(await fileInfo(path.join(directory, file)))?.isFile()) return false;
  }
  if (kind === 'melonloader') {
    const proxies = await Promise.all(['version.dll', 'winhttp.dll'].map(async file => (await fileInfo(path.join(directory, file)))?.isFile()));
    if (proxies.filter(Boolean).length !== 1) return false;
  }
  return true;
}

function createProfileBuilder(root, cache, { gameId = GAME, renamePath = rename, retryDelay = delay } = {}) {
  if (!GAMES.has(gameId)) throw new Error('Choose a supported game for profile preparation.');
  const active = new Map();

  async function renameWithRetry(source, target) {
    for (const wait of [40, 100, 200]) {
      try {
        return await renamePath(source, target);
      } catch (error) {
        if (!LOCK_ERRORS.has(error.code)) throw error;
        await retryDelay(wait);
      }
    }
    return renamePath(source, target);
  }

  async function retireRuntime(runtime) {
    const retired = path.join(path.dirname(runtime), `retired-${randomUUID()}`);
    try {
      if (!(await fileInfo(runtime))?.isDirectory() || !(await fileInfo(path.join(runtime, RUNTIME_MARKER)))?.isFile()) return;
      // A failed rename leaves the old runtime intact even if one file is locked.
      await renamePath(runtime, retired);
      await rm(retired, { recursive: true, force: true });
    } catch { /* Try again when the profile is next prepared. */ }
  }

  async function retireInactiveRuntimes(base, currentName) {
    const names = await readdir(base).catch(() => []);
    for (const name of names) {
      if (RETIRED_RUNTIME.test(name)) {
        await rm(path.join(base, name), { recursive: true, force: true }).catch(() => {});
      } else if (name !== currentName && (name === DEFAULT_RUNTIME || GENERATED_RUNTIME.test(name))) {
        await retireRuntime(path.join(base, name));
      }
    }
  }

  async function activateNewRuntime(base, stage, next) {
    const name = `runtime-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const runtime = path.join(base, name);
    const selection = path.join(stage, ACTIVE_RUNTIME);
    await writeFile(selection, name, { flag: 'wx' });
    await renameWithRetry(next, runtime);
    try {
      // Commit only after the new runtime is complete and in its final location.
      await renameWithRetry(selection, path.join(base, ACTIVE_RUNTIME));
    } catch (error) {
      await retireRuntime(runtime);
      throw error;
    }
    return runtime;
  }

  async function prepareProfile(id, entries, importedConfigFiles = {}, importedUserDataFiles = {}) {
    const base = profileDirectory(root, id, gameId);
    const configFiles = normalizeConfigFiles(importedConfigFiles);
    const userDataFiles = normalizeConfigFiles(importedUserDataFiles);
    if (!Array.isArray(entries) || entries.length > MAX_PROFILE_MODS) {
      throw new Error(`Choose up to ${MAX_PROFILE_MODS} enabled packages for this profile.`);
    }
    const refs = entries.map(entry => {
      if (typeof entry?.namespace !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(entry.namespace) ||
          typeof entry.name !== 'string' || !/^[a-z0-9_]{1,128}$/i.test(entry.name) ||
          typeof entry.version !== 'string' || !/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(entry.version)) {
        throw new Error('This profile contains an invalid package.');
      }
      return { namespace: entry.namespace, name: entry.name, version: entry.version };
    }).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
    const loader = chooseLoader(refs, gameId);
    const key = createHash('sha256').update(JSON.stringify({ format: FORMAT, refs,
      ...(Object.keys(configFiles).length ? { configFiles } : {}),
      ...(Object.keys(userDataFiles).length ? { userDataFiles } : {}) })).digest('hex');
    if (active.has(base)) throw new Error('This profile is already being prepared.');
    const operation = build(base, key, loader, refs, configFiles, userDataFiles);
    active.set(base, operation);
    try {
      return await operation;
    } catch (error) {
      if (LOCK_ERRORS.has(error.code)) {
        throw new Error('Windows is blocking access to this profile. Close any programs using its files and try again.', { cause: error });
      }
      throw error;
    } finally {
      active.delete(base);
    }
  }

  async function build(base, key, loader, refs, configFiles, userDataFiles) {
    const currentName = await selectedRuntime(base);
    const runtime = path.join(base, currentName);
    const current = await fileInfo(runtime);
    if (current && (!current.isDirectory() || current.isSymbolicLink())) throw new Error('The profile folder is invalid.');
    const previousKey = await readFile(path.join(runtime, RUNTIME_MARKER), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (previousKey === key && await hasLoader(runtime, loader.kind)) {
      if (currentName !== DEFAULT_RUNTIME) await retireInactiveRuntimes(base, currentName);
      return runtime;
    }

    await mkdir(base, { recursive: true });
    const stage = await mkdtemp(path.join(base, 'stage-'));
    const next = path.join(stage, 'runtime');
    const backup = path.join(base, `backup-${randomUUID()}`);
    try {
      await mkdir(next);
      const packageList = [loader.ref, ...refs.filter(ref => ref !== loader.ref &&
        !(gameId === 'peak' && ref.namespace === 'BepInEx' && ref.name === 'BepInExPack'))];
      for (const [index, ref] of packageList.entries()) {
        const { filename } = await cache.downloadPackage({ gameId, ...ref });
        const archive = path.join(cache.root, gameId, filename);
        const part = path.join(stage, `package-${index}`);
        const identity = `${ref.namespace}/${ref.name}`;
        const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 12);
        const folder = loader.kind === 'melonloader' ? `${ref.namespace}-${ref.name}` : `${ref.namespace.slice(0, 20)}-${ref.name.slice(0, 40)}-${suffix}`;
        await mkdir(part);
        try {
          const mapper = await createPackageMapper(archive, { directory: folder, gameId, loader, isLoader: ref === loader.ref });
          await extractArchive(archive, part, mapper);
          if (ref === loader.ref && !await hasLoader(part, loader.kind)) {
            throw new Error(`${loader.name} is missing its Windows loader files.`);
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
      for (const [relative, content] of Object.entries(userDataFiles)) {
        const target = path.join(next, 'UserData', ...relative.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
      }
      if (current) await copyTree(path.join(runtime, 'BepInEx', 'config'), path.join(next, 'BepInEx', 'config'), true);
      if (current) await copyTree(path.join(runtime, 'UserData'), path.join(next, 'UserData'), true);
      await writeFile(path.join(next, '.ember-loader.json'), JSON.stringify({ kind: loader.kind, name: loader.name, version: loader.ref.version }), { flag: 'wx' });
      await writeFile(path.join(next, RUNTIME_MARKER), key, { flag: 'wx' });
      if (currentName !== DEFAULT_RUNTIME) {
        const replacement = await activateNewRuntime(base, stage, next);
        await retireInactiveRuntimes(base, path.basename(replacement));
        return replacement;
      }
      if (current) {
        try {
          await renameWithRetry(runtime, backup);
        } catch (error) {
          if (!LOCK_ERRORS.has(error.code)) throw error;
          return await activateNewRuntime(base, stage, next);
        }
      }
      try {
        await renameWithRetry(next, runtime);
      } catch (error) {
        if (current) {
          try {
            await renameWithRetry(backup, runtime);
          } catch (restoreError) {
            throw new Error(`Ember could not restore the previous runtime. Its files are still in ${backup}.`, { cause: restoreError });
          }
        }
        throw error;
      }
      if (current) await rm(backup, { recursive: true, force: true }).catch(() => {});
      return runtime;
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function openProfilePath(id) {
    const base = profileDirectory(root, id, gameId);
    const runtime = path.join(base, await selectedRuntime(base));
    if (!(await fileInfo(runtime))?.isDirectory()) throw new Error('Prepare this profile first.');
    return runtime;
  }

  return { prepareProfile, openProfilePath };
}

module.exports = { createProfileBuilder };
