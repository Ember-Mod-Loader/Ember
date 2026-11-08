// electron-updater owns GitHub feed retrieval and SHA-512 verification.
// Authenticode verification also applies when a signed publisher is configured.
// Feed configuration is bundled by electron-builder; renderer callers cannot choose a feed.
const VERSION = /^(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})(?:-([0-9a-z-]+(?:\.[0-9a-z-]+)*))?(?:\+([0-9a-z-]+(?:\.[0-9a-z-]+)*))?$/i;

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const match = VERSION.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { core: match.slice(1, 4).map(Number), prerelease };
}

function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index++) {
    if (next.core[index] !== installed.core[index]) return next.core[index] > installed.core[index];
  }
  if (!next.prerelease.length || !installed.prerelease.length) {
    return !next.prerelease.length && installed.prerelease.length > 0;
  }
  for (let index = 0; index < Math.max(next.prerelease.length, installed.prerelease.length); index++) {
    const left = next.prerelease[index];
    const right = installed.prerelease[index];
    if (left === right) continue;
    if (left === undefined || right === undefined) return right === undefined;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    if (leftNumeric && left.length !== right.length) return left.length > right.length;
    return left > right;
  }
  return false; // Build metadata does not affect SemVer precedence.
}

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
  return parseVersion(info?.version) ? info.version : null;
}

function bytes(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0;
}

function createClientUpdates({
  updater, version, enabled = true, portable = false, publish = () => {},
  canInstall = () => true, beforeInstall = () => {},
  reserveAutomaticInstall = () => true, releaseAutomaticInstall = () => {},
} = {}) {
  if (!parseVersion(version)) throw new Error('A valid installed client version is required.');
  const supported = enabled && !portable;
  if (supported && (!updater?.on || !updater?.removeListener || !updater?.checkForUpdates || !updater?.quitAndInstall)) {
    throw new Error('The installed client updater is unavailable.');
  }
  let disposed = false;
  let checking;
  let installing;
  let downloadReady = false;
  let automaticInstallRequested = false;
  let manualInstallRequested = false;
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
    manualInstallRequested = false;
    downloadReady = false;
    return change({ status: 'error', message: updateError(error), installBlocked: false, progress: null });
  }
  function listen(event, callback) {
    const guarded = (...args) => { if (!disposed) callback(...args); };
    updater.on(event, guarded);
    listeners.push([event, guarded]);
  }

  function acceptedVersion(info) {
    const latestVersion = safeVersion(info);
    if (!latestVersion) { fail(new Error('Invalid update version')); return null; }
    if (!isNewerVersion(latestVersion, version)) {
      automaticInstallRequested = false;
      manualInstallRequested = false;
      downloadReady = false;
      change({ status: 'idle', latestVersion: null, progress: null, installBlocked: false,
        message: 'This cached update is not newer than your installed Ember version. Check for updates again.' });
      return null;
    }
    return latestVersion;
  }

  if (supported) {
    updater.autoDownload = true;
    // Installing on normal quit could interrupt downloads/game work. Only our guarded path installs.
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    listen('checking-for-update', () => change({ status: 'checking', message: 'Checking for a newer Ember version…', progress: null, installBlocked: false }));
    listen('update-available', info => {
      const latestVersion = acceptedVersion(info);
      if (!latestVersion) return;
      change({ status: 'available', latestVersion, message: `Ember ${latestVersion} is available. Preparing the download…`, installBlocked: false });
    });
    listen('update-not-available', () => {
      automaticInstallRequested = false;
      manualInstallRequested = false;
      change({ status: 'up-to-date', latestVersion: null, progress: null, installBlocked: false, message: 'You are using the latest Ember version.' });
    });
    listen('download-progress', progress => {
      const percent = Number.isFinite(progress?.percent) ? Math.min(100, Math.max(0, progress.percent)) : 0;
      change({ status: 'downloading', message: 'Downloading the Ember update…', installBlocked: false, progress: {
        percent, transferred: bytes(progress?.transferred), total: bytes(progress?.total), bytesPerSecond: bytes(progress?.bytesPerSecond),
      } });
    });
    listen('update-downloaded', info => {
      const latestVersion = acceptedVersion(info);
      if (!latestVersion) return;
      downloadReady = true;
      change({ status: 'downloaded', latestVersion, progress: null, installBlocked: false,
        message: `Ember ${latestVersion} is ready to install. Restart Ember to finish updating.` });
      if (manualInstallRequested) void installUpdate();
      else if (automaticInstallRequested) void installUpdate({ automatic: true });
    });
    listen('update-cancelled', () => {
      automaticInstallRequested = false;
      manualInstallRequested = false;
      downloadReady = false;
      change({ status: 'idle', progress: null, message: 'The client update download was cancelled. You can check again.' });
    });
    listen('error', fail);
  }

  function checkForUpdates({ automatic = false, installWhenReady = false } = {}) {
    if (disposed || !supported || state.status === 'installing') return Promise.resolve(getStatus());
    if (installWhenReady) {
      manualInstallRequested = true;
      automaticInstallRequested = false;
    } else if (automatic && !manualInstallRequested) automaticInstallRequested = true;
    if (downloadReady) return installWhenReady ? installUpdate() : Promise.resolve(getStatus());
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
    if (!downloadReady || !isNewerVersion(state.latestVersion, version)) return Promise.resolve(getStatus());
    const context = { automatic, fromVersion: version, toVersion: state.latestVersion };
    let reserved = false;
    let handoffStarted = false;
    const stillReady = () => downloadReady && state.latestVersion === context.toVersion && isNewerVersion(context.toVersion, version);
    const releaseReservation = async () => {
      if (reserved && !handoffStarted) {
        reserved = false;
        try { await releaseAutomaticInstall({ fromVersion: context.fromVersion, toVersion: context.toVersion }); } catch {}
      }
    };
    const work = Promise.resolve().then(async () => {
      let safe = false;
      try { safe = await canInstall(); } catch {}
      if (disposed || !stillReady()) return getStatus();
      if (safe !== true) {
        return change({ status: 'downloaded', installBlocked: true,
          message: manualInstallRequested || automaticInstallRequested
            ? 'The update is ready. Finish active downloads or profile work and close the game. Ember will restart when ready.'
            : 'The update is ready. Finish active downloads or profile work and close the game, then choose Install and restart.' });
      }
      if (automatic) {
        let allowed = false;
        try { allowed = await reserveAutomaticInstall({ fromVersion: context.fromVersion, toVersion: context.toVersion }); } catch {}
        if (allowed !== true) {
          automaticInstallRequested = false;
          return change({ status: 'downloaded', installBlocked: true,
            message: 'Automatic restart was paused because a previous update restart may not have completed or its status could not be saved. Choose Install and restart to try again.' });
        }
        reserved = true;
      }
      if (disposed || !stillReady()) { await releaseReservation(); return getStatus(); }
      await beforeInstall(context);
      if (disposed || !stillReady()) { await releaseReservation(); return getStatus(); }
      change({ status: 'installing', installBlocked: false, message: 'Restarting Ember to install the update…' });
      handoffStarted = true;
      // The first argument controls NSIS silent mode, independently of who requested the update.
      updater.quitAndInstall(true, true);
      return getStatus();
    }).catch(async () => {
      await releaseReservation();
      if (disposed) return getStatus();
      if (state.status === 'installing') {
        automaticInstallRequested = false;
        manualInstallRequested = false;
      }
      return change({ status: 'downloaded', installBlocked: true,
        message: 'The update is ready, but Ember could not restart to install it. Finish active work and try Install and restart again.' });
    });
    installing = work;
    void work.finally(() => { if (installing === work) installing = undefined; });
    return work;
  }

  function retryAutomaticInstall() {
    if (disposed || (!automaticInstallRequested && !manualInstallRequested) || !downloadReady) return Promise.resolve(getStatus());
    return installUpdate({ automatic: !manualInstallRequested });
  }

  function dispose() {
    disposed = true;
    for (const [event, listener] of listeners) updater.removeListener(event, listener);
    listeners.length = 0;
  }

  return { getStatus, checkForUpdates, installUpdate, retryAutomaticInstall, dispose };
}

module.exports = { createClientUpdates, isNewerVersion, isValidVersion: value => Boolean(parseVersion(value)) };
