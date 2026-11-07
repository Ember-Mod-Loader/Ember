import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { createStartupUpdateFlow } from '../src/startup-updates.js';

test('startup update waits through real download progress and installation without opening the workspace', async () => {
  let finishes = 0;
  const seen = [];
  const flow = createStartupUpdateFlow({ start: async () => ({ status: 'available', latestVersion: '0.5.5' }),
    finish: async () => { finishes++; return {}; }, onStatus: status => seen.push(status), checkTimeoutMs: 10, downloadTimeoutMs: 10 });
  let completed = false;
  const work = flow.run().then(() => { completed = true; });
  await tick();
  flow.update({ status: 'downloading', progress: { percent: 42, transferred: 420 } });
  flow.update({ status: 'installing' });
  await delay(25);
  assert.equal(completed, false);
  assert.equal(finishes, 0);
  assert.equal(seen.find(status => status.status === 'downloading').progress.percent, 42);
  flow.update({ status: 'error', message: 'The installer could not start.' });
  await work;
  assert.equal(finishes, 1);
  assert.equal(flow.isActive(), false);
});

test('a late initial API snapshot cannot overwrite newer download events', async () => {
  let reply;
  let finished = false;
  const flow = createStartupUpdateFlow({ start: () => new Promise(resolve => { reply = resolve; }), finish: async () => { finished = true; } });
  const work = flow.run();
  await tick();
  flow.update({ status: 'downloading', progress: { percent: 60, transferred: 600 } });
  reply({ status: 'up-to-date' });
  await tick();
  assert.equal(finished, false);
  flow.update({ status: 'downloaded', installBlocked: true });
  await work;
  assert.equal(finished, true);
});

test('offline checks and hung checks finish startup once without claiming an up-to-date client', async () => {
  for (const start of [async () => { throw new Error('offline'); }, () => new Promise(() => {})]) {
    const statuses = [];
    let checks = 0;
    let finishes = 0;
    const flow = createStartupUpdateFlow({ start: () => { checks++; return start(); }, checkTimeoutMs: 10,
      finish: async () => { finishes++; }, onStatus: status => statuses.push(status.status) });
    await flow.run();
    await flow.run();
    assert.equal(checks, 1);
    assert.equal(finishes, 1);
    assert.equal(statuses.at(-1), 'error');
    assert(!statuses.includes('up-to-date'));
  }
});

test('stalled download events do not keep resetting the startup timeout', async () => {
  let clock = 0;
  let callback;
  const seen = [];
  const flow = createStartupUpdateFlow({ start: async () => ({ status: 'downloading', progress: { percent: 5, transferred: 500 } }),
    finish: async () => ({ status: 'downloading' }), now: () => clock,
    setTimer: task => { callback = task; return 1; }, clearTimer: () => {}, downloadTimeoutMs: 45,
    onStatus: state => seen.push(state) });
  const work = flow.run();
  await tick();
  clock = 44;
  flow.update({ status: 'downloading', progress: { percent: 5, transferred: 500 } });
  await tick();
  clock = 46;
  callback();
  await work;
  assert.equal(seen.at(-1).status, 'error');
  assert.match(seen.at(-1).message, /Settings/);
});

test('finishing startup cannot race past a reserved installer handoff', async () => {
  let finishes = 0;
  let complete = false;
  const flow = createStartupUpdateFlow({ start: async () => ({ status: 'error' }), finish: async () => {
    finishes++;
    return finishes === 1 ? { status: 'installing' } : { status: 'error' };
  }, checkTimeoutMs: 5, downloadTimeoutMs: 5 });
  const work = flow.run().then(() => { complete = true; });
  await tick();
  await delay(12);
  assert.equal(complete, false);
  assert.equal(finishes, 1);
  flow.update({ status: 'error' });
  await work;
  assert.equal(finishes, 2);
});

test('portable or browser startup can proceed without a native updater', async () => {
  const flow = createStartupUpdateFlow({});
  await flow.run();
  assert.equal(flow.isActive(), false);
});
