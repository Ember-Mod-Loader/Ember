const assert = require('node:assert/strict');
const { mkdir, readdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createProfileBuilder } = require('../electron/profiles.cjs');
const { temporaryDirectory } = require('./temp-directory.cjs');
const { zipFixture } = require('./zip-fixture.cjs');

const game = 'lethal-company';
const profileId = 'lethal-company-default';
const loader = { namespace: 'BepInEx', name: 'BepInExPack', version: '5.4.2305' };
const plugin = { namespace: 'Test-team', name: 'Plugin', version: '1.0.0' };

async function fixture(t) {
  const root = await temporaryDirectory(t);
  const cache = { root: path.join(root, 'cache') };
  const gameCache = path.join(cache.root, game);
  const requests = [];
  const archives = new Map();
  const addPackage = async (ref, entries) => {
    const key = [ref.namespace, ref.name, ref.version].join('/');
    const filename = 'archive-' + archives.size + '.zip';
    await writeFile(path.join(gameCache, filename), zipFixture(entries));
    archives.set(key, filename);
  };
  cache.downloadPackage = async ({ gameId, namespace, name, version }) => {
    const key = [namespace, name, version].join('/');
    requests.push(key);
    assert.equal(gameId, game);
    const filename = archives.get(key);
    assert.ok(filename, 'requested package is present in offline fixture');
    return { filename };
  };
  await mkdir(gameCache, { recursive: true });
  await addPackage(loader, [
    { name: 'BepInExPack/BepInEx/core/BepInEx.Preloader.dll', content: 'preloader' },
    { name: 'BepInExPack/winhttp.dll', content: 'doorstop' },
    { name: 'BepInExPack/doorstop_config.ini', content: 'loader config' },
  ]);
  await addPackage(plugin, [
    { name: 'BepInEx/plugins/Example.dll', content: 'plugin' },
    { name: 'config/example.cfg', content: 'bundled defaults' },
    { name: 'README.md', content: 'package metadata' },
  ]);
  return {
    builder: createProfileBuilder(path.join(root, 'profiles'), cache),
    addPackage,
    requests,
  };
}

test('profile staging isolates plugins, reuses prepared runtimes, and keeps configuration on rebuild', async t => {
  const { builder, requests } = await fixture(t);
  const runtime = await builder.prepareProfile(profileId, [plugin, loader]);
  const config = path.join(runtime, 'BepInEx', 'config', 'example.cfg');

  assert.equal(await readFile(path.join(runtime, 'winhttp.dll'), 'utf8'), 'doorstop');
  assert.equal(await readFile(path.join(runtime, 'BepInEx', 'core', 'BepInEx.Preloader.dll'), 'utf8'), 'preloader');
  assert.equal(await readFile(config, 'utf8'), 'bundled defaults');
  const pluginFiles = await readdir(path.join(runtime, 'BepInEx', 'plugins'), { recursive: true });
  assert.equal(pluginFiles.filter(name => path.basename(name) === 'Example.dll').length, 1);
  assert.equal(pluginFiles.some(name => path.basename(name) === 'README.md'), false);

  assert.equal(await builder.openProfilePath(profileId), runtime);
  assert.equal(await builder.prepareProfile(profileId, [loader, plugin]), runtime);
  assert.equal(requests.length, 2);

  await writeFile(config, 'user edited');
  assert.equal(await builder.prepareProfile(profileId, [loader]), runtime);
  assert.equal(await readFile(config, 'utf8'), 'user edited');
  await assert.rejects(() => readdir(path.join(runtime, 'BepInEx', 'plugins')), { code: 'ENOENT' });
});

test('invalid or conflicting archives leave the prior prepared runtime intact', async t => {
  const { builder, addPackage } = await fixture(t);
  const runtime = await builder.prepareProfile(profileId, [loader, plugin]);
  const config = path.join(runtime, 'BepInEx', 'config', 'example.cfg');
  await writeFile(config, 'user edited');
  const unsafe = { ...plugin, name: 'Unsafe' };
  const conflicting = { ...plugin, name: 'Conflict' };
  await addPackage(unsafe, [{ name: '../escape.dll', content: 'unsafe' }]);
  await addPackage(conflicting, [{ name: 'config/example.cfg', content: 'conflicting' }]);

  await assert.rejects(() => builder.prepareProfile(profileId, [loader, unsafe]), /Could not deploy Unsafe/);
  await assert.rejects(() => builder.prepareProfile(profileId, [loader, plugin, conflicting]), /Another package supplies the same file/);
  assert.equal(await builder.openProfilePath(profileId), runtime);
  assert.equal(await readFile(config, 'utf8'), 'user edited');
  assert.deepEqual(await readdir(path.dirname(runtime)), ['runtime']);
});

test('profile staging requires the approved loader and rejects path-like profile IDs', async t => {
  const { builder, requests } = await fixture(t);
  await assert.rejects(() => builder.prepareProfile(profileId, [plugin]), /enable BepInExPack/);
  await assert.rejects(() => builder.prepareProfile('../elsewhere', [loader]), /valid Lethal Company profile/);
  assert.deepEqual(requests, []);
});

