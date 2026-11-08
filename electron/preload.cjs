const { contextBridge, ipcRenderer } = require('electron');
document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('native-caption'));

contextBridge.exposeInMainWorld('modRelayDesktop', {
  windowCommand: command => ipcRenderer.invoke('modrelay:window-command', command),
  windowState: () => ipcRenderer.invoke('modrelay:window-state'),
  presenceStatus: () => ipcRenderer.invoke('modrelay:presence-status'),
  onPresence: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('modrelay:presence-state', listener);
    return () => ipcRenderer.removeListener('modrelay:presence-state', listener);
  },
  checkClientUpdate: () => ipcRenderer.invoke('modrelay:client-update'),
  startupClientUpdate: () => ipcRenderer.invoke('modrelay:startup-client-update'),
  finishClientStartup: () => ipcRenderer.invoke('modrelay:finish-client-startup'),
  clientUpdateStatus: () => ipcRenderer.invoke('modrelay:client-update-status'),
  installClientUpdate: () => ipcRenderer.invoke('modrelay:install-client-update'),
  openClientReleasePage: () => ipcRenderer.invoke('modrelay:client-release-page'),
  setClientUiBusy: busy => ipcRenderer.invoke('modrelay:client-ui-busy', busy),
  onClientUpdate: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('modrelay:client-update-state', listener);
    return () => ipcRenderer.removeListener('modrelay:client-update-state', listener);
  },
  onWindowState: callback => {
    const listener = (_event, state) => callback({ maximized: state.maximized === true });
    ipcRenderer.on('modrelay:window-state', listener);
    return () => ipcRenderer.removeListener('modrelay:window-state', listener);
  },
  saveProfile: ({ json, filename }) => ipcRenderer.invoke('modrelay:save-profile', { json, filename }),
  shareProfile: json => ipcRenderer.invoke('modrelay:share-profile', json),
  resolveProfileCode: code => ipcRenderer.invoke('modrelay:resolve-profile-code', code),
  resolveThunderstoreProfile: (code, gameId) => ipcRenderer.invoke('modrelay:resolve-thunderstore-profile', code, gameId),
  fetchCatalog: options => ipcRenderer.invoke('modrelay:catalog', options),
  fetchPackage: (gameId, namespace, name) => ipcRenderer.invoke('modrelay:package-details', gameId, namespace, name),
  downloadPackages: (gameId, refs, context) => ipcRenderer.invoke('modrelay:download-packages', gameId, refs, context),
  downloadHistory: () => ipcRenderer.invoke('modrelay:download-history'),
  clearCompletedDownloads: gameId => ipcRenderer.invoke('modrelay:clear-completed-downloads', gameId),
  finishDownload: (id, error, profile) => ipcRenderer.invoke('modrelay:finish-download', id, error, profile),
  onDownloadProgress: callback => {
    const listener = (_event, record) => callback(record);
    ipcRenderer.on('modrelay:download-progress', listener);
    return () => ipcRenderer.removeListener('modrelay:download-progress', listener);
  },
  openDownloads: () => ipcRenderer.invoke('modrelay:downloads-folder'),
  openPackagePage: url => ipcRenderer.invoke('modrelay:open-package-page', url),
  gameStatus: gameId => ipcRenderer.invoke('modrelay:game-status', gameId),
  gameRunningStatus: gameId => ipcRenderer.invoke('modrelay:game-running-status', gameId),
  chooseGame: gameId => ipcRenderer.invoke('modrelay:choose-game', gameId),
  prepareProfile: (profileId, refs, name, gameId, configFiles, userDataFiles) => ipcRenderer.invoke('modrelay:prepare-profile', profileId, refs, name, gameId, configFiles, userDataFiles),
  openProfile: (profileId, gameId) => ipcRenderer.invoke('modrelay:open-profile', profileId, gameId),
  setupLoader: (profileId, refs, name, gameId, configFiles, userDataFiles) => ipcRenderer.invoke('modrelay:setup-loader', profileId, refs, name, gameId, configFiles, userDataFiles),
  removeLoader: gameId => ipcRenderer.invoke('modrelay:remove-loader', gameId),
  launchGame: (mode, profileId, refs, reuse, name, gameId, configFiles, userDataFiles) => ipcRenderer.invoke('modrelay:launch-game', mode, profileId, refs, reuse, name, gameId, configFiles, userDataFiles),
});
