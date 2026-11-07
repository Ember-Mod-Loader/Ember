const WAITING = new Set(['checking', 'available', 'downloading', 'downloaded', 'installing']);

export function createStartupUpdateFlow({
  start, finish = async () => null, onStatus = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, checkTimeoutMs = 15_000, downloadTimeoutMs = 45_000,
}) {
  let running;
  let active = false;
  let current;
  let revision = 0;
  let activityAt = 0;
  let checkStartedAt = 0;
  let wake;

  function update(status) {
    if (!active || !status || typeof status.status !== 'string') return;
    const phaseChanged = status.status !== current?.status;
    const progressed = status.status === 'downloading' && (
      Number(status.progress?.transferred) > Number(current?.progress?.transferred ?? -1) ||
      Number(status.progress?.percent) > Number(current?.progress?.percent ?? -1)
    );
    if (phaseChanged || progressed) activityAt = now();
    current = status;
    revision++;
    onStatus(status);
    wake?.();
  }

  function changedWithin(milliseconds) {
    return new Promise(resolve => {
      let timer;
      const done = () => {
        clearTimer(timer);
        if (wake === done) wake = undefined;
        resolve();
      };
      wake = done;
      if (Number.isFinite(milliseconds)) timer = setTimer(done, Math.max(0, milliseconds));
    });
  }

  function run() {
    if (running) return running;
    if (typeof start !== 'function') return running = Promise.resolve();
    active = true;
    checkStartedAt = activityAt = now();
    update({ status: 'checking', message: 'Checking for updates…' });
    const beforeStart = revision;
    void Promise.resolve().then(start).then(status => {
      if (revision === beforeStart) update(status);
    }).catch(() => {
      if (revision === beforeStart) update({ status: 'error', message: 'Could not check for updates. You can try again in Settings.' });
    });

    running = (async () => {
      try {
        while (active) {
          const terminal = !WAITING.has(current.status) || (current.status === 'downloaded' && current.installBlocked);
          if (terminal) {
            const afterFinish = await finish();
            // An install reservation can start while the renderer is finishing its check.
            if (afterFinish?.status === 'installing') { update(afterFinish); continue; }
            return current;
          }
          if (current.status === 'installing') { await changedWithin(Infinity); continue; }
          const remaining = current.status === 'checking'
            ? checkTimeoutMs - (now() - checkStartedAt)
            : downloadTimeoutMs - (now() - activityAt);
          if (remaining <= 0) {
            update({ ...current, status: 'error', message: current.status === 'checking'
              ? 'The update check is taking too long. Continuing to your workspace.'
              : 'The update is taking longer than expected. You can follow its progress in Settings.' });
            continue;
          }
          await changedWithin(remaining);
        }
      } finally {
        active = false;
        wake?.();
      }
    })();
    return running;
  }

  return { run, update, isActive: () => active };
}
