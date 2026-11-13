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

function archive(extra = [], refs = [loader, enabled, disabled]) {
  const mods = refs.map(ref => {
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

test('a large Thunderstore export preserves mods and settings through import, reload and share', async () => {
  const { createManager } = await import('../src/model.js');
  const refs = Array.from({ length: 331 }, (_, index) => ({ namespace: 'Team', name: `Plugin${index}`, version: '1.2.3' }));
  const config = 'Setting = value\n'.repeat(300);
  const files = Array.from({ length: 282 }, (_, index) => ({ name: `config/Plugin${index}.cfg`, content: config, deflate: true }));
  const extras = Array.from({ length: 764 }, (_, index) => ({ name: `config/backup${index}.bak`, content: 'backup' }));
  const payload = archive([...files, ...extras], refs);
  let shared;
  const client = createSharingClient({
    fetchImpl: async (_url, options) => {
      if (options.method !== 'POST') return new Response(shared ?? payload);
      shared = options.body;
      return Response.json({ key: code });
    },
    resolvePackage: (_game, ref) => packageFor(ref),
  });
  const saved = storage();
  const manager = createManager(saved, { live: true });
  const json = await client.resolveThunderstoreProfile(code, gameId);
  const expected = manager.readImport(json);
  assert.equal(expected.mods.length, refs.length);
  assert.equal(Object.keys(expected.configFiles).length, files.length + 1);
  assert.match(JSON.parse(json).importWarnings.at(-1), /more files from the export/);
  manager.importProfile(json, expected.mods.map(mod => mod.package));
  const reloaded = createManager(saved, { live: true });
  assert.deepEqual(reloaded.profile.configFiles, expected.configFiles);
  assert.equal(await client.publishProfile(reloaded.exportProfile().json, 'thunderstore'), code);
  const roundTrip = manager.readImport(await client.resolveThunderstoreProfile(code, gameId));
  assert.deepEqual(roundTrip.mods, expected.mods);
  assert.deepEqual(roundTrip.configFiles, expected.configFiles);
});

test('a native shared profile keeps exact versions, disabled mods, large settings and migration markers', async t => {
  const f = await fixture(t);
  const requests = [];
  const resolved = [];
  const markerName = 'Team.Plugin.migration.done';
  const marker = 'Migration complete\n';
  const largeName = 'LargePlugin.cfg';
  const largeConfig = '# Custom mod setting\n'.repeat(17000);
  const client = createSharingClient({ fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'manual');
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { Location: `https://ccdn.thunderstore.io/live/modpacks/legacyprofile/${code}` } })
      : new Response(archive([
        { name: 'config/' + markerName, content: marker },
        { name: 'config/' + largeName, content: largeConfig, deflate: true },
      ]));
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
  assert.equal(await readFile(path.join(prepared, 'BepInEx/config', markerName), 'utf8'), marker);
  assert.equal(await readFile(path.join(prepared, 'BepInEx/config', largeName), 'utf8'), largeConfig);
  assert.equal(await readFile(path.join(prepared, 'doorstop_config.ini'), 'utf8'), 'enabled = true', 'The selected loader package supplies its own configuration.');
  const files = await readdir(path.join(prepared, 'BepInEx/plugins'), { recursive: true });
  assert(files.some(file => path.basename(file) === 'Enabled.dll'));
  assert(files.some(file => path.basename(file) === 'Runtime.dll'));
  assert(!files.some(file => /(?:Disabled|OffRuntime)\.dll$/.test(file)));
  assert.deepEqual(f.downloads.map(ref => ref.name).sort(), ['BepInExPack', 'Enabled', 'Runtime']);
  const reloaded = f.createManager(f.saved, { live: true });
  assert.deepEqual(reloaded.profile.configFiles, { 'Nested/settings.cfg': configuration, [markerName]: marker, [largeName]: largeConfig });
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
