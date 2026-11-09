import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createModUpdateScanner } from '../src/mod-update-scanner.js';

const mod = name => ({ id: `peak/Example/${name}`, gameId: 'peak', namespace: 'Example', name });
const listing = (name, version = '1.0.0') => ({ ...mod(name), version, dependencies: [] });

test('update scans deduplicate packages and keep requests within the concurrency limit', async () => {
  const started = [];
  const finish = new Map();
  const scanner = createModUpdateScanner({
    concurrency: 2,
    fetchPackage: (gameId, namespace, name) => new Promise(resolve => {
      assert.equal(gameId, 'peak');
      assert.equal(namespace, 'Example');
      started.push(name);
      finish.set(name, () => resolve(listing(name)));
    }),
  });

  const scan = scanner.scan(['First', 'Second', 'First', 'Third', 'Fourth'].map(mod));
  assert.deepEqual(started, ['First', 'Second']);
  finish.get('Second')();
  await tick();
  assert.deepEqual(started, ['First', 'Second', 'Third']);
  finish.get('First')();
  await tick();
  assert.deepEqual(started, ['First', 'Second', 'Third', 'Fourth']);
  finish.get('Fourth')();
  finish.get('Third')();
  const packages = ['First', 'Second', 'Third', 'Fourth'].map(name => listing(name));
  assert.deepEqual(await scan, { packages, freshPackages: packages, failed: 0 });
});

test('recent successful results are reused until they expire or a manual scan requests a refresh', async () => {
  let clock = 0;
  let calls = 0;
  const scanner = createModUpdateScanner({
    now: () => clock,
    fetchPackage: async (_gameId, _namespace, name) => listing(name, `1.0.${++calls}`),
  });
  const entries = [mod('ExampleMod')];

  const initial = await scanner.scan(entries);
  assert.deepEqual(initial.freshPackages, initial.packages);
  clock = 299_999;
  assert.deepEqual(await scanner.scan(entries), { packages: initial.packages, freshPackages: [], failed: 0 });
  assert.equal(calls, 1);

  const refreshed = await scanner.scan(entries, { force: true });
  assert.equal(refreshed.packages[0].version, '1.0.2');
  assert.deepEqual(refreshed.freshPackages, refreshed.packages);
  assert.equal(calls, 2);
  assert.deepEqual(await scanner.scan(entries), { packages: refreshed.packages, freshPackages: [], failed: 0 });

  clock += 300_000;
  const expired = await scanner.scan(entries);
  assert.equal(expired.packages[0].version, '1.0.3');
  assert.deepEqual(expired.freshPackages, expired.packages);
  assert.equal(calls, 3);
});

test('partial failures do not hide valid updates or cache incorrect package responses', async () => {
  let recover = false;
  const calls = [];
  const scanner = createModUpdateScanner({
    fetchPackage: async (_gameId, _namespace, name) => {
      calls.push(name);
      if (!recover) {
        if (name === 'Offline') throw new Error('Thunderstore unavailable');
        if (name === 'WrongPackage') return listing('Other');
        if (name === 'WrongGame') return { ...listing(name), gameId: 'repo' };
        if (name === 'NoVersion') return listing(name, null);
      }
      return listing(name);
    },
  });
  const names = ['Working', 'Offline', 'WrongPackage', 'WrongGame', 'NoVersion'];
  const entries = names.map(mod);
  const working = [listing('Working')];
  assert.deepEqual(await scanner.scan(entries), { packages: working, freshPackages: working, failed: 4 });

  recover = true;
  calls.length = 0;
  assert.deepEqual(await scanner.scan(entries), {
    packages: names.map(name => listing(name)),
    freshPackages: names.slice(1).map(name => listing(name)),
    failed: 0,
  });
  assert.deepEqual(calls, names.slice(1));
});

test('leaving a profile stops queued lookups and discards replies received after abort', async () => {
  const started = [];
  const finish = new Map();
  const controller = new AbortController();
  let block = true;
  const scanner = createModUpdateScanner({
    concurrency: 2,
    fetchPackage: async (_gameId, _namespace, name) => {
      started.push(name);
      if (!block) return listing(name);
      return new Promise((resolve, reject) => {
        finish.set(name, { resolve: () => resolve(listing(name)), reject });
      });
    },
  });
  const entries = ['First', 'Second', 'Third', 'Queued'].map(mod);
  const scan = scanner.scan(entries, { signal: controller.signal });
  finish.get('First').resolve();
  await tick();
  assert.deepEqual(started, ['First', 'Second', 'Third']);

  controller.abort();
  finish.get('Second').reject(new Error('Offline'));
  finish.get('Third').resolve();
  const completed = [listing('First')];
  assert.deepEqual(await scan, { packages: completed, freshPackages: completed, failed: 0 });
  assert.deepEqual(started, ['First', 'Second', 'Third']);
  assert.deepEqual(await scanner.scan(entries, { signal: controller.signal }), {
    packages: [], freshPackages: [], failed: 0,
  });
  assert.deepEqual(started, ['First', 'Second', 'Third']);

  block = false;
  started.length = 0;
  await scanner.scan(entries);
  assert.deepEqual(started, ['Second', 'Third', 'Queued']);
});
