const assert = require('node:assert/strict');
const test = require('node:test');
const yaml = require('js-yaml');
const { crc32 } = require('node:zlib');
const { zipFixture } = require('./zip-fixture.cjs');
const { parseThunderstoreProfile, MAX_ARCHIVE_BYTES } = require('../electron/thunderstore-profile.cjs');

const gameId = 'lethal-company';
const manifest = { profileName: 'Café friends', mods: [
  { name: 'Team-With-Hyphens-Plugin', version: { major: 1, minor: 2, patch: 3 }, enabled: false },
  { name: 'Team-Runtime', version: { major: 2, minor: 0, patch: 0 } },
] };
const encode = data => '#r2modman\n' + data.toString('base64');
const archive = (files = [], value = manifest, options) => encode(zipFixture([{ name: 'export.r2x', content: yaml.dump(value), deflate: true }, ...files], options));

test('official export.r2x schema preserves exact versions, disabled flags, Unicode, and configuration text', async () => {
  const result = await parseThunderstoreProfile(archive([
    { name: 'config/', mode: 0o040755 },
    { name: 'config/Nested/settings.cfg', content: '[General]\nValue = café ☕', deflate: true },
    { name: 'BepInEx/config/other.json', content: '{"value":true}' },
  ]), gameId);
  assert.equal(result.name, 'Café friends');
  assert.deepEqual(result.mods, [
    { namespace: 'Team-With-Hyphens', name: 'Plugin', version: '1.2.3', enabled: false },
    { namespace: 'Team', name: 'Runtime', version: '2.0.0', enabled: true },
  ]);
  assert.deepEqual(result.configFiles, { 'Nested/settings.cfg': '[General]\nValue = café ☕', 'other.json': '{"value":true}' });
  assert.deepEqual(result.importWarnings, []);
});

test('unsupported profile-relative text files are reported for review rather than silently applied', async () => {
  const result = await parseThunderstoreProfile(archive([
    { name: 'BepInEx/plugins/Team-Plugin/settings.json', content: '{}' },
    { name: 'custom.ini', content: 'value=true' },
    { name: 'mods.yml', content: 'ignored metadata' },
  ]), gameId);
  assert.deepEqual(result.configFiles, {});
  assert.equal(result.importWarnings.length, 2);
  assert.match(result.importWarnings[0], /BepInEx\/plugins\/Team-Plugin\/settings.json/);
});

test('Windows profile separators normalize before validation, including traversal and mixed separator collisions', async () => {
  const result = await parseThunderstoreProfile(archive([
    { name: 'config\\', mode: 0o040755 },
    { name: 'config\\BepInEx.cfg', content: '[Logging]\nEnabled = true' },
    { name: 'UserData\\Team-Mod\\settings.cfg', content: 'value=true' },
  ]), 'peak');
  assert.equal(result.configFiles['BepInEx.cfg'], '[Logging]\nEnabled = true');
  assert.equal(result.userDataFiles['Team-Mod/settings.cfg'], 'value=true');
  for (const files of [
    [{ name: 'config\\..\\outside.cfg', content: 'x' }],
    [{ name: 'C:\\outside.cfg', content: 'x' }],
    [{ name: '\\\\server\\outside.cfg', content: 'x' }],
    [{ name: 'config\\settings.cfg', content: 'x' }, { name: 'config/settings.cfg', content: 'y' }],
  ]) await assert.rejects(parseThunderstoreProfile(archive(files), 'peak'));
});

test('MIMESIS native profiles preserve MelonLoader UserData text separately from BepInEx configuration', async () => {
  const result = await parseThunderstoreProfile(archive([
    { name: 'UserData/MelonPreferences.cfg', content: '[Crew]\nName = café ☕', deflate: true },
    { name: 'UserData/Nested/settings.json', content: '{"enabled":true}' },
    { name: 'config/plugin.cfg', content: 'legacy = true' },
  ], { profileName: 'MIMESIS friends', mods: [
    { name: 'LavaGang-MelonLoader', version: { major: 0, minor: 7, patch: 3 } },
  ] }), 'mimesis');
  assert.equal(result.gameId, 'mimesis');
  assert.deepEqual(result.userDataFiles, {
    'MelonPreferences.cfg': '[Crew]\nName = café ☕', 'Nested/settings.json': '{"enabled":true}',
  });
  assert.deepEqual(result.configFiles, { 'plugin.cfg': 'legacy = true' });
  assert.deepEqual(result.importWarnings, []);
});

test('MelonLoader UserData rejects executables, case collisions, invalid text and aggregate excess', async () => {
  for (const files of [
    [{ name: 'UserData/run.dll', content: 'x' }],
    [{ name: 'UserData/settings.cfg', content: 'x\0y' }],
    [{ name: 'UserData/Test.cfg', content: 'x' }, { name: 'userdata/test.cfg', content: 'y' }],
    Array.from({ length: 129 }, (_, i) => ({ name: `UserData/${i}.cfg`, content: 'x' })),
    Array.from({ length: 5 }, (_, i) => ({ name: `UserData/${i}.cfg`, content: 'x'.repeat(250 * 1024), deflate: true })),
  ]) await assert.rejects(() => parseThunderstoreProfile(archive(files), 'mimesis'));
});

test('malformed, oversized, wrong-game, and noncanonical payloads fail before archive extraction', async () => {
  for (const value of ['', '{}', '#r2modman\n!!!!', '#r2modman\nUEs=', '#r2modman\n' + 'A'.repeat((MAX_ARCHIVE_BYTES + 1) * 4 / 3 | 0)]) {
    await assert.rejects(() => parseThunderstoreProfile(value, gameId));
  }
  await assert.rejects(() => parseThunderstoreProfile(archive(), 'valheim'), /Choose/);
});

test('manifest validation rejects duplicate packages, malformed versions, aliases, and multiple YAML documents', async () => {
  for (const value of [
    { ...manifest, mods: [...manifest.mods, manifest.mods[0]] },
    { ...manifest, mods: [{ name: 'Team-Plugin', version: { major: '1', minor: 0, patch: 0 } }] },
    { ...manifest, mods: [{ name: 'Team-Plugin', version: { major: 1, minor: 0, patch: 0 }, enabled: 'false' }] },
    { ...manifest, profileName: 'x'.repeat(61) },
    { ...manifest, mods: Array(201).fill(manifest.mods[0]) },
  ]) await assert.rejects(() => parseThunderstoreProfile(archive([], value), gameId));
  for (const text of ['profileName: &name Test\nmods: []\nother: *name', 'profileName: Test\nmods: []\n---\nprofileName: Other']) {
    await assert.rejects(() => parseThunderstoreProfile(encode(zipFixture([{ name: 'export.r2x', content: text }])), gameId), /manifest is invalid/);
  }
});

test('archive paths, links, executables, binary files, duplicate manifests, and checksum corruption are rejected', async () => {
  for (const entry of [
    { name: '../escape.cfg', content: 'x' }, { name: '/root.cfg', content: 'x' },
    { name: 'config\\..\\escape.cfg', content: 'x' }, { name: 'config/NUL.txt', content: 'x' },
    { name: 'config/link.cfg', content: 'x', mode: 0o120777 },
    { name: 'config/executable.dll', content: 'x' }, { name: 'plugin.exe', content: 'x' },
    { name: 'config/binary.cfg', content: Buffer.from([0xff, 0xfe]) },
    { name: 'config/nul.cfg', content: 'x\0y' },
    { name: 'config/broken.cfg', content: 'data', checksum: crc32(Buffer.from('other')) },
    { name: 'export.r2x', content: 'duplicate' },
  ]) await assert.rejects(() => parseThunderstoreProfile(archive([entry]), gameId));
  for (const files of [
    [{ name: 'config/Test.cfg', content: 'x' }, { name: 'config/test.cfg', content: 'x' }],
    [{ name: 'config/one.cfg', content: 'x' }, { name: 'BepInEx/config/one.cfg', content: 'x' }],
    [{ name: 'config/one.cfg', content: 'x' }, { name: 'config/one.cfg/two.cfg', content: 'x' }],
  ]) await assert.rejects(() => parseThunderstoreProfile(archive(files), gameId));
  await assert.rejects(() => parseThunderstoreProfile(encode(zipFixture([{ name: 'config/file.cfg', content: 'x' }])), gameId), /missing export.r2x/);
});

test('entry, expanded, manifest, and aggregate configuration limits prevent resource exhaustion', async () => {
  await assert.rejects(() => parseThunderstoreProfile(archive([], manifest, { declaredEntryCount: 513 }), gameId), /512/);
  await assert.rejects(() => parseThunderstoreProfile(archive([{ name: 'config/huge.cfg', content: 'x', expandedSize: 17 * 1024 * 1024 }]), gameId));
  await assert.rejects(() => parseThunderstoreProfile(encode(zipFixture([{ name: 'export.r2x', content: 'x'.repeat(256 * 1024 + 1) }])), gameId), /size/);
  await assert.rejects(() => parseThunderstoreProfile(archive(Array.from({ length: 129 }, (_, i) => ({ name: `config/${i}.cfg`, content: 'x' }))), gameId), /128/);
  await assert.rejects(() => parseThunderstoreProfile(archive(Array.from({ length: 5 }, (_, i) => ({ name: `config/${i}.cfg`, content: 'x'.repeat(250 * 1024), deflate: true }))), gameId), /1 MB/);
});
