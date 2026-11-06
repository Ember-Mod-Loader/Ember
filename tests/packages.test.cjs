const assert = require('node:assert/strict');
const { readFile, readdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createPackageCache } = require('../electron/packages.cjs');
const { temporaryDirectory } = require('./temp-directory.cjs');
const { zipFixture } = require('./zip-fixture.cjs');

const packageId = Object.freeze({ gameId: 'lethal-company', namespace: 'Test-team', name: 'Plugin', version: '1.2.3' });
const archive = zipFixture([{ name: 'README.md', content: 'ModRelay test package' }]);
const gameFolder = root => path.join(root, packageId.gameId);
const origin = 'https://thunderstore.io/package/download/Test-team/Plugin/1.2.3/';
const mirror = 'https://gcdn.thunderstore.io/live/repository/packages/Test-team-Plugin-1.2.3.zip';

test('downloads follow the expected CDN route, coalesce concurrency, and reuse the cached ZIP', async t => {
  const root = await temporaryDirectory(t);
  const requests = [];
  const cache = createPackageCache(root, async (url, options) => {
    requests.push(url.href);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    return url.href === origin ? Response.redirect(mirror) : new Response(archive);
  });

  const [first, concurrent] = await Promise.all([cache.downloadPackage(packageId), cache.downloadPackage(packageId)]);
  assert.equal(first.filename, concurrent.filename);
  assert.equal(first.bytes, archive.length);
  assert.equal(first.cached, false);
  assert.deepEqual(requests, [origin, mirror]);
  assert.deepEqual(await readFile(path.join(gameFolder(root), first.filename)), archive);
  assert.deepEqual(await cache.downloadPackage(packageId), { ...first, cached: true });
  assert.deepEqual(requests, [origin, mirror]);

  await writeFile(path.join(gameFolder(root), first.filename), 'damaged');
  assert.deepEqual(await cache.downloadPackage(packageId), first);
  assert.deepEqual(requests, [origin, mirror, origin, mirror]);
  assert.deepEqual(await readFile(path.join(gameFolder(root), first.filename)), archive);
});

test('download cache keeps Thunderstore package casing distinct on Windows', async t => {
  const root = await temporaryDirectory(t);
  const cache = createPackageCache(root, async () => new Response(archive));
  const first = await cache.downloadPackage(packageId);
  const second = await cache.downloadPackage({ ...packageId, name: 'plugin' });
  assert.notEqual(first.filename.toLowerCase(), second.filename.toLowerCase());
  assert.equal(second.cached, false);
  assert.equal((await readdir(gameFolder(root))).length, 2);
});

test('downloads reject unexpected redirects and unsafe package identifiers', async t => {
  const root = await temporaryDirectory(t);
  const calls = [];
  let redirect = '';
  const cache = createPackageCache(root, async url => {
    calls.push(url.href);
    return Response.redirect(redirect);
  });

  for (const bad of [
    { ...packageId, gameId: '..' },
    { ...packageId, namespace: 'team/name' },
    { ...packageId, name: '../Plugin' },
    { ...packageId, version: '1.2.3/other' },
  ]) {
    await assert.rejects(() => cache.downloadPackage(bad), /valid Thunderstore package/);
  }
  assert.deepEqual(calls, []);

  for (const location of [
    mirror.replace('https:', 'http:'),
    mirror.replace('gcdn.thunderstore.io', 'gcdn.thunderstore.io.example.test'),
    mirror.replace('gcdn.thunderstore.io', 'name:password@gcdn.thunderstore.io'),
    mirror.replace('gcdn.thunderstore.io', 'gcdn.thunderstore.io:444'),
    mirror.replace('Plugin-1.2.3.zip', 'Other-1.2.3.zip'),
    'https://thunderstore.io/another-route',
  ]) {
    redirect = location;
    await assert.rejects(() => cache.downloadPackage(packageId), /unexpected download address/);
  }
  assert.deepEqual(calls, Array(6).fill(origin));
  assert.deepEqual(await readdir(gameFolder(root)), []);
});

test('invalid and oversized responses leave no partial cache and a clean retry succeeds', async t => {
  const root = await temporaryDirectory(t);
  const responses = [
    new Response(archive.subarray(0, -1)),
    new Response(archive, { headers: { 'content-length': archive.length + 1 } }),
    new Response(archive, { headers: { 'content-length': 1024 ** 3 + 1 } }),
    new Response(archive),
  ];
  const cache = createPackageCache(root, async () => responses.shift());

  for (const message of [/complete ZIP/, /complete ZIP/, /download limit/]) {
    await assert.rejects(() => cache.downloadPackage(packageId), message);
    assert.deepEqual(await readdir(gameFolder(root)), []);
  }

  const result = await cache.downloadPackage(packageId);
  assert.equal(result.cached, false);
  assert.deepEqual(await readdir(gameFolder(root)), [result.filename]);
});

test('download progress reaches every subscriber and a late subscriber receives current bytes', async t => {
  const root = await temporaryDirectory(t);
  let controller;
  let headersReady;
  let chunkReady;
  const gotHeaders = new Promise(resolve => { headersReady = resolve; });
  const gotChunk = new Promise(resolve => { chunkReady = resolve; });
  let clock = 0;
  t.mock.method(Date, 'now', () => clock);
  const stream = new ReadableStream({ start(value) { controller = value; } });
  let requests = 0;
  const cache = createPackageCache(root, async () => {
    requests++;
    return new Response(stream, { headers: { 'content-length': archive.length } });
  });
  const firstEvents = [];
  const first = cache.downloadPackage(packageId, progress => {
    firstEvents.push(progress);
    if (progress.total === archive.length) headersReady();
    if (progress.received > 0) chunkReady();
  });
  await gotHeaders;
  clock = 150;
  controller.enqueue(archive.subarray(0, 8));
  await gotChunk;
  const lateEvents = [];
  const late = cache.downloadPackage(packageId, progress => lateEvents.push(progress));
  const throwing = cache.downloadPackage(packageId, () => { throw new Error('A disconnected UI callback'); });
  assert.equal(lateEvents[0].received, 8);
  clock = 160;
  controller.enqueue(archive.subarray(8, 16));
  await new Promise(setImmediate);
  assert.equal(firstEvents.filter(event => event.received === 16).length, 0);
  clock = 300;
  controller.enqueue(archive.subarray(16));
  controller.close();
  const [result, lateResult, throwingResult] = await Promise.all([first, late, throwing]);
  assert.equal(requests, 1);
  assert.deepEqual(lateResult, result);
  assert.deepEqual(throwingResult, result);
  for (const events of [firstEvents, lateEvents]) {
    assert.deepEqual(events.at(-1), { received: archive.length, total: archive.length, status: 'complete', cached: false });
    assert(events.every((event, index) => index === 0 || event.received >= events[index - 1].received));
  }
  const cachedEvents = [];
  await cache.downloadPackage(packageId, progress => cachedEvents.push(progress));
  assert.deepEqual(cachedEvents.at(-1), { received: archive.length, total: archive.length, status: 'complete', cached: true });
});

test('progress supports unknown content lengths and never completes an invalid ZIP', async t => {
  const root = await temporaryDirectory(t);
  let valid = false;
  const cache = createPackageCache(root, async () => new Response(valid ? archive : archive.subarray(0, -1)));
  const failedEvents = [];
  await assert.rejects(cache.downloadPackage(packageId, progress => failedEvents.push(progress)), /complete ZIP/);
  assert(failedEvents.every(event => event.status === 'downloading' && event.total === null));
  valid = true;
  const events = [];
  await cache.downloadPackage(packageId, progress => events.push(progress));
  assert(events.slice(0, -1).every(event => event.total === null));
  assert.equal(events.at(-1).status, 'complete');
  assert.equal(events.at(-1).total, archive.length);
});

test('PEAK catalog packages download into their game cache and persist profile history', async t => {
  const root = await temporaryDirectory(t);
  const { getGame } = await import('../src/catalog.js');
  assert.equal(getGame('peak').steamId, '3527290');
  assert.equal(getGame('peak').icon, './art/game-peak.jpg');
  const modulePath = require.resolve('../electron/thunderstore.cjs');
  delete require.cache[modulePath];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    assert.match(url.pathname, /\/peak\//);
    return url.pathname.endsWith('/filters/')
      ? Response.json({ package_categories: [] })
      : Response.json({
        count: 1, next: null,
        results: [{ community_identifier: 'peak', namespace: 'Test-team', name: 'Plugin', latest_version_number: '1.2.3' }],
      });
  });
  const { fetchCatalog } = require(modulePath);
  const { mods } = await fetchCatalog({ gameId: 'peak' });
  assert.equal(mods[0].id, 'peak/Test-team/Plugin');
  const { createDownloadHistory } = require('../electron/download-history.cjs');
  const historyPath = path.join(root, 'history.json');
  const history = await createDownloadHistory(historyPath);
  const id = require('node:crypto').randomUUID();
  await history.start({ id, gameId: 'peak', profileId: 'peak-default', profileName: 'Default', label: 'Plugin' });
  history.plan(id, mods);
  const cache = createPackageCache(path.join(root, 'cache'), async () => new Response(archive));
  const result = await cache.downloadPackage({ ...packageId, gameId: 'peak' }, event =>
    history.progress(id, 'peak/Test-team/Plugin@1.2.3', event));
  await history.ready(id);
  await history.complete(id);
  assert.deepEqual(await readFile(path.join(cache.root, 'peak', result.filename)), archive);
  const saved = (await createDownloadHistory(historyPath)).list()[0];
  assert.equal(saved.gameId, 'peak');
  assert.equal(saved.status, 'complete');
});

