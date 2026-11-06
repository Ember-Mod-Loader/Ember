const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSteamAdapter, createSupportedGameGuard } = require('../electron/steam.cjs');

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
  const gameDir = path.join(library, 'steamapps', 'common', 'Lethal Company');
  const profilePath = path.join(root, 'Staged profile');
  const preloader = path.join(profilePath, 'BepInEx', 'core', 'BepInEx.Preloader.dll');
  await write(path.join(steam, 'Steam.exe'));
  await write(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders" { "1" { "path" ${JSON.stringify(library)} } }`);
  await write(path.join(library, 'steamapps', `appmanifest_${GAME_ID}.acf`),
    `"AppState" { "appid" "${GAME_ID}" "installdir" "Lethal Company" }`);
  await write(path.join(gameDir, 'Lethal Company.exe'));
  await fs.mkdir(path.join(gameDir, 'Lethal Company_Data'));
  await write(preloader);

  const launched = [];
  const adapter = createSteamAdapter({
    findRoots: async () => [steam],
    assertClosed: overrides.assertClosed ? () => overrides.assertClosed(gameDir) : async () => {},
    startSteam: async (executable, args) => launched.push({ executable, args }),
  });
  return { root, steam, gameDir, profilePath, preloader, adapter, launched };
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
