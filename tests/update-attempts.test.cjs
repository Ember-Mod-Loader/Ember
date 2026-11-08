const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setImmediate: tick } = require('node:timers/promises');
const test = require('node:test');
const { createUpdateAttempts, AUTOMATIC_RETRY_WINDOW_MS } = require('../electron/update-attempts.cjs');
const { createClientUpdates } = require('../electron/client-updates.cjs');
const { temporaryDirectory } = require('./temp-directory.cjs');

const PAIR = { fromVersion: '0.5.2', toVersion: '0.5.3' };

test('an automatic handoff is recorded atomically and the same version pair is blocked for 24 hours across recreated guards', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'attempt.json');
  let time = 1_000_000;
  const create = () => createUpdateAttempts(file, { version: PAIR.fromVersion, now: () => time });
  assert.equal(await create().reserveAutomaticInstall(PAIR), true);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.attempt.fromVersion, PAIR.fromVersion);
  assert.equal(saved.attempt.toVersion, PAIR.toVersion);
  assert.equal(saved.attempt.attemptedAt, time);
  assert.equal(await create().reserveAutomaticInstall(PAIR), false);
  time += AUTOMATIC_RETRY_WINDOW_MS - 1;
  assert.equal(await create().reserveAutomaticInstall(PAIR), false);
  time++;
  assert.equal(await create().reserveAutomaticInstall(PAIR), true);
  assert.deepEqual(await fs.readdir(root), ['attempt.json']);
});

test('a changed installed version or target permits a fresh automatic attempt and concurrent calls coalesce safely', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'attempt.json');
  const attempts = createUpdateAttempts(file, { version: '0.5.2' });
  const results = await Promise.all([1, 2, 3].map(() => attempts.reserveAutomaticInstall(PAIR)));
  assert.deepEqual(results, [true, false, false]);
  assert.equal(await attempts.reserveAutomaticInstall({ fromVersion: '0.5.2', toVersion: '0.5.4' }), true);
  const updated = createUpdateAttempts(file, { version: '0.5.3' });
  assert.equal(await updated.reserveAutomaticInstall({ fromVersion: '0.5.3', toVersion: '0.5.4' }), true);
  assert.equal(await updated.reserveAutomaticInstall(PAIR), false);
  assert.equal(await updated.reserveAutomaticInstall({ fromVersion: '0.5.3', toVersion: '0.5.3+rebuilt' }), false);
});

test('a native busy race releases only the reservation created by that guard', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'attempt.json');
  const first = createUpdateAttempts(file, { version: '0.5.2' });
  const second = createUpdateAttempts(file, { version: '0.5.2' });
  assert.equal(await first.reserveAutomaticInstall(PAIR), true);
  await second.releaseAutomaticInstall(PAIR);
  assert.equal(await second.reserveAutomaticInstall(PAIR), false);
  const next = { fromVersion: '0.5.2', toVersion: '0.5.4' };
  assert.equal(await second.reserveAutomaticInstall(next), true);
  await first.releaseAutomaticInstall(PAIR);
  assert.equal(await first.reserveAutomaticInstall(next), false);
  await second.releaseAutomaticInstall(next);
  assert.equal(await first.reserveAutomaticInstall(next), true);
});

test('unreadable, malformed, or unwritable records fail closed without destroying a prior attempt', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'attempt.json');
  await fs.writeFile(file, '{invalid JSON');
  await assert.rejects(createUpdateAttempts(file, { version: '0.5.2' }).reserveAutomaticInstall(PAIR));
  await fs.rm(file);
  const first = createUpdateAttempts(file, { version: '0.5.2' });
  await first.reserveAutomaticInstall(PAIR);
  const original = await fs.readFile(file, 'utf8');
  const deniedRead = createUpdateAttempts(file, { version: '0.5.2', io: { ...fs,
    readFile: async () => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); },
  } });
  await assert.rejects(deniedRead.reserveAutomaticInstall(PAIR), /Denied/);
  const deniedRename = createUpdateAttempts(file, { version: '0.5.2', io: { ...fs,
    rename: async () => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); },
  } });
  await assert.rejects(deniedRename.reserveAutomaticInstall({ fromVersion: '0.5.2', toVersion: '0.5.4' }), /Denied/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.deepEqual(await fs.readdir(root), ['attempt.json']);
  const deniedWrite = createUpdateAttempts(path.join(root, 'new.json'), { version: '0.5.2', io: { ...fs,
    writeFile: async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); },
  } });
  await assert.rejects(deniedWrite.reserveAutomaticInstall(PAIR), /Disk full/);
  await assert.rejects(fs.stat(path.join(root, 'new.json')), { code: 'ENOENT' });
});

test('a failed automatic installer handoff is not retried on the next startup but manual installation still works', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'attempt.json');
  const clients = [];
  const makeClient = () => {
    const attempts = createUpdateAttempts(file, { version: '0.5.2' });
    const updater = new EventEmitter();
    updater.installs = [];
    updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.3' }); return {}; };
    // Simulate NSIS returning successfully even though its asynchronous child never restarts Ember.
    updater.quitAndInstall = (...args) => { updater.installs.push(args); };
    const client = createClientUpdates({ updater, version: '0.5.2', ...attempts });
    clients.push(client);
    return { updater, client };
  };
  t.after(() => { for (const client of clients) client.dispose(); });
  const first = makeClient();
  await first.client.checkForUpdates({ automatic: true });
  first.updater.emit('update-downloaded', { version: '0.5.3' });
  await first.client.retryAutomaticInstall();
  assert.deepEqual(first.updater.installs, [[true, true]]);
  const second = makeClient();
  await second.client.checkForUpdates({ automatic: true });
  second.updater.emit('update-downloaded', { version: '0.5.3' });
  await second.client.retryAutomaticInstall();
  assert.equal(second.client.getStatus().installBlocked, true);
  assert.deepEqual(second.updater.installs, []);
  await second.client.retryAutomaticInstall();
  assert.deepEqual(second.updater.installs, []);
  await second.client.installUpdate();
  assert.deepEqual(second.updater.installs, [[true, true]]);
});

test('busy work does not consume the persistent attempt and a native reservation race can retry', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'attempt.json');
  const attempts = createUpdateAttempts(file, { version: '0.5.2' });
  const updater = new EventEmitter();
  const installs = [];
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.3' }); return {}; };
  updater.quitAndInstall = (...args) => installs.push(args);
  let safe = false;
  let race = true;
  const client = createClientUpdates({ updater, version: '0.5.2', ...attempts,
    canInstall: () => safe,
    beforeInstall: () => { if (race) throw new Error('A download began'); },
  });
  t.after(() => client.dispose());
  await client.checkForUpdates({ automatic: true });
  updater.emit('update-downloaded', { version: '0.5.3' });
  await tick();
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  safe = true;
  await client.retryAutomaticInstall();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).attempt, null);
  race = false;
  await client.retryAutomaticInstall();
  assert.deepEqual(installs, [[true, true]]);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).attempt.toVersion, '0.5.3');
});
