const { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, session, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const { mkdirSync, existsSync } = require('node:fs');
const { rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fetchCatalog, fetchPackage, fetchPackageVersion } = require('./thunderstore.cjs');
const { createPackageCache } = require('./packages.cjs');
const { registerGameActions } = require('./game-actions.cjs');
const { createDownloadHistory } = require('./download-history.cjs');
const { createSharingClient } = require('./sharing.cjs');
const { createClientUpdates } = require('./client-updates.cjs');
const { createUpdateAttempts } = require('./update-attempts.cjs');
const { createStartupUpdates } = require('./startup-updates.cjs');
const { createPresence } = require('./presence.cjs');
const { acquirePresenceLease } = require('./presence-lease.cjs');
const { createQuitCoordinator } = require('./quit-coordinator.cjs');
const { createDiagnostics, errorDetails } = require('./diagnostics.cjs');
const { emberPresence } = require('../package.json');
const { assertSupportedGamesClosed } = require('./steam.cjs');

const appScheme = 'modrelay';
const appHost = 'app';
const appUrl = `${appScheme}://${appHost}/`;
const dist = path.join(__dirname, '..', 'dist');
let window;
let installingClient = false;
let updateHandoffReady = false;
let quittingClient = false;
let quitCoordinator;
let diagnostics;
let startupUpdates;
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
    const startupControls = ['startup-client-update', 'finish-client-startup', 'client-update-status', 'presence-status', 'window-state', 'window-command', 'client-ui-busy'];
    if (installingClient && !startupControls.includes(channel)) {
      throw new Error('Ember is restarting to install a client update.');
    }
    if (quittingClient && !['client-update-status', 'presence-status', 'window-state', 'window-command'].includes(channel)) {
      throw new Error('Ember is closing. Open it again to continue.');
    }
    if (startupUpdates?.isActive() && !startupControls.includes(channel)) {
      throw new Error('Ember is checking for updates. Wait for startup to finish.');
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
  const loaderName = gameId === 'peak' ? 'BepInExPack_PEAK' : 'BepInExPack';
  if (['lethal-company', 'repo', 'peak'].includes(gameId) && roots.some(ref => !ref.version) &&
      [...packages.values()].some(mod => mod.namespace === 'BepInEx' && mod.name === loaderName)) {
    await resolve({ namespace: 'BepInEx', name: loaderName });
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
  window.on('close', event => quitCoordinator?.requestWindowClose(event));
  window.on('closed', () => {
    diagnostics?.log('window-closed', { updating: installingClient, coordinated: quitCoordinator?.canClose() === true });
    window = null;
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics?.log('renderer-exited', { reason: details.reason, exitCode: details.exitCode });
  });
  window.loadURL(appUrl).catch(error => {
    console.error('Unable to load Ember', error);
    app.exit(1);
  });
}


if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.modrelay.desktop');
  app.on('second-instance', () => {
    if (quitCoordinator?.requestRelaunch()) return;
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    diagnostics = createDiagnostics(app.getPath('userData'), app.getVersion());
    diagnostics.log('started', { pid: process.pid, afterUpdate: app.commandLine.hasSwitch('updated') });
    process.on('uncaughtExceptionMonitor', error => diagnostics.log('uncaught-exception', { error: errorDetails(error) }));
    app.on('child-process-gone', (_event, details) => diagnostics.log('child-exited', { type: details.type, reason: details.reason, exitCode: details.exitCode }));
    app.on('quit', (_event, exitCode) => diagnostics.log('quit', { exitCode, updating: installingClient }));
    if (!nativeTheme.shouldUseHighContrastColors) nativeTheme.themeSource = 'dark';
    protocol.handle(appScheme, serveApp);
    const cache = createPackageCache(path.join(app.getPath('userData'), 'package-cache'));
    const history = await createDownloadHistory(path.join(app.getPath('userData'), 'downloads.json'), record => {
      if (window && !window.webContents.isDestroyed()) window.webContents.send('modrelay:download-progress', record);
    });
    const gameActions = registerGameActions({
      directory: app.getPath('userData'), cache, history, handle, dialog, shell, getWindow: () => window,
    });
    gameWorkBusy = gameActions.isBusy;
    let presenceLease = null;
    try {
      presenceLease = await acquirePresenceLease(path.join(app.getPath('userData'), 'presence-session.json'));
    } catch {
      diagnostics.log('presence-storage-unavailable');
      console.error('The temporary online session is unavailable; Ember will continue without the online count.');
    }
    const presence = createPresence({
      endpoint: presenceLease ? emberPresence?.endpoint ?? null : null,
      lease: presenceLease,
      publish: status => {
        if (window && !window.webContents.isDestroyed()) window.webContents.send('modrelay:presence-state', status);
      },
    });
    handle('presence-status', () => presence.getStatus());
    quitCoordinator = createQuitCoordinator({
      app, dispose: () => presence.dispose(),
      onPending: () => { quittingClient = true; diagnostics.log('quit-requested', { updating: installingClient }); },
      isUpdating: () => installingClient,
      shouldDeferQuit: () => installingClient && !updateHandoffReady,
      onError: error => { diagnostics.log('presence-cleanup-incomplete', { error: errorDetails(error) }); },
    });
    handle('window-state', () => ({ maximized: window.isMaximized() }));
    const portable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);
    const installed = app.isPackaged && process.platform === 'win32' && !portable &&
      existsSync(path.join(path.dirname(app.getPath('exe')), 'Uninstall Ember.exe'));
    const hasActiveWork = () => installingClient || quittingClient || (rendererBusy && !startupUpdates?.isActive()) || gameWorkBusy() ||
      history.list().some(record => ['resolving', 'downloading', 'saving'].includes(record.status));
    const updateAttempts = createUpdateAttempts(path.join(app.getPath('userData'), 'client-update-attempt.json'), { version: app.getVersion() });
    const clientUpdates = createClientUpdates({
      updater: installed ? require('electron-updater').autoUpdater : undefined,
      version: app.getVersion(), enabled: installed, portable,
      publish: status => {
        if (status.status !== 'installing') {
          installingClient = false;
          updateHandoffReady = false;
        }
        if (window && !window.webContents.isDestroyed()) window.webContents.send('modrelay:client-update-state', status);
      },
      canInstall: async () => {
        if (hasActiveWork()) return false;
        await assertSupportedGamesClosed();
        return !hasActiveWork();
      },
      reserveAutomaticInstall: updateAttempts.reserveAutomaticInstall,
      releaseAutomaticInstall: updateAttempts.releaseAutomaticInstall,
      beforeInstall: async ({ automatic, fromVersion, toVersion }) => {
        if (hasActiveWork()) throw new Error('Finish active work before installing the update.');
        installingClient = true;
        diagnostics.log('update-restart-requested', { automatic, fromVersion, toVersion });
        if (window && !window.webContents.isDestroyed()) {
          window.webContents.send('modrelay:client-update-state', {
            ...clientUpdates.getStatus(), status: 'installing',
            message: `Installing Ember ${toVersion}. Ember will restart automatically.`,
          });
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (!installingClient || quittingClient) throw new Error('The update restart was cancelled.');
        updateHandoffReady = true;
      },
    });
    startupUpdates = createStartupUpdates({
      getStatus: () => clientUpdates.getStatus(),
      checkForUpdates: options => clientUpdates.checkForUpdates(options),
      isInstalling: () => installingClient,
    });
    handle('startup-client-update', () => startupUpdates.start());
    handle('finish-client-startup', () => startupUpdates.finish());
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
      else if (command === 'close') app.quit();
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
    window.webContents.once('did-finish-load', () => {
      presence.start();
    });
  }).catch(error => {
    diagnostics?.log('startup-failed', { error: errorDetails(error) });
    dialog.showErrorBox('Ember could not start', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
