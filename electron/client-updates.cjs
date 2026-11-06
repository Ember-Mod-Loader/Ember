// electron-updater owns GitHub feed retrieval and SHA-512 verification.
// Authenticode verification also applies when a signed publisher is configured.
// Feed configuration is bundled by electron-builder; renderer callers cannot choose a feed.
const VERSION = /^\d{1,10}\.\d{1,10}\.\d{1,10}(?:-[0-9a-z.-]{1,80})?(?:\+[0-9a-z.-]{1,80})?$/i;

function updateError(error) {
  const message = String(error?.message ?? error ?? '');
  const code = String(error?.code ?? '');
  if (/404|LATEST_VERSION_NOT_FOUND|NO_PUBLISHED_VERSIONS/i.test(message + code)) {
    return 'No published client update is available yet. Try again after a release is published.';
  }
  if (/sha512|checksum|signature|verification|digest/i.test(message + code)) {
    return 'The client update did not pass verification. Please try downloading it again.';
  }
  if (/ENOTFOUND|ECONN|ETIMEDOUT|network|internet|offline/i.test(message + code)) {
    return 'Could not reach the update service. Check your connection and try again.';
  }
  return 'Could not check or download the client update. Please try again later.';
}

function safeVersion(info) {
  return typeof info?.version === 'string' && VERSION.test(info.version) ? info.version : null;
}

function bytes(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0;
}

function createClientUpdates({
  updater, version, enabled = true, portable = false, publish = () => {},
  canInstall = () => true, beforeInstall = () => {},
} = {}) {
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('A valid installed client version is required.');
  const supported = enabled && !portable;
  if (supported && (!updater?.on || !updater?.removeListener || !updater?.checkForUpdates || !updater?.quitAndInstall)) {
    throw new Error('The installed client updater is unavailable.');
  }
  let disposed = false;
  let checking;
  let installing;
  let downloadReady = false;
  let automaticInstallRequested = false;
  const listeners = [];
  let state = {
    version, status: supported ? 'idle' : 'unsupported', latestVersion: null, progress: null, installBlocked: false,
    message: portable
      ? 'Portable builds use manual updates. Download the latest portable version from GitHub Releases.'
      : !enabled ? 'Automatic updates are available in the installed Windows version of Ember.'
      : 'Ember checks for client updates automatically when it starts.',
  };

  const getStatus = () => structuredClone(state);
  function change(next) {
    if (disposed) return getStatus();
    state = { ...state, ...next };
    try { publish(getStatus()); } catch {}
    return getStatus();
  }
  function fail(error) {
    automaticInstallRequested = false;
    downloadReady = false;
    return change({ status: 'error', message: updateError(error), installBlocked: false, progress: null });
  }
  function listen(event, callback) {
    const guarded = (...args) => { if (!disposed) callback(...args); };
    updater.on(event, guarded);
    listeners.push([event, guarded]);
  }

  if (supported) {
    updater.autoDownload = true;
    // Installing on normal quit could interrupt downloads/game work. Only our guarded path installs.
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    listen('checking-for-update', () => change({ status: 'checking', message: 'Checking for a newer Ember version…', progress: null, installBlocked: false }));
    listen('update-available', info => {
      const latestVersion = safeVersion(info);
      if (!latestVersion) { fail(new Error('Invalid update version')); return; }
      change({ status: 'available', latestVersion, message: `Ember ${latestVersion} is available. Preparing the download…`, installBlocked: false });
    });
    listen('update-not-available', () => {
      automaticInstallRequested = false;
      change({ status: 'up-to-date', latestVersion: null, progress: null, installBlocked: false, message: 'You are using the latest Ember version.' });
    });
    listen('download-progress', progress => {
      const percent = Number.isFinite(progress?.percent) ? Math.min(100, Math.max(0, progress.percent)) : 0;
      change({ status: 'downloading', message: 'Downloading the Ember update…', installBlocked: false, progress: {
        percent, transferred: bytes(progress?.transferred), total: bytes(progress?.total), bytesPerSecond: bytes(progress?.bytesPerSecond),
      } });
    });
    listen('update-downloaded', info => {
      const latestVersion = safeVersion(info);
      if (!latestVersion) { fail(new Error('Invalid update version')); return; }
      downloadReady = true;
      change({ status: 'downloaded', latestVersion, progress: null, installBlocked: false,
        message: `Ember ${latestVersion} is ready to install. Restart Ember to finish updating.` });
      if (automaticInstallRequested) void installUpdate({ automatic: true });
    });
    listen('update-cancelled', () => {
      automaticInstallRequested = false;
      downloadReady = false;
      change({ status: 'idle', progress: null, message: 'The client update download was cancelled. You can check again.' });
    });
    listen('error', fail);
  }

  function checkForUpdates({ automatic = false } = {}) {
    if (disposed || !supported || state.status === 'installing' || downloadReady) return Promise.resolve(getStatus());
    if (automatic) automaticInstallRequested = true;
    if (checking) return checking;
    if (state.status === 'available' || state.status === 'downloading') return Promise.resolve(getStatus());
    change({ status: 'checking', latestVersion: null, progress: null, installBlocked: false, message: 'Checking for a newer Ember version…' });
    const work = Promise.resolve().then(() => updater.checkForUpdates()).then(result => {
      // checkForUpdates resolves before its auto-download. Observe that promise as well as error events.
      if (result?.downloadPromise?.catch) result.downloadPromise.catch(error => { if (!disposed) fail(error); });
      if (!disposed && state.status === 'checking') fail(new Error('No update result'));
      return getStatus();
    }).catch(error => disposed ? getStatus() : fail(error));
    checking = work;
    void work.finally(() => { if (checking === work) checking = undefined; });
    return work;
  }

  function installUpdate({ automatic = false } = {}) {
    if (disposed || !supported || state.status === 'installing') return Promise.resolve(getStatus());
    if (installing) return installing;
    if (!downloadReady) return Promise.resolve(getStatus());
    const work = Promise.resolve().then(async () => {
      let safe = false;
      try { safe = await canInstall(); } catch {}
      if (disposed) return getStatus();
      if (safe !== true) {
        return change({ status: 'downloaded', installBlocked: true,
          message: 'The update is ready. Finish active downloads or profile work and close the game, then choose Install and restart.' });
      }
      await beforeInstall();
      if (disposed) return getStatus();
      change({ status: 'installing', installBlocked: false, message: 'Restarting Ember to install the update…' });
      updater.quitAndInstall(automatic, true);
      return getStatus();
    }).catch(() => {
      if (disposed) return getStatus();
      if (state.status === 'installing') automaticInstallRequested = false;
      return change({ status: 'downloaded', installBlocked: true,
        message: 'The update is ready, but Ember could not restart to install it. Finish active work and try Install and restart again.' });
    });
    installing = work;
    void work.finally(() => { if (installing === work) installing = undefined; });
    return work;
  }

  function retryAutomaticInstall() {
    if (disposed || !automaticInstallRequested || !downloadReady) return Promise.resolve(getStatus());
    return installUpdate({ automatic: true });
  }

  function dispose() {
    disposed = true;
    for (const [event, listener] of listeners) updater.removeListener(event, listener);
    listeners.length = 0;
  }

  return { getStatus, checkForUpdates, installUpdate, retryAutomaticInstall, dispose };
}

module.exports = { createClientUpdates };
