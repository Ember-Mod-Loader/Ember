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

async function fixture(t, { gameId = game, root: sharedRoot } = {}) {
  const root = sharedRoot ?? await temporaryDirectory(t);
  const cache = { root: path.join(root, 'cache') };
  const gameCache = path.join(cache.root, gameId);
  const selectedLoader = { ...loader, name: gameId === 'peak' ? 'BepInExPack_PEAK' : loader.name };
  const requests = [];
  const archives = new Map();
  const addPackage = async (ref, entries) => {
    const key = [ref.namespace, ref.name, ref.version].join('/');
    const filename = 'archive-' + archives.size + '.zip';
    await writeFile(path.join(gameCache, filename), zipFixture(entries));
    archives.set(key, filename);
  };
  cache.downloadPackage = async ({ gameId: requestedGame, namespace, name, version }) => {
    const key = [namespace, name, version].join('/');
    requests.push(key);
    assert.equal(requestedGame, gameId);
    const filename = archives.get(key);
    assert.ok(filename, 'requested package is present in offline fixture');
    return { filename };
  };
  await mkdir(gameCache, { recursive: true });
  await addPackage(selectedLoader, [
    { name: `${selectedLoader.name}/BepInEx/core/BepInEx.Preloader.dll`, content: 'preloader' },
    { name: `${selectedLoader.name}/winhttp.dll`, content: 'doorstop' },
    { name: `${selectedLoader.name}/doorstop_config.ini`, content: 'loader config' },
    { name: `${selectedLoader.name}/BepInEx/config/BepInEx.cfg`, content: `HideManagerGameObject = ${gameId === 'peak'}` },
  ]);
  await addPackage(plugin, [
    { name: 'BepInEx/plugins/Example.dll', content: 'plugin' },
    { name: 'config/example.cfg', content: 'bundled defaults' },
    { name: 'README.md', content: 'package metadata' },
  ]);
  return {
    builder: createProfileBuilder(path.join(root, 'profiles'), cache, { gameId }),
    loader: selectedLoader,
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

test('R.E.P.O. and PEAK stage the same profile ID into isolated game runtimes and preserve their configs', async t => {
  const root = await temporaryDirectory(t);
  const repo = await fixture(t, { root, gameId: 'repo' });
  const peak = await fixture(t, { root, gameId: 'peak' });
  const sharedId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const repoRuntime = await repo.builder.prepareProfile(sharedId, [repo.loader, plugin]);
  const peakRuntime = await peak.builder.prepareProfile(sharedId, [peak.loader, plugin]);
  assert.equal(repoRuntime, path.join(root, 'profiles', 'repo', sharedId, 'runtime'));
  assert.equal(peakRuntime, path.join(root, 'profiles', 'peak', sharedId, 'runtime'));
  await writeFile(path.join(repoRuntime, 'BepInEx', 'config', 'example.cfg'), 'repo settings');
  await writeFile(path.join(peakRuntime, 'BepInEx', 'config', 'example.cfg'), 'peak settings');
  await repo.builder.prepareProfile(sharedId, [repo.loader]);
  await peak.builder.prepareProfile(sharedId, [peak.loader]);
  assert.equal(await readFile(path.join(repoRuntime, 'BepInEx', 'config', 'example.cfg'), 'utf8'), 'repo settings');
  assert.equal(await readFile(path.join(peakRuntime, 'BepInEx', 'config', 'example.cfg'), 'utf8'), 'peak settings');
  assert.equal(await readFile(path.join(peakRuntime, 'BepInEx', 'config', 'BepInEx.cfg'), 'utf8'), 'HideManagerGameObject = true');
  assert.equal(await repo.builder.openProfilePath(sharedId), repoRuntime);
  assert.equal(await peak.builder.openProfilePath(sharedId), peakRuntime);
});

test('PEAK uses its official pack without generic loader assets overwriting it', async t => {
  const peak = await fixture(t, { gameId: 'peak' });
  await peak.addPackage(loader, [{ name: 'BepInExPack/BepInEx/config/BepInEx.cfg', content: 'HideManagerGameObject = false' }]);
  const runtime = await peak.builder.prepareProfile('peak-default', [peak.loader, loader]);
  assert.equal(await readFile(path.join(runtime, 'BepInEx', 'config', 'BepInEx.cfg'), 'utf8'), 'HideManagerGameObject = true');
  assert.equal(peak.requests.includes([loader.namespace, loader.name, loader.version].join('/')), false);
  await assert.rejects(() => peak.builder.prepareProfile('peak-default', [loader]), /enable BepInExPack_PEAK/);
});

test('game profile defaults and cache roots cannot be crossed or selected through traversal', async t => {
  const repo = await fixture(t, { gameId: 'repo' });
  const peak = await fixture(t, { gameId: 'peak' });
  for (const [instance, id] of [[repo, 'peak-default'], [peak, 'repo-default'], [repo, '../peak']]) {
    await assert.rejects(() => instance.builder.prepareProfile(id, [instance.loader]), /valid .* profile/);
    assert.deepEqual(instance.requests, []);
  }
  assert.throws(() => createProfileBuilder('unused', {}, { gameId: '../repo' }), /supported game/);
});

