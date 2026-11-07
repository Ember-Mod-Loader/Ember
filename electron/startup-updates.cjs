function createStartupUpdates({
  getStatus,
  checkForUpdates,
  isInstalling = () => false,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutMs = 15_000,
}) {
  if (typeof getStatus !== 'function' || typeof checkForUpdates !== 'function' ||
      typeof isInstalling !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('Startup updates need a status reader, update check, and finite timeout.');
  }
  let active = false;
  let finished = false;
  let starting;

  function snapshot() {
    const status = getStatus();
    // The native handoff notice begins before the updater commits its installing state.
    if (isInstalling() && status.status !== 'installing') {
      return { ...status, status: 'installing', installBlocked: false,
        message: 'Updating Ember. Ember will reopen automatically.' };
    }
    return status;
  }

  function start() {
    if (finished) return Promise.resolve(snapshot());
    if (starting) return starting;
    active = true;
    let deadline;
    const timeout = new Promise(resolve => {
      deadline = setTimer(() => {
        const status = snapshot();
        if (['available', 'downloading', 'downloaded', 'installing'].includes(status.status)) {
          resolve(status);
        } else {
          resolve({ ...status, status: 'error', startupTimedOut: true,
            message: 'The update check is taking too long. Ember will continue opening.' });
        }
      }, timeoutMs);
    });
    // Keep observing a late check after timeout, while letting the workspace finish opening.
    const check = Promise.resolve().then(() => checkForUpdates({ automatic: true }))
      .then(() => snapshot()).catch(() => ({ ...snapshot(), status: 'error',
        message: 'Could not check for updates. Ember will continue opening.' }));
    starting = Promise.race([check, timeout]).finally(() => clearTimer(deadline));
    return starting;
  }

  function finish() {
    const status = snapshot();
    if (status.status === 'installing') return status;
    active = false;
    finished = true;
    return status;
  }

  return { start, finish, isActive: () => active };
}

module.exports = { createStartupUpdates };
