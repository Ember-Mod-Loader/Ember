const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { on } = require('node:events');
const { watch } = require('node:fs');
const { mkdir, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createDownloadHistory, COMPLETED_RETENTION_MS, FAILED_RETENTION_MS } = require('../electron/download-history.cjs');
const { temporaryDirectory } = require('./temp-directory.cjs');

function operation(overrides = {}) {
  return {
    id: randomUUID(), gameId: 'lethal-company',
    profileId: 'lethal-company-default', profileName: 'Default', label: 'MoreCompany',
    ...overrides,
  };
}

const mod = {
  id: 'lethal-company/notnotnotswipez/MoreCompany',
  namespace: 'notnotnotswipez', name: 'MoreCompany', version: '1.14.0',
};
const key = `${mod.id}@${mod.version}`;

function cleanupClock() {
  let current = Date.now();
  const timers = new Map();
  return {
    options: {
      now: () => current,
      setCleanupTimeout(callback, delay) {
        const handle = { unref() {} };
        timers.set(handle, { callback, at: current + delay });
        return handle;
      },
      clearCleanupTimeout: handle => timers.delete(handle),
    },
    jump(ms) { current += ms; },
    stop() { timers.clear(); },
    async advance(ms) {
      current += ms;
      for (let turns = 0; turns < 100; turns++) {
        const next = [...timers].find(([, timer]) => timer.at <= current);
        if (!next) return;
        timers.delete(next[0]);
        await next[1].callback();
      }
      throw new Error('Cleanup timer did not settle.');
    },
  };
}

async function completedOperation(history, overrides) {
  const id = await history.start(operation(overrides));
  await history.ready(id);
  await history.complete(id);
  return id;
}

test('download history persists progress and completion with defensive published snapshots', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  const events = [];
  const history = await createDownloadHistory(file, record => {
    events.push(record);
    record.profileName = 'listener mutation';
  });
  const context = operation();
  assert.equal(await history.start(context), context.id);
  assert.equal(history.list()[0].status, 'resolving');
  history.plan(context.id, [mod]);
  history.progress(context.id, key, { status: 'downloading', received: 25, total: 100 });
  assert.equal(history.list()[0].packages[0].received, 25);
  await assert.rejects(history.ready(context.id), /not finished/);
  history.progress(context.id, key, { status: 'complete', received: 100, total: 100, cached: false });
  await history.ready(context.id);
  assert.equal(history.list()[0].status, 'saving');
  history.progress(context.id, key, { status: 'downloading', received: 0, total: null });
  await history.complete(context.id);

  const record = history.list()[0];
  assert.equal(record.status, 'complete');
  assert.equal(record.profileName, 'Default');
  assert.equal(record.packages[0].received, 100);
  assert.equal(record.packages[0].cached, false);
  record.packages.length = 0;
  assert.equal(history.list()[0].packages.length, 1);
  assert.ok(events.length >= 5);
  assert.deepEqual((await createDownloadHistory(file)).list(), history.list());
  assert.deepEqual((await readdir(root)).sort(), ['history.json']);
});

test('cached package progress and imported profile identity are recorded durably', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  const history = await createDownloadHistory(file, () => { throw new Error('broken UI listener'); });
  const id = await history.start(operation({ profileId: 'import-' + randomUUID() }));
  history.plan(id, [mod, mod]);
  history.progress(id, key, { status: 'complete', received: 80, total: 80, cached: true });
  await history.ready(id);
  const profile = { profileId: randomUUID(), profileName: 'Imported crew' };
  await history.complete(id, profile);
  const [record] = (await createDownloadHistory(file)).list();
  assert.equal(record.profileId, profile.profileId);
  assert.equal(record.profileName, profile.profileName);
  assert.equal(record.packages.length, 1);
  assert.equal(record.packages[0].cached, true);
  assert.equal(record.status, 'complete');
});

test('restart marks interrupted work failed and retains completed history', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  const history = await createDownloadHistory(file);
  const resolving = await history.start(operation());
  const downloading = await history.start(operation());
  history.plan(downloading, [mod]);
  history.progress(downloading, key, { status: 'downloading', received: 20, total: 100 });
  const saving = await history.start(operation());
  history.plan(saving, []);
  await history.ready(saving);
  const completed = await history.start(operation());
  await history.ready(completed);
  await history.complete(completed);

  const restarted = await createDownloadHistory(file);
  for (const id of [resolving, downloading, saving]) {
    const record = restarted.list().find(item => item.id === id);
    assert.equal(record.status, 'failed');
    assert.match(record.error, /Ember closed/);
  }
  assert.equal(restarted.list().find(item => item.id === completed).status, 'complete');
  assert.equal(restarted.list().find(item => item.id === downloading).packages[0].received, 20);
  assert.deepEqual((await createDownloadHistory(file)).list(), restarted.list());
});

test('invalid input and late progress leave a failed operation unchanged', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  const history = await createDownloadHistory(file);
  await assert.rejects(history.start(operation({ id: '../bad' })), /Invalid download operation/);
  await assert.rejects(history.start(operation({ gameId: 'unknown' })), /Invalid download operation/);
  const context = operation();
  const id = await history.start(context);
  await assert.rejects(history.start(context), /already exists/);
  assert.throws(() => history.plan(id, [{ ...mod, id: 'lethal-company/team/other' }]), /Invalid download package/);
  history.plan(id, [mod]);
  history.progress(id, key, { status: 'downloading', received: -1, total: null });
  assert.equal(history.list()[0].packages[0].received, 0);
  await history.fail(id, new Error('Connection interrupted'));
  const before = history.list();
  history.progress(id, key, { status: 'complete', received: 100, total: 100 });
  assert.deepEqual(history.list(), before);
  assert.match(history.list()[0].error, /Connection interrupted/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).records, before);
});

test('history retains fifty terminal records plus all active operations', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  const removed = [];
  const history = await createDownloadHistory(file, event => { if (event.removed) removed.push(event.id); });
  const active = await history.start(operation());
  for (let index = 0; index < 53; index++) {
    const id = await history.start(operation({ label: 'Package ' + index }));
    await history.fail(id, 'test failure');
  }
  const records = history.list();
  assert.equal(records.length, 51);
  assert.equal(records.filter(record => record.status === 'failed').length, 50);
  assert.equal(records.find(record => record.id === active).status, 'resolving');
  assert.equal(removed.length, 3);
  assert.equal(removed.some(id => records.some(record => record.id === id)), false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).records.length, 51);
});

test('initial and terminal write failures reject without committing their transitions', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  await mkdir(file);
  const history = await createDownloadHistory(file);
  await assert.rejects(history.start(operation()), /could not save download history/);
  assert.deepEqual(history.list(), []);
  await rm(file, { recursive: true });
  const id = await history.start(operation());
  history.plan(id, []);
  await history.ready(id);
  await rm(file);
  await mkdir(file);
  await assert.rejects(history.complete(id), /could not save download history/);
  assert.equal(history.list()[0].status, 'saving');
  assert.deepEqual((await readdir(root)).sort(), ['history.json']);
});

test('corrupted history can be replaced by a valid new operation', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  await writeFile(file, '{broken');
  const history = await createDownloadHistory(file);
  assert.deepEqual(history.list(), []);
  const id = await history.start(operation());
  await history.fail(id, 'test complete');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).records[0].status, 'failed');
});

test('progress saves coalesce the latest bytes and concurrent operations stay distinct', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  const history = await createDownloadHistory(file);
  const contexts = [operation(), operation(), operation()];
  await Promise.all(contexts.map(context => history.start(context)));
  const id = contexts[0].id;
  const watcher = watch(root);
  t.after(() => watcher.close());
  const writes = on(watcher, 'change', { signal: AbortSignal.timeout(10_000) });
  history.plan(id, [mod]);
  history.progress(id, key, { status: 'downloading', received: 15, total: 100 });
  history.progress(id, key, { status: 'downloading', received: 35, total: 100 });
  const initial = JSON.parse(await readFile(file, 'utf8')).records.find(record => record.id === id);
  assert.equal(initial.packages.length, 0);
  // The save timer queues an atomic file write. Wait for its committed snapshot
  // without keeping the destination open while Windows replaces it.
  for await (const [, filename] of writes) {
    if (filename === path.basename(file)) break;
  }
  const saved = JSON.parse(await readFile(file, 'utf8')).records.find(record => record.id === id);
  assert.equal(saved.packages[0].received, 35);
  assert.equal(history.list().length, 3);
  await Promise.all(contexts.map(context => history.fail(context.id, 'test ended')));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).records.filter(record => record.status === 'failed').length, 3);
});

test('completed entries expire after thirty seconds and failures after five minutes', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  const clock = cleanupClock();
  const events = [];
  const history = await createDownloadHistory(file, event => events.push(event), clock.options);
  const active = await history.start(operation());
  const failed = await history.start(operation());
  await history.fail(failed, 'Keep this error visible');
  const finishing = await history.start(operation());
  const downloadTime = 120_000;
  await clock.advance(downloadTime);
  await history.ready(finishing);
  await history.complete(finishing);
  await clock.advance(COMPLETED_RETENTION_MS - 1);
  assert.equal(history.list().find(record => record.id === finishing).status, 'complete');
  await clock.advance(1);
  assert.deepEqual(new Set(history.list().map(record => record.id)), new Set([active, failed]));
  assert.equal(history.list().find(record => record.id === active).status, 'resolving');
  assert.equal(history.list().find(record => record.id === failed).error, 'Keep this error visible');
  assert.deepEqual(events.filter(event => event.removed), [{ id: finishing, removed: true }]);
  await clock.advance(FAILED_RETENTION_MS - downloadTime - COMPLETED_RETENTION_MS - 1);
  assert.equal(history.list().find(record => record.id === failed).status, 'failed');
  await clock.advance(1);
  assert.deepEqual(history.list().map(record => record.id), [active]);
  assert.deepEqual(events.filter(event => event.removed), [{ id: finishing, removed: true }, { id: failed, removed: true }]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).records, history.list());
});

test('restart prunes expired completions and failures and keeps recent completions', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  const clock = cleanupClock();
  const first = await createDownloadHistory(file, undefined, clock.options);
  const failed = await first.start(operation());
  await first.fail(failed, 'Old failure');
  await clock.advance(FAILED_RETENTION_MS - 35_000);
  const old = await completedOperation(first);
  await clock.advance(20_000);
  const recent = await completedOperation(first);
  const interrupted = await first.start(operation());
  clock.stop();
  clock.jump(15_000);
  const restarted = await createDownloadHistory(file, undefined, clock.options);
  assert.equal(restarted.list().some(record => record.id === old), false);
  assert.equal(restarted.list().some(record => record.id === failed), false);
  assert.equal(restarted.list().find(record => record.id === recent).status, 'complete');
  assert.equal(restarted.list().find(record => record.id === interrupted).status, 'failed');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).records, restarted.list());
  await clock.advance(14_999);
  assert.equal(restarted.list().some(record => record.id === recent), true);
  await clock.advance(1);
  assert.deepEqual(restarted.list().map(record => record.id), [interrupted]);
});

test('clear finished removes completions and failures for one game and preserves concurrent completion', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  const clock = cleanupClock();
  const history = await createDownloadHistory(file, undefined, clock.options);
  const old = await completedOperation(history);
  const repo = await completedOperation(history, { gameId: 'repo', profileId: 'repo-default' });
  const failed = await history.start(operation());
  await history.fail(failed, 'Connection failed');
  const failedRepo = await history.start(operation({ gameId: 'repo', profileId: 'repo-default' }));
  await history.fail(failedRepo, 'Connection failed in another game');
  const finishing = await history.start(operation());
  await history.ready(finishing);
  const before = history.list();
  assert.throws(() => history.clearFinished('../bad'), /valid game/);
  assert.throws(() => history.clearFinished(undefined), /valid game/);
  assert.deepEqual(history.list(), before);
  const [removed] = await Promise.all([history.clearFinished('lethal-company'), history.complete(finishing)]);
  assert.deepEqual(new Set(removed), new Set([old, failed]));
  assert.equal(history.list().find(record => record.id === finishing).status, 'complete');
  assert.equal(history.list().find(record => record.id === repo).status, 'complete');
  assert.equal(history.list().find(record => record.id === failedRepo).status, 'failed');
  assert.deepEqual(await history.clearFinished('lethal-company'), [finishing]);
  assert.deepEqual(await history.clearFinished('lethal-company'), []);
  assert.deepEqual(new Set(history.list().map(record => record.id)), new Set([repo, failedRepo]));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).records, history.list());
});

test('failed cleanup rolls back without removal events and retries automatically after storage recovers', async t => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'history.json');
  const clock = cleanupClock();
  const events = [];
  const history = await createDownloadHistory(file, event => events.push(event), clock.options);
  const completed = await completedOperation(history);
  const active = await history.start(operation());
  const before = history.list();
  await rm(file);
  await mkdir(file);
  await assert.rejects(history.clearFinished('lethal-company'), /could not clear download history/);
  assert.deepEqual(history.list(), before);
  await clock.advance(COMPLETED_RETENTION_MS);
  assert.deepEqual(history.list(), before);
  assert.deepEqual(events.filter(event => event.removed), []);
  await rm(file, { recursive: true });
  await clock.advance(1000);
  assert.deepEqual(history.list().map(record => record.id), [active]);
  assert.deepEqual(events.filter(event => event.removed), [{ id: completed, removed: true }]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).records, history.list());
});
