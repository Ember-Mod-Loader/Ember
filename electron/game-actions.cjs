const { randomUUID } = require('node:crypto');
const { readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { createSteamAdapter } = require('./steam.cjs');
const { createProfileBuilder } = require('./profiles.cjs');
const { normalizeConfigFiles } = require('./config-files.cjs');

function registerGameActions({ directory, cache, history, handle, dialog, shell, getWindow, createLauncher = createSteamAdapter, createProfiles = createProfileBuilder, now = Date.now, launchPendingMs = 30_000 }) {
  const games = new Map([
    ['lethal-company', 'Lethal Company'], ['repo', 'R.E.P.O.'], ['peak', 'PEAK'], ['mimesis', 'MIMESIS'],
  ].map(([id, name]) => [id, {
    id, name, settingsPath: path.join(directory, `${id}.json`), launchPendingUntil: 0,
    launcher: createLauncher({ gameId: id }),
  }]));
  const getGame = (id = 'lethal-company') => {
    const game = games.get(id);
    if (!game) throw new Error('Choose a supported game.');
    return game;
  };
  let preparing = null;
  const profileCache = {
    root: cache.root,
    async downloadPackage(input) {
      const operation = preparing;
      if (!operation || input.gameId !== operation.gameId) throw new Error('The profile preparation game changed.');
      if (!operation.id) {
        operation.id = randomUUID();
        await history.start({
          id: operation.id, gameId: operation.gameId, profileId: operation.profileId,
          profileName: operation.profileName, label: `Prepare ${operation.profileName}`,
        });
        history.plan(operation.id, operation.refs.map(ref => ({
          ...ref, id: `${operation.gameId}/${ref.namespace}/${ref.name}`,
        })));
      }
      const key = `${operation.gameId}/${input.namespace}/${input.name}@${input.version}`;
      return cache.downloadPackage(input, progress => history.progress(operation.id, key, progress));
    },
  };
  for (const game of games.values()) {
    game.profiles = createProfiles(path.join(directory, 'profiles'), profileCache, { gameId: game.id });
  }
  let busy = false;

  async function prepareProfile(game, profileId, refs, profileName = 'Profile', configFiles = {}, userDataFiles = {}) {
    const plannedRefs = game.id === 'peak' && Array.isArray(refs)
      ? refs.filter(ref => !(ref?.namespace === 'BepInEx' && ref.name === 'BepInExPack')) : refs;
    preparing = { id: null, gameId: game.id, profileId, refs: plannedRefs, profileName };
    try {
      const result = await game.profiles.prepareProfile(profileId, refs, configFiles, userDataFiles);
      if (preparing.id) {
        await history.ready(preparing.id);
        await history.complete(preparing.id);
      }
      return result;
    } catch (error) {
      if (preparing.id) await history.fail(preparing.id, error).catch(() => {});
      throw error;
    } finally {
      preparing = null;
    }
  }

  async function savedGame(game) {
    try {
      const settings = JSON.parse(await readFile(game.settingsPath, 'utf8'));
      return settings ?? {};
    } catch {
      return {};
    }
  }

  async function status(gameId) {
    const game = getGame(gameId);
    const saved = await savedGame(game);
    const found = typeof saved.gameDir === 'string'
      ? await game.launcher.getLaunchStatus(saved.gameDir).catch(() => game.launcher.findGame())
      : await game.launcher.findGame();
    return found && { ...found, gameId: game.id, ...(await runningStatus(game)),
      loaderApproved: Boolean(found.loaderFingerprint && found.loaderFingerprint === saved.approvedLoader) };
  }

  async function runningStatus(game) {
    const detected = game.launcher.getRunningStatus ? await game.launcher.getRunningStatus()
      : { running: game.launcher.isGameRunning ? await game.launcher.isGameRunning() : false };
    if (typeof detected?.running !== 'boolean') throw new Error(`Ember could not confirm whether ${game.name} is running.`);
    if (detected.running || now() >= game.launchPendingUntil) game.launchPendingUntil = 0;
    return { running: detected.running, launchPending: game.launchPendingUntil > now(),
      processCount: Number.isSafeInteger(detected.processCount) && detected.processCount >= 0 ? detected.processCount : detected.running ? 1 : 0 };
  }

  async function assertAvailable(game, state) {
    const current = state ?? await runningStatus(game);
    if (current.running) throw new Error(`${game.name} is already running. Close the game before changing its profile or starting another session.`);
    if (current.launchPending) throw new Error(`${game.name} is starting. Wait for the game to open before trying again.`);
  }

  async function saveGame(game, settings) {
    const settingsPath = game.settingsPath;
    const temporary = `${settingsPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(settings), { flag: 'wx' });
      await rename(temporary, settingsPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function action(task) {
    if (busy) throw new Error('A profile or launch is already being prepared.');
    busy = true;
    try {
      return await task();
    } finally {
      busy = false;
    }
  }

  handle('game-status', status);
  handle('game-running-status', async gameId => {
    const game = getGame(gameId);
    return { gameId: game.id, ...(await runningStatus(game)) };
  });
  handle('choose-game', gameId => action(async () => {
    const context = getGame(gameId);
    const found = await status(context.id);
    const selected = await dialog.showOpenDialog(getWindow(), {
      title: `Choose the ${context.name} game folder`,
      defaultPath: found?.gameDir,
      properties: ['openDirectory'],
    });
    if (selected.canceled) return found;
    const game = await context.launcher.getLaunchStatus(selected.filePaths[0]);
    await saveGame(context, { gameDir: game.gameDir, approvedLoader: game.loaderFingerprint === found?.loaderFingerprint && found?.loaderApproved ? game.loaderFingerprint : undefined });
    return game;
  }));
  handle('prepare-profile', (profileId, refs, profileName, gameId, configFiles, userDataFiles) => action(async () => {
    const context = getGame(gameId);
    await assertAvailable(context);
    await context.launcher.assertGameClosed();
    await prepareProfile(context, profileId, refs, profileName, configFiles, userDataFiles);
    return true;
  }));
  handle('open-profile', async (profileId, gameId) => {
    const error = await shell.openPath(await getGame(gameId).profiles.openProfilePath(profileId));
    if (error) throw new Error('Could not open the profile folder.');
  });
  handle('setup-loader', (profileId, refs, profileName, gameId, configFiles, userDataFiles) => action(async () => {
    const context = getGame(gameId);
    const game = await status(context.id);
    if (!game) throw new Error(`Choose the ${context.name} game folder in Settings.`);
    await assertAvailable(context, game);
    if (game.loader !== 'clean') throw new Error('This game folder already has a loader. Review its status in Settings.');
    await context.launcher.assertGameClosed();
    const loaderPath = await prepareProfile(context, profileId, refs, profileName, configFiles, userDataFiles);
    return context.launcher.prepareDoorstop({ gameDir: game.gameDir, loaderPath });
  }));
  handle('remove-loader', gameId => action(async () => {
    const context = getGame(gameId);
    const game = await status(context.id);
    if (game?.loader !== 'managed') throw new Error('Choose a Steam game folder with an Ember loader.');
    await assertAvailable(context, game);
    return context.launcher.removeManagedDoorstop(game.gameDir);
  }));
  handle('launch-game', (mode, profileId, refs, approvedFingerprint, profileName, gameId, configFiles, userDataFiles) => action(async () => {
    const importedConfigFiles = mode === 'modded' ? normalizeConfigFiles(configFiles) : {};
    const importedUserDataFiles = mode === 'modded' ? normalizeConfigFiles(userDataFiles) : {};
    const context = getGame(gameId);
    const game = await status(context.id);
    if (!game) throw new Error(`Choose the ${context.name} game folder in Settings.`);
    if (mode !== 'modded' && mode !== 'vanilla') throw new Error('Choose a launch mode.');
    await assertAvailable(context, game);
    const remember = mode === 'modded' && game.loader === 'existing' && approvedFingerprint === game.loaderFingerprint;
    if (mode === 'modded' && game.loader === 'existing' && !game.loaderApproved && !remember) {
      throw new Error('Confirm reuse of the current mod loader first.');
    }
    if (remember) await saveGame(context, { gameDir: game.gameDir, approvedLoader: game.loaderFingerprint });
    await context.launcher.assertGameClosed();
    const profilePath = mode === 'modded' ? await prepareProfile(context, profileId, refs, profileName, importedConfigFiles, importedUserDataFiles) : undefined;
    context.launchPendingUntil = now() + launchPendingMs;
    try {
      await context.launcher.launchGame({ gameDir: game.gameDir, mode, profilePath, allowExistingDoorstop: game.loaderApproved || remember, loaderFingerprint: game.loaderFingerprint });
    } catch (error) {
      context.launchPendingUntil = 0;
      throw error;
    }
    return true;
  }));
  return { isBusy: () => busy || preparing !== null || [...games.values()].some(game => game.launchPendingUntil > now()) };
}

module.exports = { registerGameActions };
