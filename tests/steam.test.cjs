const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSteamAdapter, createGameLauncher, createGameGuard, createSupportedGameGuard, SUPPORTED_GAMES } = require('../electron/steam.cjs');

const WINDOWS_ONLY = { skip: process.platform !== 'win32' };
const GAME_ID = '1966720';
const OWNERSHIP = '.modspindle-doorstop.json';
const INI = 'doorstop_config.ini';
const PROXY = 'winhttp.dll';

test('client update process guard blocks each supported Steam game by exact case-insensitive image name', async () => {
  for (const [image, game] of [['Lethal Company.exe', 'Lethal Company'], ['REPO.exe', 'R.E.P.O.'], ['PEAK.exe', 'PEAK']]) {
    const guard = createSupportedGameGuard({ platform: 'win32', run: async (executable, args, options) => {
      assert.match(executable, /tasklist\.exe$/);
      assert.deepEqual(args, ['/FO', 'CSV', '/NH']);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 5000);
      return { stdout: `"${image.toUpperCase()}","123","Console","1","50,000 K"\r\n` };
    } });
    await assert.rejects(guard(), error => error.message.includes(game) && error.message.includes('client update'));
  }
});

test('client update guard allows unrelated process names but rejects empty, malformed, or failed enumeration', async () => {
  const allowed = createSupportedGameGuard({ platform: 'win32', run: async () => ({ stdout: [
    '"System Idle Process","0","Services","0","8 K"',
    '"REPO.exe.helper","123","Console","1","10 K"',
    '"NotPEAK.exe","124","Console","1","10 K"',
    '"Ember.exe","125","Console","1","10 K"',
  ].join('\r\n') }) });
  await allowed();
  for (const stdout of ['', 'tasklist returned unreadable output', '"PEAK.exe"', undefined]) {
    const guard = createSupportedGameGuard({ platform: 'win32', run: async () => ({ stdout }) });
    await assert.rejects(guard(), /could not confirm/);
  }
  const failed = createSupportedGameGuard({ platform: 'win32', run: async () => { throw new Error('process lookup failed'); } });
  await assert.rejects(failed(), /could not confirm/);
  const unsupported = createSupportedGameGuard({ platform: 'linux', run: () => { throw new Error('must not call'); } });
  await assert.rejects(unsupported(), /only on Windows/);
});

test('each launcher process guard checks the selected game and fails closed when Windows cannot enumerate processes', async () => {
  for (const game of Object.values(SUPPORTED_GAMES)) {
    const guard = stdout => createGameGuard({ gameId: game.id, platform: 'win32', run: async () => ({ stdout }) });
    await assert.rejects(guard(`"${game.executable.toUpperCase()}","123","Console","1","10 K"`)(), error => error.message.includes(`Close ${game.name}`));
    await guard('"Steam.exe","10","Console","1","10 K"')();
    await assert.rejects(guard('unreadable output')(), /could not confirm/);
    const failed = createGameGuard({ gameId: game.id, platform: 'win32', run: async () => { throw new Error('blocked'); } });
    await assert.rejects(failed(), /could not confirm/);
  }
  assert.throws(() => createSteamAdapter({ gameId: 'unknown-game' }), /supported game/);
  assert.throws(() => createSteamAdapter({ gameId: '__proto__' }), /supported game/);
  assert.equal(createGameLauncher, createSteamAdapter);
});

async function write(file, contents = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

function doorstopFlags(major) {
  return major === 4
    ? ['--doorstop-enabled', '--doorstop-target-assembly']
    : ['--doorstop-enable', '--doorstop-target'];
}

async function stageLoader(root, major) {
  const loader = path.join(root, `Doorstop ${major}`);
  const proxy = Buffer.alloc(512);
  proxy.writeUInt16LE(0x5a4d, 0);
  proxy.writeUInt32LE(0x80, 0x3c);
  proxy.writeUInt32LE(0x4550, 0x80);
  proxy.writeUInt16LE(0x8664, 0x84);
  let offset = 0xa0;
  for (const field of [INI, ...doorstopFlags(major)]) {
    offset += proxy.write(field + '\0', offset, 'utf16le');
  }
  await write(path.join(loader, PROXY), proxy);
  await write(path.join(loader, INI), major === 4
    ? '[General]\nenabled=true\ntarget_assembly=BepInEx\\core\\BepInEx.Preloader.dll\n'
    : '[UnityDoorstop]\nenabled=true\ntargetAssembly=BepInEx\\core\\BepInEx.Preloader.dll\n');
  if (major === 4) await write(path.join(loader, '.doorstop_version'), '4.5.0');
  return loader;
}

async function fixture(t, overrides = {}) {
  const game = SUPPORTED_GAMES[overrides.gameId ?? 'lethal-company'];
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'modspindle-steam-test-'));
  t.after(async () => {
    const target = await fs.realpath(root);
    assert.equal(target, root);
    assert.equal(path.dirname(target), temp);
    await fs.rm(target, { recursive: true, force: true });
  });

  const steam = path.join(root, 'Steam');
  const library = path.join(root, 'Separate Steam library');
  const gameDir = path.join(library, 'steamapps', 'common', game.id);
  const profilePath = path.join(root, 'Staged profile');
  const preloader = path.join(profilePath, 'BepInEx', 'core', 'BepInEx.Preloader.dll');
  await write(path.join(steam, 'Steam.exe'));
  await write(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders" { "1" { "path" ${JSON.stringify(library)} } }`);
  await write(path.join(library, 'steamapps', `appmanifest_${game.steamId}.acf`),
    `"AppState" { "appid" "${game.steamId}" "installdir" "${game.id}" }`);
  await write(path.join(gameDir, game.executable));
  await fs.mkdir(path.join(gameDir, game.dataDirectory));
  await write(preloader);

  const launched = [];
  const adapter = createSteamAdapter({
    gameId: game.id,
    findRoots: async () => [steam],
    assertClosed: overrides.assertClosed ? () => overrides.assertClosed(gameDir) : async () => {},
    startSteam: async (executable, args) => launched.push({ executable, args }),
  });
  return { root, steam, library, game, gameDir, profilePath, preloader, adapter, launched };
}

for (const major of [3, 4]) {
  test(`Steam stages Doorstop ${major} and dispatches matching launch flags`, WINDOWS_ONLY, async t => {
    const { root, steam, gameDir, profilePath, preloader, adapter, launched } = await fixture(t);
    const loaderPath = await stageLoader(root, major);
    const [enable, target] = doorstopFlags(major);
    assert.equal((await adapter.findLethalCompany()).loader, 'clean');
    await assert.rejects(adapter.getLaunchStatus(profilePath), /registered in your Steam library/);

    await adapter.launchLethalCompany({ gameDir, mode: 'vanilla' });
    assert.deepEqual(launched.pop(), {
      executable: await fs.realpath(path.join(steam, 'Steam.exe')), args: ['-applaunch', GAME_ID],
    });
    await assert.rejects(adapter.launchLethalCompany({ gameDir, mode: 'modded', profilePath, loaderPath }), /Set up/);

    const setup = await adapter.prepareDoorstop({ gameDir, loaderPath });
    assert.equal(setup.loader, 'managed');
    assert.equal(setup.doorstopMajor, major);
    assert.match(await fs.readFile(path.join(gameDir, INI), 'utf8'), /^enabled=false\r?$/m);

    const mismatched = await stageLoader(root, major === 4 ? 3 : 4);
    await assert.rejects(
      adapter.launchLethalCompany({ gameDir, mode: 'modded', profilePath, loaderPath: mismatched }),
      /matching BepInExPack version/,
    );
    await adapter.launchLethalCompany({ gameDir, mode: 'modded', profilePath, loaderPath });
    await adapter.launchLethalCompany({ gameDir, mode: 'vanilla' });
    assert.deepEqual(launched.map(result => result.args), [
      ['-applaunch', GAME_ID, enable, 'true', target, await fs.realpath(preloader)],
      ['-applaunch', GAME_ID, enable, 'false'],
    ]);

    const unrelated = path.join(gameDir, 'local-notes.txt');
    await write(unrelated, 'keep me');
    assert.equal((await adapter.removeManagedDoorstop(gameDir)).loader, 'clean');
    for (const file of [PROXY, INI, OWNERSHIP, '.doorstop_version']) {
      await assert.rejects(fs.stat(path.join(gameDir, file)), { code: 'ENOENT' });
    }
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep me');
    assert.equal((await fs.readdir(gameDir)).some(file => file.startsWith('.modspindle-doorstop-removal-')), false);
  });
}

test('existing Doorstop requires explicit reuse and can block vanilla', WINDOWS_ONLY, async t => {
  const { root, gameDir, profilePath, adapter, launched } = await fixture(t);
  const loaderPath = await stageLoader(root, 4);
  await adapter.prepareDoorstop({ gameDir, loaderPath });
  await fs.unlink(path.join(gameDir, OWNERSHIP));
  const config = path.join(gameDir, INI);
  const initial = await fs.readFile(config);

  assert.equal((await adapter.getLaunchStatus(gameDir)).loader, 'existing');
  await assert.rejects(adapter.prepareDoorstop({ gameDir, loaderPath }), /already contains loader files/);
  await assert.rejects(adapter.removeManagedDoorstop(gameDir), /Only unchanged loader files/);
  const modded = { gameDir, mode: 'modded', profilePath, loaderPath };
  await assert.rejects(adapter.launchLethalCompany(modded), /Confirm reuse/);
  await adapter.launchLethalCompany({ ...modded, allowExistingDoorstop: true });
  assert.equal(launched.length, 1);
  assert.deepEqual(await fs.readFile(config), initial);

  await fs.writeFile(config, initial.toString().replace('ignore_disable_switch=false', 'ignore_disable_switch=true'));
  assert.equal((await adapter.getLaunchStatus(gameDir)).canLaunchVanilla, false);
  await assert.rejects(adapter.launchLethalCompany({ gameDir, mode: 'vanilla' }), /safely launching vanilla/);
  await write(path.join(gameDir, 'dxgi.dll'), 'another loader');
  assert.equal((await adapter.getLaunchStatus(gameDir)).loader, 'unsupported');
});

test('loader removal refuses files changed after the initial status check', WINDOWS_ONLY, async t => {
  let mutate = false;
  const { root, gameDir, adapter } = await fixture(t, {
    assertClosed: async game => {
      if (mutate) await fs.appendFile(path.join(game, INI), '; changed externally\n');
    },
  });
  const loaderPath = await stageLoader(root, 4);
  await adapter.prepareDoorstop({ gameDir, loaderPath });
  mutate = true;
  await assert.rejects(adapter.removeManagedDoorstop(gameDir), /loader files changed/);
  assert.match(await fs.readFile(path.join(gameDir, INI), 'utf8'), /changed externally/);
  assert.equal((await fs.stat(path.join(gameDir, PROXY))).isFile(), true);
});

test('loader setup rolls back its files on a concurrent proxy collision', WINDOWS_ONLY, async t => {
  const external = 'concurrent third-party proxy';
  const { root, gameDir, adapter, launched } = await fixture(t, {
    assertClosed: game => write(path.join(game, PROXY), external),
  });
  const loaderPath = await stageLoader(root, 4);
  await assert.rejects(adapter.prepareDoorstop({ gameDir, loaderPath }), /did not overwrite/);
  assert.equal(await fs.readFile(path.join(gameDir, PROXY), 'utf8'), external);
  for (const file of [INI, OWNERSHIP, '.doorstop_version']) {
    await assert.rejects(fs.stat(path.join(gameDir, file)), { code: 'ENOENT' });
  }
  assert.deepEqual(launched, []);
});

for (const gameId of ['repo', 'peak']) {
  test(`${gameId} discovers its separate Steam library and launches isolated modded/vanilla profiles`, WINDOWS_ONLY, async t => {
    const { root, game, steam, gameDir, profilePath, preloader, adapter, launched } = await fixture(t, { gameId });
    const loaderPath = await stageLoader(root, 4);
    if (gameId === 'peak') await write(path.join(loaderPath, '.doorstop_version'), '4.4.1PEAK');
    await fs.appendFile(path.join(loaderPath, INI), '\n[Extra]\nbypass_vulkan = false\n');
    const profileConfig = path.join(profilePath, 'BepInEx', 'config', 'BepInEx.cfg');
    await write(profileConfig, '[Chainloader]\nHideManagerGameObject = true\n');
    assert.equal((await adapter.findGame()).gameId, gameId);
    assert.equal((await adapter.findGame()).loader, 'clean');
    await adapter.launchGame({ gameDir, mode: 'vanilla' });
    assert.deepEqual(launched.pop(), { executable: await fs.realpath(path.join(steam, 'Steam.exe')), args: ['-applaunch', game.steamId] });
    await assert.rejects(adapter.launchGame({ gameDir, mode: 'modded', profilePath, loaderPath }), /Set up/);

    const setup = await adapter.prepareDoorstop({ gameDir, loaderPath });
    assert.equal(setup.gameId, gameId);
    assert.equal(setup.loader, 'managed');
    assert.equal(setup.doorstopMajor, 4);
    const installedConfig = await fs.readFile(path.join(gameDir, INI));
    assert.match(installedConfig.toString(), /^enabled=false\r?$/m);
    assert.match(installedConfig.toString(), /\[Extra\]\r?\nbypass_vulkan = false/);
    assert.equal(await fs.readFile(path.join(gameDir, '.doorstop_version'), 'utf8'), gameId === 'peak' ? '4.4.1PEAK' : '4.5.0');

    const secondProfile = path.join(root, 'Another profile');
    const secondPreloader = path.join(secondProfile, 'BepInEx', 'core', 'BepInEx.Preloader.dll');
    await write(secondPreloader, 'second profile');
    await adapter.launchGame({ gameDir, mode: 'modded', profilePath, loaderPath });
    await adapter.launchGame({ gameDir, mode: 'modded', profilePath: secondProfile, loaderPath });
    await adapter.launchGame({ gameDir, mode: 'vanilla' });
    assert.deepEqual(launched.map(result => result.args), [
      ['-applaunch', game.steamId, '--doorstop-enabled', 'true', '--doorstop-target-assembly', await fs.realpath(preloader)],
      ['-applaunch', game.steamId, '--doorstop-enabled', 'true', '--doorstop-target-assembly', await fs.realpath(secondPreloader)],
      ['-applaunch', game.steamId, '--doorstop-enabled', 'false'],
    ]);
    assert.deepEqual(await fs.readFile(path.join(gameDir, INI)), installedConfig);
    assert.match(await fs.readFile(profileConfig, 'utf8'), /HideManagerGameObject = true/);
    await assert.rejects(fs.stat(path.join(gameDir, 'BepInEx')), { code: 'ENOENT' });
    assert.equal((await adapter.removeManagedDoorstop(gameDir)).loader, 'clean');
    assert.equal((await adapter.findGame()).gameId, gameId);
  });

  test(`${gameId} refuses a different game's registered folder and incomplete or mismatched manifests`, WINDOWS_ONLY, async t => {
    const { steam, library, game, gameDir, adapter, launched } = await fixture(t, { gameId });
    const other = SUPPORTED_GAMES[gameId === 'repo' ? 'peak' : 'repo'];
    const otherDir = path.join(library, 'steamapps', 'common', other.id);
    await write(path.join(otherDir, other.executable));
    await fs.mkdir(path.join(otherDir, other.dataDirectory));
    await write(path.join(library, 'steamapps', `appmanifest_${other.steamId}.acf`),
      `"AppState" { "appid" "${other.steamId}" "installdir" "${other.id}" }`);
    const otherAdapter = createSteamAdapter({ gameId: other.id, findRoots: async () => [steam], assertClosed: async () => {}, startSteam: () => assert.fail('must not launch') });
    assert.equal((await otherAdapter.findGame()).gameDir, await fs.realpath(otherDir));
    await assert.rejects(adapter.getLaunchStatus(otherDir), error => error.message.includes(game.name) && error.message.includes('registered'));
    await assert.rejects(adapter.launchGame({ gameDir: otherDir, mode: 'vanilla' }), /registered/);
    await assert.rejects(adapter.prepareDoorstop({ gameDir: otherDir, loaderPath: otherDir }), /registered/);
    assert.deepEqual(launched, []);
    await fs.unlink(path.join(gameDir, game.executable));
    assert.equal(await adapter.findGame(), null);
    await write(path.join(gameDir, game.executable));
    await write(path.join(library, 'steamapps', `appmanifest_${game.steamId}.acf`),
      `"AppState" { "appid" "${other.steamId}" "installdir" "${game.id}" }`);
    assert.equal(await adapter.findGame(), null);
  });

  test(`${gameId} preserves an existing loader and blocks setup, launch and removal while running`, WINDOWS_ONLY, async t => {
    let running = true;
    const { root, gameDir, profilePath, adapter, launched } = await fixture(t, { gameId,
      assertClosed: async () => { if (running) throw new Error('Game is running'); },
    });
    const loaderPath = await stageLoader(root, 4);
    if (gameId === 'peak') await write(path.join(loaderPath, '.doorstop_version'), '4.4.1PEAK');
    await assert.rejects(adapter.launchGame({ gameDir, mode: 'vanilla' }), /Game is running/);
    await assert.rejects(adapter.prepareDoorstop({ gameDir, loaderPath }), /Game is running/);
    await assert.rejects(fs.stat(path.join(gameDir, PROXY)), { code: 'ENOENT' });
    running = false;
    await adapter.prepareDoorstop({ gameDir, loaderPath });
    const original = await fs.readFile(path.join(gameDir, INI));
    running = true;
    await assert.rejects(adapter.launchGame({ gameDir, mode: 'modded', profilePath, loaderPath }), /Game is running/);
    await assert.rejects(adapter.removeManagedDoorstop(gameDir), /Game is running/);
    assert.deepEqual(await fs.readFile(path.join(gameDir, INI)), original);
    assert.deepEqual(launched, []);
    running = false;
    await fs.unlink(path.join(gameDir, OWNERSHIP));
    const status = await adapter.getLaunchStatus(gameDir);
    assert.equal(status.loader, 'existing');
    await assert.rejects(adapter.removeManagedDoorstop(gameDir), /Only unchanged/);
    await assert.rejects(adapter.launchGame({ gameDir, mode: 'modded', profilePath, loaderPath, allowExistingDoorstop: true, loaderFingerprint: 'stale' }), /Confirm reuse/);
    await adapter.launchGame({ gameDir, mode: 'modded', profilePath, loaderPath, allowExistingDoorstop: true, loaderFingerprint: status.loaderFingerprint });
    await adapter.launchGame({ gameDir, mode: 'vanilla' });
    assert.deepEqual(await fs.readFile(path.join(gameDir, INI)), original);
  });
}

test('the official PEAK Doorstop marker is accepted only for PEAK and arbitrary suffixes are rejected', WINDOWS_ONLY, async t => {
  const { root, gameDir, adapter } = await fixture(t);
  const loaderPath = await stageLoader(root, 4);
  await write(path.join(loaderPath, '.doorstop_version'), '4.4.1PEAK');
  await assert.rejects(adapter.prepareDoorstop({ gameDir, loaderPath }), /official Windows x64 BepInEx pack/);
  const peak = await fixture(t, { gameId: 'peak' });
  await write(path.join(loaderPath, '.doorstop_version'), '4.4.1UNRECOGNIZED');
  await assert.rejects(peak.adapter.prepareDoorstop({ gameDir: peak.gameDir, loaderPath }), /official Windows x64 BepInEx pack/);
});
