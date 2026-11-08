const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { createGameFileManager, SOURCE_DIRECTORY } = require('../electron/game-files.cjs');
const { createHash } = require('node:crypto');

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ember-game-files-'));
  const game = path.join(root, 'game');
  const profile = path.join(root, 'profile');
  await mkdir(game); await mkdir(profile);
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  });
  return { root, game, profile, source: path.join(profile, SOURCE_DIRECTORY), manager: createGameFileManager(game) };
}

test('game file overlays back up replacements and restore originals for vanilla, including after manager restart', async t => {
  const f = await fixture(t);
  await write(f.game, 'Game_Data/resources.assets', 'original game asset');
  await write(f.source, 'Game_Data/resources.assets', 'modded asset');
  await write(f.source, 'custom/textures/map.png', 'mod texture');
  await f.manager.apply(f.profile);
  assert.equal(await readFile(path.join(f.game, 'Game_Data/resources.assets'), 'utf8'), 'modded asset');
  assert.equal(await readFile(path.join(f.game, 'custom/textures/map.png'), 'utf8'), 'mod texture');
  await createGameFileManager(f.game).restore();
  assert.equal(await readFile(path.join(f.game, 'Game_Data/resources.assets'), 'utf8'), 'original game asset');
  await assert.rejects(lstat(path.join(f.game, 'custom/textures/map.png')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(f.game, '.ember-mod-files')), { code: 'ENOENT' });
});

test('switching profiles or a profile with no game files removes the previous overlay', async t => {
  const f = await fixture(t);
  await write(f.game, 'data.txt', 'game');
  await write(f.source, 'data.txt', 'first');
  const second = path.join(f.root, 'second');
  await write(path.join(second, SOURCE_DIRECTORY), 'data.txt', 'second');
  const empty = path.join(f.root, 'empty'); await mkdir(empty);
  await f.manager.apply(f.profile);
  await f.manager.apply(second);
  assert.equal(await readFile(path.join(f.game, 'data.txt'), 'utf8'), 'second');
  await f.manager.apply(empty);
  assert.equal(await readFile(path.join(f.game, 'data.txt'), 'utf8'), 'game');
});

test('modified mod files are preserved separately while original game files are restored', async t => {
  const f = await fixture(t);
  await write(f.game, 'settings.txt', 'original');
  await write(f.source, 'settings.txt', 'mod');
  await f.manager.apply(f.profile);
  await write(f.game, 'settings.txt', 'edited during game');
  await f.manager.restore();
  assert.equal(await readFile(path.join(f.game, 'settings.txt'), 'utf8'), 'original');
  const recovered = (await readdir(f.game)).find(name => name.startsWith('.ember-recovered-'));
  assert.ok(recovered);
  assert.equal(await readFile(path.join(f.game, recovered, 'changed/settings.txt'), 'utf8'), 'edited during game');
});

test('a corrupt original backup stops restoration without overwriting the current file', async t => {
  const f = await fixture(t);
  await write(f.game, 'asset.txt', 'original');
  await write(f.source, 'asset.txt', 'modded');
  await f.manager.apply(f.profile);
  await write(f.game, '.ember-mod-files/0.bin', 'tampered');
  await assert.rejects(f.manager.restore(), /backup changed/);
  assert.equal(await readFile(path.join(f.game, 'asset.txt'), 'utf8'), 'modded');
});

test('journal recovery tolerates interruption before backup copy and during backup cleanup', async t => {
  const f = await fixture(t);
  const hash = value => createHash('sha256').update(value).digest('hex');
  await write(f.game, 'asset.txt', 'original');
  const record = { path: 'asset.txt', backup: '0.bin', original: hash('original'), installed: hash('modded') };
  // The journal was committed, but the original backup was never finished.
  await write(f.game, '.ember-mod-files/state.json', JSON.stringify({ version: 1, files: [record] }));
  await write(f.game, '.ember-mod-files/0.bin', 'partial');
  await f.manager.restore();
  assert.equal(await readFile(path.join(f.game, 'asset.txt'), 'utf8'), 'original');
  // Restoring succeeded and some backups were deleted before the process stopped.
  await write(f.game, '.ember-mod-files/state.json', JSON.stringify({ version: 1, restored: true, files: [record] }));
  await write(f.game, '.ember-mod-files/17.bin', 'unreferenced pre-write backup');
  await f.manager.restore();
  assert.equal(await readFile(path.join(f.game, 'asset.txt'), 'utf8'), 'original');
  await assert.rejects(lstat(path.join(f.game, '.ember-mod-files')), { code: 'ENOENT' });
});

test('invalid replacement plans leave the current profile and outside files untouched', async t => {
  const f = await fixture(t);
  await write(f.source, 'asset.txt', 'first');
  await f.manager.apply(f.profile);
  const second = path.join(f.root, 'bad-profile');
  await write(path.join(second, SOURCE_DIRECTORY), 'MIMESIS.exe', 'replacement executable');
  await assert.rejects(f.manager.apply(second), /cannot replace the game executable/);
  assert.equal(await readFile(path.join(f.game, 'asset.txt'), 'utf8'), 'first');
  await write(f.game, '.ember-mod-files/state.json', JSON.stringify({ version: 1, files: [{ path: '../outside.txt', backup: '0.bin', original: null, installed: 'a'.repeat(64) }] }));
  await assert.rejects(f.manager.restore(), /Unsafe game mod path/);
});

test('junctions in source or target paths cannot redirect an overlay outside the game', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside'); await mkdir(outside);
  await write(outside, 'asset.txt', 'untouched');
  await symlink(outside, path.join(f.game, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await write(f.source, 'linked/asset.txt', 'mod');
  await assert.rejects(f.manager.apply(f.profile), /crosses a link/);
  assert.equal(await readFile(path.join(outside, 'asset.txt'), 'utf8'), 'untouched');
});
