const { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, session, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const { mkdirSync, existsSync } = require('node:fs');
const { readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fetchCatalog, fetchPackage, fetchPackageVersion } = require('./thunderstore.cjs');
const { createPackageCache } = require('./packages.cjs');
const { createProfileBuilder } = require('./profiles.cjs');
const { createDownloadHistory } = require('./download-history.cjs');
const { createSharingClient } = require('./sharing.cjs');
const { createClientUpdates } = require('./client-updates.cjs');
const { findLethalCompany, getLaunchStatus, prepareDoorstop, removeManagedDoorstop, launchLethalCompany, assertLethalCompanyClosed, assertSupportedGamesClosed } = require('./steam.cjs');

const appScheme = 'modrelay';
const appHost = 'app';
const appUrl = `${appScheme}://${appHost}/`;
const dist = path.join(__dirname, '..', 'dist');
let window;
let installingClient = false;
let rendererBusy = true;
let gameWorkBusy = () => false;
const RELEASES_URL = 'https://github.com/Ember-Mod-Loader/Ember/releases/latest';

if (!app.commandLine.hasSwitch('user-data-dir')) {
  const previousData = path.join(app.getPath('appData'), 'ModRelay');
  mkdirSync(previousData, { recursive: true });
  app.setPath('userData', previousData);
}

protocol.registerSchemesAsPrivileged([
  { scheme: appScheme, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function isAppUrl(value) {
  const url = URL.parse(value);
  return url?.protocol === `${appScheme}:` && url.host === appHost;
}

async function serveApp(request) {
  if (!isAppUrl(request.url) || request.method !== 'GET') {
    return new Response(null, { status: 403 });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return new Response(null, { status: 400 });
  }

  const filePath = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
  const relative = path.relative(dist, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return new Response(null, { status: 403 });
  }

  try {
    const file = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(file.headers);
    headers.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob: https://ccdn.thunderstore.io https://cdn.thunderstore.io https://gcdn.thunderstore.io",
      "font-src 'self' data:",
      "connect-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '));
    return new Response(file.body, { status: file.status, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

async function saveProfile(payload) {
  const { json, filename } = payload ?? {};
  if (typeof json !== 'string' || !json.length || Buffer.byteLength(json, 'utf8') > 3 * 1024 * 1024 ||
      typeof filename !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,119}\.(?:ember|modrelay)\.json$/i.test(filename)) {
    throw new Error('Choose a valid Ember profile up to 3 MB.');
  }

  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: 'Export Ember profile',
    defaultPath: filename,
    filters: [{ name: 'Ember profile', extensions: ['json'] }],
  });
  if (canceled || !filePath) return false;

  const temporaryPath = path.join(path.dirname(filePath), `.modrelay-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, json, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

function handle(channel, action) {
  ipcMain.handle(`modrelay:${channel}`, (event, ...args) => {
    if (!window || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) {
      throw new Error('This action is only available in the Ember window.');
    }
    if (installingClient && !['client-update-status', 'window-state', 'window-command'].includes(channel)) {
      throw new Error('Ember is restarting to install a client update.');
    }
    return action(...args);
  });
}

async function downloadPackages(cache, gameId, roots, history, operationId) {
  if (!Array.isArray(roots) || roots.length > 200) throw new Error('Choose up to 200 Thunderstore packages.');
  const packages = new Map();

  async function resolve(ref) {
    if (typeof ref?.namespace !== 'string' || typeof ref.name !== 'string') throw new Error('Invalid Thunderstore package.');
    const key = `${ref.namespace}/${ref.name}@${ref.version}`;
    if (packages.has(key)) return;
    if (packages.size >= 200) throw new Error('This download includes more than 200 package versions.');
    const mod = ref.version
      ? await fetchPackageVersion(gameId, ref.namespace, ref.name, ref.version)
      : await fetchPackage(gameId, ref.namespace, ref.name);
    const resolvedKey = `${mod.namespace}/${mod.name}@${mod.version}`;
    if (packages.has(resolvedKey)) return;
    packages.set(resolvedKey, mod);
    for (const dependency of mod.dependencies) await resolve(dependency);
  }

  for (const ref of roots) await resolve(ref);
  if (gameId === 'lethal-company' && roots.some(ref => !ref.version) &&
      [...packages.values()].some(mod => mod.namespace === 'BepInEx' && mod.name === 'BepInExPack')) {
    await resolve({ namespace: 'BepInEx', name: 'BepInExPack' });
  }
  const resolved = [...packages.values()].reverse();
  history.plan(operationId, resolved);
  for (let index = 0; index < resolved.length; index += 3) {
    await Promise.all(resolved.slice(index, index + 3).map(mod => cache.downloadPackage({
      gameId, namespace: mod.namespace, name: mod.name, version: mod.version,
    }, progress => history.progress(operationId, `${mod.id}@${mod.version}`, progress))));
  }
  return resolved;
}

function createWindow() {
  window = new BrowserWindow({
    title: 'Ember',
    width: 1472,
    height: 980,
    minWidth: 760,
    minHeight: 590,
    backgroundColor: '#0d0d10',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0d10', symbolColor: '#e9dfd5', height: 32 },
    roundedCorners: true,
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.removeMenu();
  const sendWindowState = () => window?.webContents.send('modrelay:window-state', { maximized: window.isMaximized() });
  window.on('maximize', sendWindowState);
  window.on('unmaximize', sendWindowState);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  if (app.isPackaged) window.webContents.on('devtools-opened', () => window.webContents.closeDevTools());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  window.loadURL(appUrl).catch(error => {
    console.error('Unable to load Ember', error);
    app.exit(1);
  });
}

function registerGameActions(cache, history) {
  const directory = app.getPath('userData');
  const settingsPath = path.join(directory, 'lethal-company.json');
  let preparing = null;
  const profileCache = {
    root: cache.root,
    async downloadPackage(input) {
      const operation = preparing;
      if (!operation.id) {
        operation.id = randomUUID();
        await history.start({
          id: operation.id, gameId: 'lethal-company', profileId: operation.profileId,
          profileName: operation.profileName, label: `Prepare ${operation.profileName}`,
        });
        history.plan(operation.id, operation.refs.map(ref => ({
          ...ref, id: `lethal-company/${ref.namespace}/${ref.name}`,
        })));
      }
      const key = `lethal-company/${input.namespace}/${input.name}@${input.version}`;
      return cache.downloadPackage(input, progress => history.progress(operation.id, key, progress));
    },
  };
  const profiles = createProfileBuilder(path.join(directory, 'profiles'), profileCache);
  let busy = false;

  async function prepareProfile(profileId, refs, profileName = 'Profile') {
    preparing = { id: null, profileId, refs, profileName };
    try {
      const result = await profiles.prepareProfile(profileId, refs);
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

  async function savedGame() {
    try {
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      return settings ?? {};
    } catch {
      return {};
    }
  }

  async function status() {
    const saved = await savedGame();
    const game = typeof saved.gameDir === 'string'
      ? await getLaunchStatus(saved.gameDir).catch(() => findLethalCompany())
      : await findLethalCompany();
    return game && { ...game, loaderApproved: Boolean(game.loaderFingerprint && game.loaderFingerprint === saved.approvedLoader) };
  }

  async function saveGame(settings) {
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
  handle('choose-game', async () => {
    const found = await status();
    const selected = await dialog.showOpenDialog(window, {
      title: 'Choose the Lethal Company game folder',
      defaultPath: found?.gameDir,
      properties: ['openDirectory'],
    });
    if (selected.canceled) return found;
    const game = await getLaunchStatus(selected.filePaths[0]);
    await saveGame({ gameDir: game.gameDir, approvedLoader: game.loaderFingerprint === found?.loaderFingerprint && found?.loaderApproved ? game.loaderFingerprint : undefined });
    return game;
  });
  handle('prepare-profile', (profileId, refs, profileName) => action(async () => {
    await assertLethalCompanyClosed();
    await prepareProfile(profileId, refs, profileName);
    return true;
  }));
  handle('open-profile', async profileId => {
    const error = await shell.openPath(await profiles.openProfilePath(profileId));
    if (error) throw new Error('Could not open the profile folder.');
  });
  handle('setup-loader', (profileId, refs, profileName) => action(async () => {
    const game = await status();
    if (!game) throw new Error('Choose the Lethal Company game folder in Settings.');
    if (game.loader !== 'clean') throw new Error('This game folder already has a loader. Review its status in Settings.');
    await assertLethalCompanyClosed();
    const loaderPath = await prepareProfile(profileId, refs, profileName);
    return prepareDoorstop({ gameDir: game.gameDir, loaderPath });
  }));
  handle('remove-loader', () => action(async () => {
    const game = await status();
    if (game?.loader !== 'managed') throw new Error('Choose a Steam game folder with an Ember loader.');
    return removeManagedDoorstop(game.gameDir);
  }));
  handle('launch-game', (mode, profileId, refs, approvedFingerprint, profileName) => action(async () => {
    const game = await status();
    if (!game) throw new Error('Choose the Lethal Company game folder in Settings.');
    if (mode !== 'modded' && mode !== 'vanilla') throw new Error('Choose a launch mode.');
    const remember = mode === 'modded' && game.loader === 'existing' && approvedFingerprint === game.loaderFingerprint;
    if (mode === 'modded' && game.loader === 'existing' && !game.loaderApproved && !remember) {
      throw new Error('Confirm reuse of the current Unity Doorstop loader first.');
    }
    if (remember) await saveGame({ gameDir: game.gameDir, approvedLoader: game.loaderFingerprint });
    await assertLethalCompanyClosed();
    const profilePath = mode === 'modded' ? await prepareProfile(profileId, refs, profileName) : undefined;
    await launchLethalCompany({ gameDir: game.gameDir, mode, profilePath, allowExistingDoorstop: game.loaderApproved || remember, loaderFingerprint: game.loaderFingerprint });
    return true;
  }));
  gameWorkBusy = () => busy || preparing !== null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.modrelay.desktop');
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    if (!nativeTheme.shouldUseHighContrastColors) nativeTheme.themeSource = 'dark';
    protocol.handle(appScheme, serveApp);
    const cache = createPackageCache(path.join(app.getPath('userData'), 'package-cache'));
    const history = await createDownloadHistory(path.join(app.getPath('userData'), 'downloads.json'), record => {
      if (window && !window.webContents.isDestroyed()) window.webContents.send('modrelay:download-progress', record);
    });
    registerGameActions(cache, history);
    handle('window-state', () => ({ maximized: window.isMaximized() }));
    const portable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);
    const installed = app.isPackaged && process.platform === 'win32' && !portable &&
      existsSync(path.join(path.dirname(app.getPath('exe')), 'Uninstall Ember.exe'));
    const hasActiveWork = () => installingClient || rendererBusy || gameWorkBusy() ||
      history.list().some(record => ['resolving', 'downloading', 'saving'].includes(record.status));
    const clientUpdates = createClientUpdates({
      updater: installed ? require('electron-updater').autoUpdater : undefined,
      version: app.getVersion(), enabled: installed, portable,
      publish: status => {
        if (status.status === 'error' || (status.status === 'downloaded' && status.installBlocked)) installingClient = false;
        if (window && !window.webContents.isDestroyed()) window.webContents.send('modrelay:client-update-state', status);
      },
      canInstall: async () => {
        if (hasActiveWork()) return false;
        await assertSupportedGamesClosed();
        return !hasActiveWork();
      },
      beforeInstall: () => {
        if (hasActiveWork()) throw new Error('Finish active work before installing the update.');
        installingClient = true;
      },
    });
    handle('client-update', () => clientUpdates.checkForUpdates());
    handle('client-update-status', () => clientUpdates.getStatus());
    handle('install-client-update', () => clientUpdates.installUpdate());
    handle('client-ui-busy', busy => {
      if (typeof busy !== 'boolean') throw new Error('Invalid client activity state.');
      rendererBusy = busy;
    });
    handle('client-release-page', () => shell.openExternal(RELEASES_URL));
    const updateRetry = setInterval(() => { void clientUpdates.retryAutomaticInstall(); }, 15_000);
    updateRetry.unref();
    app.once('will-quit', () => { clearInterval(updateRetry); clientUpdates.dispose(); });
    handle('window-command', command => {
      if (command === 'minimize') window.minimize();
      else if (command === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
      else if (command === 'close') window.close();
      else throw new Error('Unknown window command.');
    });
    handle('save-profile', saveProfile);
    const sharing = createSharingClient();
    handle('share-profile', json => sharing.publishProfile(json));
    handle('resolve-profile-code', code => sharing.resolveProfile(code));
    handle('catalog', fetchCatalog);
    handle('package-details', fetchPackage);
    handle('download-history', () => history.list());
    handle('clear-completed-downloads', gameId => history.clearCompleted(gameId));
    handle('finish-download', (id, error, profile) => error ? history.fail(id, error) : history.complete(id, profile));
    handle('download-packages', async (gameId, refs, context) => {
      const info = context ?? { id: randomUUID(), profileId: `${gameId}-default`, profileName: 'Default', label: 'Mod download' };
      await history.start({ ...info, gameId });
      try {
        const result = await downloadPackages(cache, gameId, refs, history, info.id);
        await history.ready(info.id);
        if (!context) await history.complete(info.id);
        return result;
      } catch (error) {
        await history.fail(info.id, error).catch(() => {});
        throw error;
      }
    });
    handle('downloads-folder', async () => {
      const error = await shell.openPath(await cache.openFolderPath());
      if (error) throw new Error('Ember could not open the downloads folder.');
    });
    handle('open-package-page', async value => {
      const url = URL.parse(value);
      if (url?.origin !== 'https://thunderstore.io' || url.username || url.password ||
          !/^\/c\/[a-z0-9-]+\/p\/[a-z0-9_-]+\/[a-z0-9_]+\/?$/i.test(url.pathname)) {
        throw new Error('Choose a Thunderstore package page.');
      }
      await shell.openExternal(url.href);
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => (
      permission === 'clipboard-sanitized-write' && isAppUrl(origin)
    ));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write' && isAppUrl(contents.getURL()));
    });
    createWindow();
    // Update availability never blocks workspace startup or offline mod management.
    window.webContents.once('did-finish-load', () => {
      if (installed) void clientUpdates.checkForUpdates({ automatic: true });
    });
  }).catch(error => {
    dialog.showErrorBox('Ember could not start', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
