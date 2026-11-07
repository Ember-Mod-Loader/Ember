const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { setImmediate: tick } = require('node:timers/promises');
const { createQuitCoordinator } = require('../electron/quit-coordinator.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function closeEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

function fixture(dispose, extra = {}) {
  const app = new EventEmitter();
  const calls = [];
  const errors = [];
  const quitEvents = [];
  const timers = new Map();
  let nextTimer = 0;
  app.quit = () => {
    calls.push('quit');
    const event = closeEvent();
    quitEvents.push(event);
    app.emit('before-quit', event);
    if (!event.prevented) calls.push('closed');
  };
  app.relaunch = () => calls.push('relaunch');
  const coordinator = createQuitCoordinator({
    app,
    dispose: async () => { calls.push('dispose'); return dispose(); },
    onPending: () => calls.push('pending'),
    onError: error => errors.push(error),
    setTimer(callback, timeout) { const id = ++nextTimer; timers.set(id, { callback, timeout }); return id; },
    clearTimer(id) { timers.delete(id); },
    ...extra,
  });
  return { app, calls, errors, quitEvents, timers, coordinator };
}

async function settle() { await tick(); await tick(); }

test('window close waits for cleanup, then allows the final quit without recursion', async () => {
  const cleanup = deferred();
  const { coordinator, calls, quitEvents, timers } = fixture(() => cleanup.promise);
  const event = closeEvent();
  coordinator.requestWindowClose(event);
  assert.equal(event.prevented, true);
  assert.equal(coordinator.isPending(), true);
  assert.equal(coordinator.canClose(), false);
  assert.equal(quitEvents[0].prevented, true);
  await settle();
  assert.deepEqual(calls, ['quit', 'pending', 'dispose']);
  assert.equal([...timers.values()][0].timeout, 2200);
  cleanup.resolve();
  await settle();
  assert.deepEqual(calls, ['quit', 'pending', 'dispose', 'quit', 'closed']);
  assert.equal(quitEvents[1].prevented, false);
  assert.equal(coordinator.canClose(), true);
  assert.equal(coordinator.isPending(), false);
  assert.equal(timers.size, 0);
  const finalClose = closeEvent();
  coordinator.requestWindowClose(finalClose);
  assert.equal(finalClose.prevented, false);
  assert.equal(calls.filter(call => call === 'quit').length, 2);
});

test('repeated close and before-quit requests run cleanup and pending notification only once', async () => {
  const cleanup = deferred();
  const { app, coordinator, calls, quitEvents } = fixture(() => cleanup.promise);
  coordinator.requestWindowClose(closeEvent());
  coordinator.requestWindowClose(closeEvent());
  app.quit();
  app.quit();
  await settle();
  assert.equal(calls.filter(call => call === 'dispose').length, 1);
  assert.equal(calls.filter(call => call === 'pending').length, 1);
  assert.equal(calls.filter(call => call === 'quit').length, 3);
  assert(quitEvents.every(event => event.prevented));
  cleanup.resolve();
  await settle();
  assert.equal(calls.filter(call => call === 'closed').length, 1);
  assert.equal(calls.filter(call => call === 'quit').length, 4);
});

test('cleanup rejection still commits the quit and reports the original error', async () => {
  const failure = new Error('Leave request failed');
  const { app, coordinator, calls, errors, timers } = fixture(() => { throw failure; });
  app.quit();
  await settle();
  assert.deepEqual(errors, [failure]);
  assert.equal(coordinator.canClose(), true);
  assert.equal(calls.at(-1), 'closed');
  assert.equal(timers.size, 0);
});

test('a hung cleanup is bounded and a late settlement never requests another quit', async () => {
  for (const rejectLate of [false, true]) {
    const cleanup = deferred();
    const { app, coordinator, calls, errors, timers } = fixture(() => cleanup.promise, { timeoutMs: 17 });
    app.quit();
    await settle();
    assert.equal(coordinator.canClose(), false);
    const deadline = [...timers.values()][0];
    assert.equal(deadline.timeout, 17);
    deadline.callback();
    await settle();
    assert.equal(coordinator.canClose(), true);
    assert.equal(calls.at(-1), 'closed');
    assert.match(errors[0].message, /quit timeout/);
    const before = [...calls];
    if (rejectLate) cleanup.reject(new Error('Late cleanup failure'));
    else cleanup.resolve();
    await settle();
    assert.deepEqual(calls, before);
    assert.equal(errors.length, 1);
  }
});

test('opening the app during cleanup queues exactly one relaunch before the final quit', async () => {
  const cleanup = deferred();
  const { app, coordinator, calls } = fixture(() => cleanup.promise);
  assert.equal(coordinator.requestRelaunch(), false);
  app.quit();
  assert.equal(coordinator.requestRelaunch(), true);
  assert.equal(coordinator.requestRelaunch(), true);
  await settle();
  cleanup.resolve();
  await settle();
  assert.deepEqual(calls, ['quit', 'pending', 'dispose', 'relaunch', 'quit', 'closed']);
  assert.equal(coordinator.requestRelaunch(), false);
});

test('the updater owns restart, including when updating begins after a relaunch was queued', async () => {
  for (const updatingInitially of [true, false]) {
    const cleanup = deferred();
    let updating = updatingInitially;
    const { app, coordinator, calls } = fixture(() => cleanup.promise, { isUpdating: () => updating });
    app.quit();
    assert.equal(coordinator.requestRelaunch(), !updatingInitially);
    updating = true;
    cleanup.resolve();
    await settle();
    assert.equal(calls.includes('relaunch'), false);
    assert.equal(calls.at(-1), 'closed');
  }
});

test('notification errors do not prevent cleanup or the final quit', async () => {
  let cleaned = false;
  const { app, coordinator, calls } = fixture(() => { cleaned = true; }, {
    onPending() { throw new Error('Notification failed'); },
    onError() { throw new Error('Logging failed'); },
  });
  app.quit();
  await settle();
  assert.equal(cleaned, true);
  assert.equal(coordinator.canClose(), true);
  assert.equal(calls.at(-1), 'closed');
});

test('update preparation defers close and quit without cleanup, then permits one final coordinated quit', async () => {
  const cleanup = deferred();
  let preparingUpdate = true;
  const { app, coordinator, calls, quitEvents, timers } = fixture(() => cleanup.promise, {
    shouldDeferQuit: () => preparingUpdate,
  });
  for (let index = 0; index < 3; index++) {
    const event = closeEvent();
    coordinator.requestWindowClose(event);
    assert.equal(event.prevented, true);
  }
  assert.deepEqual(calls, []);
  app.quit();
  app.quit();
  await settle();
  assert.deepEqual(calls, ['quit', 'quit']);
  assert(quitEvents.every(event => event.prevented));
  assert.equal(timers.size, 0);
  assert.equal(coordinator.isPending(), false);
  assert.equal(coordinator.canClose(), false);
  assert.equal(coordinator.requestRelaunch(), false);

  preparingUpdate = false;
  coordinator.requestWindowClose(closeEvent());
  coordinator.requestWindowClose(closeEvent());
  await settle();
  assert.deepEqual(calls, ['quit', 'quit', 'quit', 'pending', 'dispose']);
  assert.equal(coordinator.isPending(), true);
  cleanup.resolve();
  await settle();
  assert.deepEqual(calls, ['quit', 'quit', 'quit', 'pending', 'dispose', 'quit', 'closed']);
  assert.equal(coordinator.canClose(), true);
  assert.equal(timers.size, 0);
});

test('a deferred direct quit can be retried after the updater permits handoff', async () => {
  let deferQuit = true;
  const { app, coordinator, calls } = fixture(() => {}, { shouldDeferQuit: () => deferQuit });
  app.quit();
  await settle();
  assert.deepEqual(calls, ['quit']);
  assert.equal(coordinator.isPending(), false);
  deferQuit = false;
  app.quit();
  await settle();
  assert.deepEqual(calls, ['quit', 'quit', 'pending', 'dispose', 'quit', 'closed']);
  assert.equal(coordinator.canClose(), true);
});

test('a quit deferral predicate failure keeps the app open and reports the error until a successful retry', async () => {
  const failure = new Error('Update handoff state unavailable');
  let fail = true;
  const { app, coordinator, calls, errors, timers } = fixture(() => {}, {
    shouldDeferQuit() { if (fail) throw failure; return false; },
  });
  const event = closeEvent();
  coordinator.requestWindowClose(event);
  assert.equal(event.prevented, true);
  app.quit();
  await settle();
  assert.deepEqual(calls, ['quit']);
  assert.deepEqual(errors, [failure, failure]);
  assert.equal(coordinator.isPending(), false);
  assert.equal(coordinator.requestRelaunch(), false);
  assert.equal(timers.size, 0);
  fail = false;
  coordinator.requestWindowClose(closeEvent());
  await settle();
  assert.deepEqual(calls, ['quit', 'quit', 'pending', 'dispose', 'quit', 'closed']);
});

test('deferral beginning between window close and before-quit does not leave a latched quit request', async () => {
  let checks = 0;
  const { coordinator, calls, quitEvents } = fixture(() => {}, {
    shouldDeferQuit: () => ++checks === 2,
  });
  coordinator.requestWindowClose(closeEvent());
  await settle();
  assert.deepEqual(calls, ['quit']);
  assert.equal(quitEvents[0].prevented, true);
  assert.equal(coordinator.isPending(), false);
  coordinator.requestWindowClose(closeEvent());
  await settle();
  assert.deepEqual(calls, ['quit', 'quit', 'pending', 'dispose', 'quit', 'closed']);
});
