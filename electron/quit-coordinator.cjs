function createQuitCoordinator({
  app,
  dispose,
  onPending = () => {},
  onError = () => {},
  isUpdating = () => false,
  shouldDeferQuit = () => false,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutMs = 2200,
}) {
  if (!app || typeof app.on !== 'function' || typeof app.quit !== 'function' || typeof dispose !== 'function') {
    throw new TypeError('A quit coordinator needs an app and a cleanup function.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('Choose a finite quit cleanup timeout.');

  let pending = false;
  let committed = false;
  let quitRequested = false;
  let relaunchRequested = false;

  function report(error) {
    try { onError(error); } catch {}
  }

  function updating() {
    try { return Boolean(isUpdating()); } catch (error) {
      report(error);
      return true;
    }
  }

  function deferred() {
    try { return Boolean(shouldDeferQuit()); } catch (error) {
      report(error);
      return true;
    }
  }

  function beforeQuit(event) {
    if (committed) return;
    event.preventDefault();
    if (pending) return;
    if (deferred()) {
      quitRequested = false;
      return;
    }
    pending = true;
    quitRequested = true;
    try { onPending(); } catch (error) { report(error); }

    let deadline;
    const timeout = new Promise((_, reject) => {
      deadline = setTimer(() => reject(new Error('App cleanup exceeded the quit timeout.')), timeoutMs);
    });
    const cleanup = Promise.resolve().then(dispose);
    void Promise.race([cleanup, timeout]).catch(report).then(() => {
      if (committed) return;
      committed = true;
      try { clearTimer(deadline); } catch (error) { report(error); }
      if (relaunchRequested && !updating()) {
        try { app.relaunch(); } catch (error) { report(error); }
      }
      try { app.quit(); } catch (error) { report(error); }
    });
  }

  app.on('before-quit', beforeQuit);

  return {
    requestWindowClose(event) {
      if (committed) return;
      event.preventDefault();
      if (pending) return;
      if (deferred()) {
        quitRequested = false;
        return;
      }
      if (quitRequested) return;
      quitRequested = true;
      app.quit();
    },
    canClose: () => committed,
    isPending: () => pending && !committed,
    requestRelaunch() {
      if (!pending || committed || updating()) return false;
      relaunchRequested = true;
      return true;
    },
  };
}

module.exports = { createQuitCoordinator };
