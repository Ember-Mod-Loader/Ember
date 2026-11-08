const assert = require('node:assert/strict');
const { mkdir, readFile, readdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { createSharingClient } = require('../electron/sharing.cjs');
const { createProfileBuilder } = require('../electron/profiles.cjs');
const { zipFixture } = require('./zip-fixture.cjs');
const { temporaryDirectory } = require('./temp-directory.cjs');

const code = '01a1ad5d-bee6-0706-b9fa-a899094432e0';
const gameId = 'repo';
const configuration = '[General]\r\nCrew = café ☕\r\nEnabled = false\r\n';
const loader = { namespace: 'BepInEx', name: 'BepInExPack', version: '5.4.2305' };
const enabled = { namespace: 'Test-team', name: 'Enabled', version: '1.2.3' };
const disabled = { namespace: 'Test-team', name: 'Disabled', version: '2.3.4' };
const runtime = { namespace: 'Test-team', name: 'Runtime', version: '2.0.0' };
const offRuntime = { namespace: 'Test-team', name: 'OffRuntime', version: '1.0.0' };

function archive(extra = []) {
  const mods = [loader, enabled, disabled].map(ref => {
    const [major, minor, patch] = ref.version.split('.').map(Number);
    return { name: `${ref.namespace}-${ref.name}`, version: { major, minor, patch }, enabled: ref !== disabled };
  });
  return '#r2modman\n' + zipFixture([
    { name: 'export.r2x', content: yaml.dump({ profileName: 'Imported crew', mods }), deflate: true },
    { name: 'config/Nested/settings.cfg', content: configuration, deflate: true },
    { name: 'doorstop_config.ini', content: '[General]\ntarget_assembly=C:\\OtherManager\\BepInEx.Preloader.dll' },
    ...extra,
  ]).toString('base64');
}

function packageFor(ref, selectedGame = gameId) {
  const dependencies = ref.name === enabled.name ? [runtime] : ref.name === disabled.name ? [offRuntime] : [];
  return { ...ref, gameId: selectedGame, id: `${selectedGame}/${ref.namespace}/${ref.name}`,
    dependencies: dependencies.map(dep => ({ ...dep, id: `${selectedGame}/${dep.namespace}/${dep.name}` })), description: 'Integration fixture', categories: [] };
}

function storage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}

async function fixture(t) {
  const root = await temporaryDirectory(t);
  const cache = { root: path.join(root, 'cache') };
  const cachePath = path.join(cache.root, gameId);
  await mkdir(cachePath, { recursive: true });
  const packages = [loader, enabled, disabled, runtime, offRuntime];
  const downloads = [];
  for (const ref of packages) {
    const files = ref === loader ? [
      { name: 'BepInExPack/BepInEx/core/BepInEx.Preloader.dll', content: 'preloader' },
      { name: 'BepInExPack/winhttp.dll', content: 'loader' },
      { name: 'BepInExPack/doorstop_config.ini', content: 'enabled = true' },
    ] : [{ name: `BepInEx/plugins/${ref.name}.dll`, content: `fixture-${ref.name}` }];
    await writeFile(path.join(cachePath, `${ref.name}.zip`), zipFixture(files));
  }
  cache.downloadPackage = async input => {
    const ref = packages.find(item => item.namespace === input.namespace && item.name === input.name && item.version === input.version);
    assert(ref, 'Runtime preparation uses only the exact fixture package versions.');
    assert.equal(input.gameId, gameId);
    downloads.push(input);
    return { filename: `${ref.name}.zip` };
  };
  const { createManager } = await import('../src/model.js');
  const saved = storage();
  const manager = createManager(saved, { live: true });
  return { root, manager, saved, createManager, downloads, builder: createProfileBuilder(path.join(root, 'profiles'), cache, { gameId }) };
}

async function importProfile(client, manager) {
  const json = await client.resolveThunderstoreProfile(code, gameId);
  const parsed = manager.readImport(json);
  assert.deepEqual(JSON.parse(json).importWarnings, [], 'Manager-owned Doorstop configuration must not cause an unsupported-file review.');
  return manager.importProfile(json, parsed.mods.map(entry => entry.package));
}

test('a native shared profile becomes an Ember profile with exact versions, disabled mods, and working runtime configuration', async t => {
  const f = await fixture(t);
  const requests = [];
  const resolved = [];
  const client = createSharingClient({ fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'manual');
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { Location: `https://ccdn.thunderstore.io/live/modpacks/legacyprofile/${code}` } })
      : new Response(archive());
  }, resolvePackage: async (selectedGame, ref) => {
    assert.equal(selectedGame, gameId);
    resolved.push(ref);
    return packageFor(ref);
  } });
  const imported = await importProfile(client, f.manager);
  assert.equal(f.manager.game.id, gameId);
  assert.equal(f.manager.profile.id, imported.id);
  assert.equal(requests.length, 2);
  assert.deepEqual(resolved.map(ref => `${ref.name}@${ref.version}`).sort(),
    ['BepInExPack@5.4.2305', 'Disabled@2.3.4', 'Enabled@1.2.3', 'OffRuntime@1.0.0', 'Runtime@2.0.0']);
  const states = new Map(imported.mods.map(entry => [entry.package.name, entry.enabled]));
  assert.equal(states.get('Enabled'), true);
  assert.equal(states.get('Runtime'), true, 'An inferred dependency follows its enabled parent.');
  assert.equal(states.get('Disabled'), false, 'The explicit disabled choice is retained.');
  assert.equal(states.get('OffRuntime'), false, 'A disabled parent does not enable its inferred dependencies.');
  const active = imported.mods.filter(entry => entry.enabled).map(entry => entry.package);
  const prepared = await f.builder.prepareProfile(imported.id, active, imported.configFiles);
  assert.equal(await readFile(path.join(prepared, 'BepInEx/config/Nested/settings.cfg'), 'utf8'), configuration);
  assert.equal(await readFile(path.join(prepared, 'doorstop_config.ini'), 'utf8'), 'enabled = true', 'The selected loader package supplies its own configuration.');
  const files = await readdir(path.join(prepared, 'BepInEx/plugins'), { recursive: true });
  assert(files.some(file => path.basename(file) === 'Enabled.dll'));
  assert(files.some(file => path.basename(file) === 'Runtime.dll'));
  assert(!files.some(file => /(?:Disabled|OffRuntime)\.dll$/.test(file)));
  assert.deepEqual(f.downloads.map(ref => ref.name).sort(), ['BepInExPack', 'Enabled', 'Runtime']);
  const reloaded = f.createManager(f.saved, { live: true });
  assert.deepEqual(reloaded.profile.configFiles, { 'Nested/settings.cfg': configuration });
  assert.deepEqual(reloaded.readImport(reloaded.exportProfile().code).configFiles, imported.configFiles);
  assert.deepEqual(reloaded.profile.mods.map(entry => [entry.package.name, entry.version, entry.enabled]),
    imported.mods.map(entry => [entry.package.name, entry.version, entry.enabled]));
});

test('failed native fetch, unsafe archive, wrong-game metadata, and resolution failures leave an existing profile and runtime intact', async t => {
  const f = await fixture(t);
  const valid = createSharingClient({ fetchImpl: async () => new Response(archive()), resolvePackage: async (_game, ref) => packageFor(ref) });
  const imported = await importProfile(valid, f.manager);
  const prepared = await f.builder.prepareProfile(imported.id, imported.mods.filter(entry => entry.enabled).map(entry => entry.package), imported.configFiles);
  const beforeState = JSON.stringify(f.manager.state);
  const beforeDownloads = f.downloads.length;
  const failures = [
    { client: createSharingClient({ fetchImpl: async () => new Response(null, { status: 503 }) }), pattern: /HTTP 503/ },
    { client: createSharingClient({ fetchImpl: async () => new Response(archive([{ name: '../escape.cfg', content: 'unsafe' }])),
      resolvePackage: async () => assert.fail('Unsafe archive must fail before package resolution.') }), pattern: /(?:unsafe Windows|invalid relative) path/ },
    { client: createSharingClient({ fetchImpl: async () => new Response(archive()), resolvePackage: async (_game, ref) => packageFor(ref, 'peak') }), pattern: /selected game/ },
    { client: createSharingClient({ fetchImpl: async () => new Response(archive()), resolvePackage: async () => { throw new Error('Exact package version is unavailable.'); } }), pattern: /version is unavailable/ },
  ];
  for (const { client, pattern } of failures) {
    await assert.rejects(() => importProfile(client, f.manager), pattern);
    assert.equal(JSON.stringify(f.manager.state), beforeState);
    assert.equal(f.downloads.length, beforeDownloads);
    assert.equal(await readFile(path.join(prepared, 'BepInEx/config/Nested/settings.cfg'), 'utf8'), configuration);
    assert.equal(await f.builder.openProfilePath(imported.id), prepared);
    assert.deepEqual(await readdir(path.dirname(prepared)), ['runtime']);
  }
});
