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

async function fixture(t, { gameId = game, root: sharedRoot, loaderKind = 'bepinex' } = {}) {
  const root = sharedRoot ?? await temporaryDirectory(t);
  const cache = { root: path.join(root, 'cache') };
  const gameCache = path.join(cache.root, gameId);
  const selectedLoader = loaderKind === 'melonloader'
    ? { namespace: 'LavaGang', name: 'MelonLoader', version: '0.7.3' }
    : { ...loader, name: gameId === 'peak' ? 'BepInExPack_PEAK' : loader.name };
  const requests = [];
  const archives = new Map();
  let archiveNumber = 0;
  const addPackage = async (ref, entries) => {
    const key = [ref.namespace, ref.name, ref.version].join('/');
    const filename = 'archive-' + archiveNumber++ + '.zip';
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
  await addPackage(selectedLoader, loaderKind === 'melonloader' ? [
    { name: 'version.dll', content: 'melon proxy' },
    { name: 'MelonLoader/net35/MelonLoader.dll', content: 'mono loader' },
    { name: 'MelonLoader/net6/MelonLoader.dll', content: 'il2cpp loader' },
    { name: 'MelonLoader/Dependencies/runtime.json', content: '{}' },
  ] : [
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

test('imported configuration templates apply initially and preserve user edits across rebuilds', async t => {
  const { builder, requests } = await fixture(t);
  const imported = { 'example.cfg': 'imported overrides bundled defaults', 'crew/settings.json': '{"crew":"café ☕"}' };
  const runtime = await builder.prepareProfile(profileId, [loader, plugin], imported);
  const configPath = path.join(runtime, 'BepInEx', 'config');
  assert.equal(await readFile(path.join(configPath, 'example.cfg'), 'utf8'), imported['example.cfg']);
  assert.equal(await readFile(path.join(configPath, 'crew/settings.json'), 'utf8'), imported['crew/settings.json']);
  const firstDownloads = requests.length;
  await builder.prepareProfile(profileId, [loader, plugin], imported);
  assert.equal(requests.length, firstDownloads, 'Unchanged imports reuse the runtime.');
  await writeFile(path.join(configPath, 'example.cfg'), 'edited after importing');
  await builder.prepareProfile(profileId, [loader, plugin], { ...imported, 'new.cfg': 'newly imported' });
  assert(requests.length > firstDownloads, 'Changed templates invalidate the prepared-runtime key.');
  assert.equal(await readFile(path.join(configPath, 'example.cfg'), 'utf8'), 'edited after importing');
  assert.equal(await readFile(path.join(configPath, 'new.cfg'), 'utf8'), 'newly imported');
  await builder.prepareProfile(profileId, [loader], imported);
  assert.equal(await readFile(path.join(configPath, 'example.cfg'), 'utf8'), 'edited after importing');
});

test('unsafe imports and configuration staging failures preserve the prior prepared profile', async t => {
  const { builder, addPackage, requests } = await fixture(t);
  const runtime = await builder.prepareProfile(profileId, [loader, plugin]);
  const before = requests.length;
  await assert.rejects(() => builder.prepareProfile(profileId, [loader, plugin], { '../escape.cfg': 'unsafe' }), /configuration path/);
  assert.equal(requests.length, before, 'Invalid configuration is rejected before package work.');
  const conflict = { ...plugin, name: 'DirectoryConflict' };
  await addPackage(conflict, [{ name: 'config/collision.cfg/inside.cfg', content: 'bundled' }]);
  await assert.rejects(() => builder.prepareProfile(profileId, [loader, conflict], { 'collision.cfg': 'file' }));
  assert.equal(await readFile(path.join(runtime, 'BepInEx/config/example.cfg'), 'utf8'), 'bundled defaults');
  assert.deepEqual(await readdir(path.dirname(runtime)), ['runtime']);
});

test('shared BepInEx core libraries retain their package layout alongside the approved loader', async t => {
  const { builder, addPackage } = await fixture(t);
  const library = { namespace: 'Lordfirespeed', name: 'OdinSerializer', version: '2024.2.2700' };
  await addPackage(library, [
    { name: 'BepInEx/core/OdinSerializer/OdinSerializer.dll', content: 'serializer assembly' },
    { name: 'BepInEx/core/OdinSerializer/OdinSerializer.pdb', content: 'debugging symbols' },
    { name: 'manifest.json', content: 'package metadata' },
  ]);
  const runtime = await builder.prepareProfile(profileId, [plugin, library, loader]);
  assert.equal(await readFile(path.join(runtime, 'BepInEx/core/OdinSerializer/OdinSerializer.dll'), 'utf8'), 'serializer assembly');
  assert.equal(await readFile(path.join(runtime, 'BepInEx/core/OdinSerializer/OdinSerializer.pdb'), 'utf8'), 'debugging symbols');
  assert.equal(await readFile(path.join(runtime, 'BepInEx/core/BepInEx.Preloader.dll'), 'utf8'), 'preloader');
  assert.equal(await readFile(path.join(runtime, 'winhttp.dll'), 'utf8'), 'doorstop');
  const coreFiles = await readdir(path.join(runtime, 'BepInEx/core'), { recursive: true });
  assert(!coreFiles.some(name => path.basename(name) === 'manifest.json'));
});

test('shared core libraries cannot replace loader files or another package and failures keep the current runtime', async t => {
  const { builder, addPackage } = await fixture(t);
  const runtime = await builder.prepareProfile(profileId, [loader, plugin]);
  const collisions = [
    ['CoreCollision', 'BepInEx/core/BepInEx.Preloader.dll'],
    ['ProxyCollision', 'winhttp.dll'],
    ['DoorstopCollision', 'doorstop_config.ini'],
    ['UnsupportedLayout', 'BepInEx/unsupported/file.dll'],
  ];
  for (const [name, entry] of collisions) {
    const ref = { namespace: 'Tests', name, version: '1.0.0' };
    await addPackage(ref, [{ name: entry, content: 'replacement' }]);
    await assert.rejects(() => builder.prepareProfile(profileId, [loader, plugin, ref]), /same file|layout Ember cannot deploy/);
    assert.equal(await readFile(path.join(runtime, 'BepInEx/core/BepInEx.Preloader.dll'), 'utf8'), 'preloader');
    assert.equal(await readFile(path.join(runtime, 'winhttp.dll'), 'utf8'), 'doorstop');
    assert.equal(await readFile(path.join(runtime, 'BepInEx/config/example.cfg'), 'utf8'), 'bundled defaults');
    assert.deepEqual(await readdir(path.dirname(runtime)), ['runtime']);
  }
});

test('a shared core package cannot fill missing files in an incomplete loader', async t => {
  const { builder, addPackage, requests } = await fixture(t);
  const supplemental = { namespace: 'Tests', name: 'Supplement', version: '1.0.0' };
  await addPackage(supplemental, [{ name: 'BepInEx/core/BepInEx.Preloader.dll', content: 'not from loader' }]);
  await addPackage(loader, [
    { name: 'BepInExPack/winhttp.dll', content: 'doorstop' },
    { name: 'BepInExPack/doorstop_config.ini', content: 'enabled = true' },
  ]);
  await assert.rejects(() => builder.prepareProfile(profileId, [loader, supplemental]), /BepInExPack is missing/);
  assert.deepEqual(requests, ['BepInEx/BepInExPack/5.4.2305']);
});

test('BepInEx override folders and MonoMod assemblies retain the correct destinations through package wrappers', async t => {
  const { builder, addPackage } = await fixture(t);
  const ref = { namespace: 'Tests', name: 'Overrides', version: '1.0.0' };
  await addPackage(ref, [
    { name: 'Outer/Overrides/core/Shared/helper.dll', content: 'shared' },
    { name: 'Outer/Overrides/monomod/Explicit.mm.dll', content: 'explicit patch' },
    { name: 'Outer/Overrides/Patches/Implicit.mm.dll', content: 'implicit patch' },
    { name: 'Outer/Overrides/patchers/Preloader.dll', content: 'patcher' },
    { name: 'Outer/Overrides/plugins/Plugin.dll', content: 'plugin' },
    { name: 'Outer/Overrides/plugins/assets/nested/image.png', content: 'resource' },
    { name: 'Outer/Overrides/config/settings.cfg', content: 'setting = true' },
    { name: 'Outer/Overrides/README.md', content: 'metadata' },
  ]);
  const runtime = await builder.prepareProfile(profileId, [loader, ref]);
  assert.equal(await readFile(path.join(runtime, 'BepInEx/core/Shared/helper.dll'), 'utf8'), 'shared');
  assert.equal(await readFile(path.join(runtime, 'BepInEx/config/settings.cfg'), 'utf8'), 'setting = true');
  const folders = await readdir(path.join(runtime, 'BepInEx/plugins'));
  assert.equal(folders.length, 1);
  const directory = folders[0];
  assert.equal(await readFile(path.join(runtime, `BepInEx/plugins/${directory}/assets/nested/image.png`), 'utf8'), 'resource');
  assert.equal(await readFile(path.join(runtime, `BepInEx/monomod/${directory}/Explicit.mm.dll`), 'utf8'), 'explicit patch');
  assert.equal(await readFile(path.join(runtime, `BepInEx/monomod/${directory}/Patches/Implicit.mm.dll`), 'utf8'), 'implicit patch');
  assert.equal(await readFile(path.join(runtime, `BepInEx/patchers/${directory}/Preloader.dll`), 'utf8'), 'patcher');
  assert(!(await readdir(path.join(runtime, 'BepInEx'), { recursive: true })).some(name => name.includes('Outer') || name.endsWith('README.md')));
});

test('explicit root and game data files stage separately while game-root BepInEx paths stay in the profile', async t => {
  const { builder, addPackage } = await fixture(t);
  const ref = { namespace: 'Tests', name: 'RootAssets', version: '1.0.0' };
  await addPackage(ref, [
    { name: 'Root/custom-assets/texture.bundle', content: 'root asset' },
    { name: 'Lethal Company_Data/StreamingAssets/world.bundle', content: 'data asset' },
    { name: 'Lethal Company/game-settings.ini', content: 'root settings' },
    { name: 'Root/BepInEx/plugins/Example.dll', content: 'plugin' },
  ]);
  const runtime = await builder.prepareProfile(profileId, [loader, ref]);
  assert.equal(await readFile(path.join(runtime, '.ember-game-files/custom-assets/texture.bundle'), 'utf8'), 'root asset');
  assert.equal(await readFile(path.join(runtime, '.ember-game-files/Lethal Company_Data/StreamingAssets/world.bundle'), 'utf8'), 'data asset');
  assert.equal(await readFile(path.join(runtime, '.ember-game-files/game-settings.ini'), 'utf8'), 'root settings');
  assert.equal((await readdir(path.join(runtime, 'BepInEx/plugins'), { recursive: true })).filter(name => name.endsWith('Example.dll')).length, 1);
  assert.equal(await readFile(path.join(runtime, '.ember-loader.json'), 'utf8'), JSON.stringify({ kind: 'bepinex', name: 'BepInExPack', version: loader.version }));
});

test('ambiguous loader wrappers, foreign loaders, proxy replacements and other-game data fail without replacing the runtime', async t => {
  const { builder, addPackage } = await fixture(t);
  const runtime = await builder.prepareProfile(profileId, [loader, plugin]);
  const entries = [
    [{ name: 'Wrapped/BepInEx/core/helper.dll', content: 'helper' }, { name: 'other.dll', content: 'ambiguous sibling' }],
    [{ name: 'Wrapped/UE4SS/UE4SS.dll', content: 'foreign loader' }],
    [{ name: 'MelonLoader/net6/MelonLoader.dll', content: 'other loader' }],
    [{ name: 'Root/version.dll', content: 'proxy replacement' }],
    [{ name: 'Root/Lethal Company.exe', content: 'executable replacement' }],
    [{ name: 'Root/install.ps1', content: 'installer' }],
    [{ name: 'PEAK_Data/StreamingAssets/test.bundle', content: 'other game' }],
  ];
  for (const [index, files] of entries.entries()) {
    const ref = { namespace: 'Tests', name: `Unsupported${index}`, version: '1.0.0' };
    await addPackage(ref, files);
    await assert.rejects(() => builder.prepareProfile(profileId, [loader, ref]), /game layout Ember cannot deploy/);
    assert.equal(await readFile(path.join(runtime, 'BepInEx/core/BepInEx.Preloader.dll'), 'utf8'), 'preloader');
    assert.deepEqual(await readdir(path.dirname(runtime)), ['runtime']);
  }
});

test('MIMESIS stages recursive MelonLoader mods, resources and UserData with isolated profile settings', async t => {
  const { builder, loader: melon, addPackage, requests } = await fixture(t, { gameId: 'mimesis', loaderKind: 'melonloader' });
  await addPackage(plugin, [
    { name: 'Mods/Main.dll', content: 'mod' },
    { name: 'Plugins/Startup.dll', content: 'plugin' },
    { name: 'UserLibs/Helper.dll', content: 'library' },
    { name: 'UserData/preferences.cfg', content: 'bundled settings' },
    { name: 'assets/nested/image.png', content: 'asset' },
    { name: 'readme.md', content: 'metadata' },
  ]);
  const imported = { 'MelonPreferences.cfg': 'global preference', 'crew/settings.json': '{"crew":"café"}', [`${plugin.namespace}-${plugin.name}/preferences.cfg`]: 'imported mod settings' };
  const runtime = await builder.prepareProfile('mimesis-default', [plugin, melon], {}, imported);
  assert.equal(await readFile(path.join(runtime, 'version.dll'), 'utf8'), 'melon proxy');
  assert.equal(await readFile(path.join(runtime, 'MelonLoader/net35/MelonLoader.dll'), 'utf8'), 'mono loader');
  assert.equal(await readFile(path.join(runtime, 'MelonLoader/net6/MelonLoader.dll'), 'utf8'), 'il2cpp loader');
  const [directory] = await readdir(path.join(runtime, 'Mods'));
  assert.equal(await readFile(path.join(runtime, `Mods/${directory}/Mods/Main.dll`), 'utf8'), 'mod');
  assert.equal(await readFile(path.join(runtime, `Mods/${directory}/Plugins/Startup.dll`), 'utf8'), 'plugin');
  assert.equal(await readFile(path.join(runtime, `Mods/${directory}/UserLibs/Helper.dll`), 'utf8'), 'library');
  assert.equal(await readFile(path.join(runtime, `Mods/${directory}/assets/nested/image.png`), 'utf8'), 'asset');
  assert.equal(directory, `${plugin.namespace}-${plugin.name}`, 'Package folders match native profile exports.');
  assert.equal(await readFile(path.join(runtime, `UserData/${directory}/preferences.cfg`), 'utf8'), 'imported mod settings');
  assert.equal(await readFile(path.join(runtime, 'UserData/MelonPreferences.cfg'), 'utf8'), imported['MelonPreferences.cfg']);
  const before = requests.length;
  await builder.prepareProfile('mimesis-default', [melon, plugin], {}, imported);
  assert.equal(requests.length, before);
  await writeFile(path.join(runtime, 'UserData/MelonPreferences.cfg'), 'user edit');
  await builder.prepareProfile('mimesis-default', [melon], {}, { ...imported, 'new.cfg': 'new template' });
  assert.equal(await readFile(path.join(runtime, 'UserData/MelonPreferences.cfg'), 'utf8'), 'user edit');
  assert.equal(await readFile(path.join(runtime, 'UserData/new.cfg'), 'utf8'), 'new template');
  assert.equal((await readdir(runtime)).includes('Mods'), false);
  assert.equal(await builder.openProfilePath('mimesis-default'), runtime);
});

test('MelonLoader packages must be complete and cannot be supplemented or mixed with BepInEx', async t => {
  const { builder, loader: melon, addPackage } = await fixture(t, { gameId: 'mimesis', loaderKind: 'melonloader' });
  await assert.rejects(() => builder.prepareProfile('mimesis-default', [melon, loader]), /cannot run in the same profile/);
  await assert.rejects(() => builder.prepareProfile('mimesis-default', [{ ...melon, version: '0.6.6' }]), /0.7.0 or newer/);
  await addPackage(melon, [
    { name: 'version.dll', content: 'proxy' },
    { name: 'MelonLoader/net35/MelonLoader.dll', content: 'incomplete loader' },
  ]);
  await addPackage(plugin, [{ name: 'MelonLoader/net6/MelonLoader.dll', content: 'supplemental loader' }]);
  await assert.rejects(() => builder.prepareProfile('mimesis-default', [melon, plugin]), /MelonLoader is missing its Windows loader files/);
});

test('MelonLoader accepts either supported proxy but rejects dual proxies and foreign plugin layouts', async t => {
  const { builder, loader: melon, addPackage } = await fixture(t, { gameId: 'mimesis', loaderKind: 'melonloader' });
  const melonFiles = [
    { name: 'winhttp.dll', content: 'modern proxy' },
    { name: 'MelonLoader/net35/MelonLoader.dll', content: 'mono loader' },
    { name: 'MelonLoader/net6/MelonLoader.dll', content: 'il2cpp loader' },
  ];
  await addPackage(melon, melonFiles);
  const runtime = await builder.prepareProfile('mimesis-default', [melon]);
  assert.equal(await readFile(path.join(runtime, 'winhttp.dll'), 'utf8'), 'modern proxy');
  for (const name of ['BepInEx/plugins/Other.dll', 'Hooks.mm.dll', 'UE4SS/UE4SS.dll']) {
    await addPackage(plugin, [{ name, content: 'wrong loader' }]);
    await assert.rejects(() => builder.prepareProfile('mimesis-default', [melon, plugin]), /game layout Ember cannot deploy/);
    assert.equal(await readFile(path.join(runtime, 'winhttp.dll'), 'utf8'), 'modern proxy');
  }
  const newer = { ...melon, version: '0.7.4' };
  await addPackage(newer, [...melonFiles, { name: 'version.dll', content: 'second proxy' }]);
  await assert.rejects(() => builder.prepareProfile('mimesis-default', [newer]), /missing its Windows loader files/);
  assert.equal(await readFile(path.join(runtime, 'winhttp.dll'), 'utf8'), 'modern proxy');
});

