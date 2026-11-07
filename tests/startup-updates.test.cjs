const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: tick } = require('node:timers/promises');
const test = require('node:test');
const { createStartupUpdates } = require('../electron/startup-updates.cjs');
const { createClientUpdates } = require('../electron/client-updates.cjs');

function clock() {
  let callback;
  return {
    options: { setTimer: fn => { callback = fn; return 1; }, clearTimer: () => { callback = null; } },
    expire: () => { assert(callback); callback(); },
    pending: () => Boolean(callback),
  };
}

test('startup checks begin once, coalesce, and cannot regain eligibility after finishing', async () => {
  const timer = clock();
  let status = { version: '0.5.3', status: 'idle' };
  let resolve, calls = 0;
  const gate = createStartupUpdates({ ...timer.options, getStatus: () => structuredClone(status), checkForUpdates: options => {
    assert.deepEqual(options, { automatic: true }); calls++;
    return new Promise(done => { resolve = done; });
  } });
  const first = gate.start();
  assert.equal(gate.start(), first);
  assert.equal(gate.isActive(), true);
  await tick();
  assert.equal(calls, 1);
  status = { version: '0.5.3', status: 'up-to-date' };
  resolve(status);
  assert.equal((await first).status, 'up-to-date');
  assert.equal(timer.pending(), false);
  assert.equal(gate.isActive(), true, 'The renderer must acknowledge the end of its inert startup screen.');
  assert.equal(gate.finish().status, 'up-to-date');
  assert.equal(gate.isActive(), false);
  await gate.start();
  assert.equal(calls, 1);
  assert.equal(gate.isActive(), false);
});

test('finishing before a check permanently seals the startup bypass', async () => {
  let calls = 0;
  const gate = createStartupUpdates({ getStatus: () => ({ status: 'idle' }), checkForUpdates: () => { calls++; } });
  gate.finish();
  assert.equal((await gate.start()).status, 'idle');
  assert.equal(calls, 0);
  assert.equal(gate.isActive(), false);
});

test('a stalled initial check returns an honest bounded result and safely observes a later rejection', async () => {
  const timer = clock();
  let reject;
  const gate = createStartupUpdates({ ...timer.options, getStatus: () => ({ status: 'checking', version: '0.5.3' }),
    checkForUpdates: () => new Promise((_, no) => { reject = no; }) });
  const waiting = gate.start();
  await tick();
  timer.expire();
  const result = await waiting;
  assert.equal(result.status, 'error');
  assert.equal(result.startupTimedOut, true);
  assert.match(result.message, /taking too long/);
  assert.equal(gate.isActive(), true);
  gate.finish();
  reject(new Error('Late network failure'));
  await tick();
  assert.equal(gate.isActive(), false);
});

test('the initial deadline preserves real download/install status instead of inventing a check failure', async () => {
  for (const state of ['available', 'downloading', 'downloaded', 'installing']) {
    const timer = clock();
    const gate = createStartupUpdates({ ...timer.options, getStatus: () => ({ status: state, version: '0.5.3' }),
      checkForUpdates: () => new Promise(() => {}) });
    const waiting = gate.start();
    timer.expire();
    assert.equal((await waiting).status, state);
  }
});

test('failed checks and unsupported builds finish without claiming an available update', async () => {
  const unsupported = createStartupUpdates({ getStatus: () => ({ status: 'unsupported' }), checkForUpdates: () => ({ status: 'unsupported' }) });
  assert.equal((await unsupported.start()).status, 'unsupported');
  unsupported.finish();
  assert.equal(unsupported.isActive(), false);
  const failure = createStartupUpdates({ getStatus: () => ({ status: 'idle' }), checkForUpdates: () => { throw new Error('offline'); } });
  assert.equal((await failure.start()).status, 'error');
  failure.finish();
  assert.equal(failure.isActive(), false);
});

function updater() {
  const updates = new EventEmitter();
  updates.installs = [];
  updates.quitAndInstall = (...args) => updates.installs.push(args);
  updates.checkForUpdates = async () => {
    updates.emit('checking-for-update');
    updates.emit('update-available', { version: '0.5.4' });
    updates.emit('update-downloaded', { version: '0.5.4' });
    return { updateInfo: { version: '0.5.4' } };
  };
  return updates;
}

test('a cached startup update installs while the workspace is inert, and the handoff notice cannot be dismissed by finish', async () => {
  const updates = updater();
  let gate, client, installing = false, handoff;
  const notice = new Promise(resolve => { handoff = resolve; });
  const rendererBusy = true;
  const hasWork = () => installing || (rendererBusy && !gate.isActive());
  client = createClientUpdates({ updater: updates, version: '0.5.3', canInstall: () => !hasWork(), beforeInstall: async () => {
    assert.equal(hasWork(), false);
    installing = true;
    await notice;
  } });
  gate = createStartupUpdates({ getStatus: () => client.getStatus(), checkForUpdates: options => client.checkForUpdates(options), isInstalling: () => installing });
  const first = await gate.start();
  await tick();
  assert.equal(first.status, 'installing');
  assert.equal(client.getStatus().status, 'downloaded', 'The native notice precedes the updater commit.');
  assert.equal(gate.finish().status, 'installing');
  assert.equal(gate.isActive(), true);
  assert.deepEqual(updates.installs, []);
  handoff();
  await tick();
  assert.deepEqual(updates.installs, [[true, true]], 'The real updater is told to reopen after the silent install.');
  assert.equal(gate.finish().status, 'installing');
  assert.equal(gate.isActive(), true);
  client.dispose();
});

test('finishing startup during the asynchronous game guard restores the renderer work lock before an install', async () => {
  const updates = updater();
  let gate, guardReady;
  const gameGuard = new Promise(resolve => { guardReady = resolve; });
  const rendererBusy = true;
  const hasWork = () => rendererBusy && !gate.isActive();
  const client = createClientUpdates({ updater: updates, version: '0.5.3', canInstall: async () => {
    if (hasWork()) return false;
    await gameGuard;
    return !hasWork();
  }, beforeInstall: () => assert.fail('A finished startup must wait for workspace readiness.') });
  gate = createStartupUpdates({ getStatus: () => client.getStatus(), checkForUpdates: options => client.checkForUpdates(options) });
  await gate.start();
  assert.equal(gate.finish().status, 'downloaded');
  assert.equal(gate.isActive(), false);
  guardReady();
  await tick();
  assert.equal(client.getStatus().status, 'downloaded');
  assert.equal(client.getStatus().installBlocked, true);
  assert.deepEqual(updates.installs, []);
  client.dispose();
});

test('finishing startup during reservation causes native preparation to abort and release the unconsumed attempt', async () => {
  const updates = updater();
  let gate, releaseReserve, released = 0;
  const reserved = new Promise(resolve => { releaseReserve = resolve; });
  const client = createClientUpdates({ updater: updates, version: '0.5.3', canInstall: () => gate.isActive(),
    reserveAutomaticInstall: () => reserved, releaseAutomaticInstall: () => { released++; },
    beforeInstall: () => { if (!gate.isActive()) throw new Error('Startup ended before installation.'); } });
  gate = createStartupUpdates({ getStatus: () => client.getStatus(), checkForUpdates: options => client.checkForUpdates(options) });
  await gate.start();
  await tick();
  gate.finish();
  releaseReserve(true);
  await tick();
  assert.equal(released, 1);
  assert.equal(client.getStatus().installBlocked, true);
  assert.deepEqual(updates.installs, []);
  client.dispose();
});
