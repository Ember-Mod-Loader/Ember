const assert = require('node:assert/strict');
const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { registerGameActions } = require('../electron/game-actions.cjs');
const { createProfileBuilder } = require('../electron/profiles.cjs');
const { createDownloadHistory } = require('../electron/download-history.cjs');
const { temporaryDirectory } = require('./temp-directory.cjs');
const { zipFixture } = require('./zip-fixture.cjs');

const GAME_IDS = ['lethal-company', 'repo', 'peak', 'mimesis'];
const GENERIC_LOADER = { namespace: 'BepInEx', name: 'BepInExPack', version: '5.4.2305' };
const PLUGIN = { namespace: 'Tests', name: 'Example', version: '1.0.0' };
const loaderFor = gameId => gameId === 'peak'
  ? { namespace: 'BepInEx', name: 'BepInExPack_PEAK', version: '5.4.75301' }
  : gameId === 'mimesis' ? { namespace: 'LavaGang', name: 'MelonLoader', version: '0.7.3' } : GENERIC_LOADER;

test('imported configuration reaches preparation, setup, and modded launch for each game', async t => {
  const f = await fixture(t);
  for (const gameId of GAME_IDS) {
    const loader = loaderFor(gameId);
    const profileId = `${gameId}-default`;
    const configurations = { 'imported/settings.cfg': `Game = ${gameId}\n` };
    assert.equal(await f.invoke('prepare-profile', profileId, [loader], 'Imported', gameId, configurations), true);
    const runtime = path.join(f.directory, 'profiles', gameId, profileId, 'runtime');
    assert.equal(await readFile(path.join(runtime, 'BepInEx/config/imported/settings.cfg'), 'utf8'), configurations['imported/settings.cfg']);
    f.statuses.get(gameId).loader = 'clean';
    const setupConfigurations = { ...configurations, 'setup.cfg': 'Prepared during setup' };
    await f.invoke('setup-loader', profileId, [loader], 'Imported', gameId, setupConfigurations);
    assert.equal(await readFile(path.join(runtime, 'BepInEx/config/setup.cfg'), 'utf8'), 'Prepared during setup');
    const launchConfigurations = { ...setupConfigurations, 'launch.cfg': 'Prepared during launch' };
    await f.invoke('launch-game', 'modded', profileId, [loader], undefined, 'Imported', gameId, launchConfigurations);
    assert.equal(await readFile(path.join(runtime, 'BepInEx/config/launch.cfg'), 'utf8'), 'Prepared during launch');
  }
});

async function fixture(t, createProfiles) {
  const directory = await temporaryDirectory(t);
  const events = [];
  const history = await createDownloadHistory(path.join(directory, 'downloads.json'), event => events.push(event));
  const cache = { root: path.join(directory, 'cache') };
  const archives = new Map();
  const downloads = [];
  let clock = 1_000_000;
  let launchError = null;
  let launchHook;
  let beforeDownload;
  async function addPackage(gameId, ref, entries) {
    const filename = `archive-${archives.size}.zip`;
    const bytes = zipFixture(entries);
    const folder = path.join(cache.root, gameId);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, filename), bytes);
    archives.set(`${gameId}/${ref.namespace}/${ref.name}@${ref.version}`, { filename, bytes: bytes.length });
  }
  for (const gameId of GAME_IDS) {
    const loader = loaderFor(gameId);
    await addPackage(gameId, loader, gameId === 'mimesis' ? [
      { name: 'MelonLoader/net35/MelonLoader.dll', content: 'Mono loader' },
      { name: 'MelonLoader/net6/MelonLoader.dll', content: 'IL2CPP loader' },
      { name: 'version.dll', content: 'MelonLoader proxy' },
      { name: 'dobby.dll', content: 'MelonLoader dependency' },
    ] : [
      { name: `${loader.name}/BepInEx/core/BepInEx.Preloader.dll`, content: `preloader-${gameId}` },
      { name: `${loader.name}/BepInEx/config/BepInEx.cfg`, content: `HideManagerGameObject = ${gameId === 'peak'}` },
      { name: `${loader.name}/winhttp.dll`, content: `proxy-${gameId}` },
      { name: `${loader.name}/doorstop_config.ini`, content: '[General]\nenabled = true\n[Extra]\nbypass_vulkan = false\n' },
      { name: `${loader.name}/.doorstop_version`, content: gameId === 'peak' ? '4.4.1PEAK' : '4.5.0' },
    ]);
    await addPackage(gameId, PLUGIN, [{ name: gameId === 'mimesis' ? 'Example.dll' : 'BepInEx/plugins/Example.dll', content: `plugin-${gameId}` }]);
  }
  // Including this in an imported PEAK profile must never deploy or plan it.
  await addPackage('peak', GENERIC_LOADER, [
    { name: 'BepInExPack/BepInEx/config/BepInEx.cfg', content: 'HideManagerGameObject = false' },
  ]);
  cache.downloadPackage = async (input, report) => {
    downloads.push(input);
    if (beforeDownload) await beforeDownload(input);
    const archive = archives.get(`${input.gameId}/${input.namespace}/${input.name}@${input.version}`);
    assert.ok(archive, 'the requested game and version exist in the offline cache fixture');
    report({ status: 'downloading', received: 0, total: archive.bytes });
    report({ status: 'complete', received: archive.bytes, total: archive.bytes, cached: true });
    return { filename: archive.filename };
  };
  const calls = [];
  const statuses = new Map(GAME_IDS.map(gameId => [gameId, {
    gameId, gameDir: path.join(directory, 'synthetic-games', gameId),
    loader: 'existing', loaderFingerprint: `fingerprint-${gameId}`, canLaunchVanilla: true,
  }]));
  const handlers = new Map();
  const opened = [];
  let selection;
  const window = {};
  const actions = registerGameActions({
    directory, cache, history, createProfiles, now: () => clock,
    handle: (name, callback) => handlers.set(name, callback),
    getWindow: () => window,
    dialog: { showOpenDialog: async (actualWindow, options) => {
      assert.equal(actualWindow, window);
      calls.push({ method: 'choose', title: options.title });
      return selection ?? { canceled: true };
    } },
    shell: { openPath: async target => { opened.push(target); return ''; } },
    createLauncher: ({ gameId }) => {
      const record = (method, input) => calls.push({ gameId, method, input });
      return {
        findGame: async () => { record('find'); return { ...statuses.get(gameId) }; },
        getLaunchStatus: async gameDir => {
          record('status', gameDir);
          assert.equal(gameDir, statuses.get(gameId).gameDir, 'paths stay with the selected launcher');
          return { ...statuses.get(gameId) };
        },
        getRunningStatus: async () => {
          record('running');
          const status = statuses.get(gameId);
          return { running: status.running === true, processCount: status.running ? status.processCount ?? 1 : 0 };
        },
        assertGameClosed: async () => { record('closed'); },
        launchGame: async input => {
          record('launch', input);
          if (launchHook) await launchHook(gameId, input);
          if (launchError) throw launchError;
        },
        prepareDoorstop: async input => { record('setup', input); return { ...statuses.get(gameId), loader: 'managed' }; },
        removeManagedDoorstop: async input => { record('remove', input); return { ...statuses.get(gameId), loader: 'clean' }; },
      };
    },
  });
  return {
    directory, history, events, downloads, calls, statuses, opened, actions, addPackage,
    invoke: (name, ...args) => handlers.get(name)(...args),
    select: gameId => { selection = { canceled: false, filePaths: [statuses.get(gameId).gameDir] }; },
    blockDownload: hook => { beforeDownload = hook; },
    advanceTime: milliseconds => { clock += milliseconds; },
    setRunning: (gameId, running, processCount = running ? 1 : 0) => { Object.assign(statuses.get(gameId), { running, processCount }); },
    failLaunch: error => { launchError = error; },
    blockLaunch: hook => { launchHook = hook; },
  };
}

test('PEAK with both loader packs finishes real profile/history preparation and launches on the first request', async t => {
  const f = await fixture(t);
  const refs = [PLUGIN, GENERIC_LOADER, loaderFor('peak')];
  assert.equal(await f.invoke('launch-game', 'modded', 'peak-default', refs, 'fingerprint-peak', 'Default', 'peak'), true);
  const records = f.history.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].gameId, 'peak');
  assert.equal(records[0].status, 'complete');
  assert.deepEqual(records[0].packages.map(item => item.name).sort(), ['BepInExPack_PEAK', 'Example']);
  assert.equal(records[0].packages.every(item => item.status === 'complete'), true);
  assert.equal(f.events.some(event => event.status === 'downloading'), true);
  assert.equal(f.events.some(event => event.status === 'saving'), true);
  assert.equal(f.downloads.some(input => input.name === 'BepInExPack'), false);
  const launch = f.calls.find(call => call.method === 'launch');
  assert.equal(launch.gameId, 'peak');
  const runtime = path.join(f.directory, 'profiles', 'peak', 'peak-default', 'runtime');
  assert.equal(launch.input.profilePath, runtime);
  assert.equal(await readFile(path.join(runtime, 'BepInEx', 'config', 'BepInEx.cfg'), 'utf8'), 'HideManagerGameObject = true');
  assert.equal(await readFile(path.join(runtime, '.doorstop_version'), 'utf8'), '4.4.1PEAK');
  assert.equal(f.actions.isBusy(), true, 'a dispatched launch remains pending until Windows reports a game or the grace period expires');
  // A prepared runtime is reused without creating a permanently pending history row.
  f.advanceTime(30_001);
  assert.equal(await f.invoke('launch-game', 'modded', 'peak-default', refs, undefined, 'Default', 'peak'), true);
  assert.equal(f.history.list().length, 1);
  assert.equal(f.calls.filter(call => call.method === 'launch').length, 2);
});

test('all four game routes persist independent approvals and reuse existing Lethal Company paths', async t => {
  const f = await fixture(t);
  const lc = f.statuses.get('lethal-company');
  await writeFile(path.join(f.directory, 'lethal-company.json'), JSON.stringify({ gameDir: lc.gameDir, approvedLoader: lc.loaderFingerprint }));
  assert.equal((await f.invoke('game-status')).loaderApproved, true);
  for (const gameId of GAME_IDS) {
    const refs = [loaderFor(gameId), PLUGIN];
    const profileId = `${gameId}-default`;
    const status = await f.invoke('game-status', gameId);
    assert.equal(status.gameId, gameId);
    if (gameId !== 'lethal-company') {
      assert.equal(status.loaderApproved, false);
      await assert.rejects(f.invoke('launch-game', 'modded', profileId, refs, undefined, 'Default', gameId), /Confirm reuse/);
    }
    await f.invoke('launch-game', 'modded', profileId, refs, status.loaderFingerprint, 'Default', gameId);
    assert.equal((await f.invoke('game-status', gameId)).loaderApproved, true);
    const saved = JSON.parse(await readFile(path.join(f.directory, `${gameId}.json`), 'utf8'));
    assert.deepEqual(saved, { gameDir: status.gameDir, approvedLoader: status.loaderFingerprint });
    await f.invoke('open-profile', profileId, gameId);
    assert.equal(f.opened.at(-1), path.join(f.directory, 'profiles', gameId, profileId, 'runtime'));
    f.select(gameId);
    await f.invoke('choose-game', gameId);
    assert.equal((await f.invoke('game-status', gameId)).loaderApproved, true);
    f.advanceTime(30_001);
    await f.invoke('launch-game', 'vanilla', profileId, [], undefined, 'Default', gameId);
    const latest = f.calls.filter(call => call.method === 'launch').at(-1);
    assert.equal(latest.gameId, gameId);
    assert.equal(latest.input.mode, 'vanilla');
    assert.equal(latest.input.profilePath, undefined);
  }
  assert.deepEqual(new Set(f.downloads.map(input => input.gameId)), new Set(GAME_IDS));
  assert.equal(f.history.list().every(record => record.status === 'complete'), true);
});

test('MIMESIS UserData reaches actual runtime preparation, loader setup, launch and download history', async t => {
  const f = await fixture(t);
  const gameId = 'mimesis';
  const profileId = 'mimesis-default';
  const refs = [loaderFor(gameId), PLUGIN];
  const initial = { 'Nested/preferences.cfg': 'Crew = café ☕\n' };
  assert.equal(await f.invoke('prepare-profile', profileId, refs, 'MIMESIS crew', gameId, {}, initial), true);
  const runtime = path.join(f.directory, 'profiles', gameId, profileId, 'runtime');
  assert.equal(await readFile(path.join(runtime, 'UserData', 'Nested', 'preferences.cfg'), 'utf8'), initial['Nested/preferences.cfg']);
  assert.equal(await readFile(path.join(runtime, 'Mods', 'Tests-Example', 'Example.dll'), 'utf8'), 'plugin-mimesis');
  f.statuses.get(gameId).loader = 'clean';
  const setupFiles = { ...initial, 'setup.cfg': 'Set during setup' };
  assert.equal((await f.invoke('setup-loader', profileId, refs, 'MIMESIS crew', gameId, {}, setupFiles)).loader, 'managed');
  assert.equal(await readFile(path.join(runtime, 'UserData', 'setup.cfg'), 'utf8'), setupFiles['setup.cfg']);
  const launchedFiles = { ...setupFiles, 'launch.json': '{"enabled":true}' };
  f.statuses.get(gameId).loader = 'managed';
  assert.equal(await f.invoke('launch-game', 'modded', profileId, refs, undefined, 'MIMESIS crew', gameId, {}, launchedFiles), true);
  assert.equal(await readFile(path.join(runtime, 'UserData', 'launch.json'), 'utf8'), launchedFiles['launch.json']);
  const launch = f.calls.filter(call => call.method === 'launch').at(-1);
  assert.equal(launch.gameId, gameId);
  assert.equal(launch.input.profilePath, runtime);
  assert.equal(f.history.list().length, 3);
  assert(f.history.list().every(record => record.gameId === gameId && record.profileId === profileId && record.status === 'complete'));
  assert(f.history.list().every(record => record.packages.some(item => item.name === 'MelonLoader')));
  assert(f.downloads.every(input => input.gameId === gameId && input.name !== 'BepInExPack'));
  const before = f.downloads.length;
  f.advanceTime(30_001);
  await f.invoke('launch-game', 'vanilla', profileId, refs, undefined, 'MIMESIS crew', gameId, {}, { '../invalid.cfg': 'ignored in vanilla' });
  assert.equal(f.downloads.length, before);
  assert.equal(f.calls.filter(call => call.method === 'launch').at(-1).input.profilePath, undefined);
});

test('invalid MIMESIS UserData cannot download packages, launch or partially replace a prepared runtime', async t => {
  const f = await fixture(t);
  const refs = [loaderFor('mimesis')];
  const profileId = 'mimesis-default';
  await f.invoke('prepare-profile', profileId, refs, 'MIMESIS', 'mimesis', {}, { 'keep.cfg': 'preserve' });
  const before = f.downloads.length;
  await assert.rejects(f.invoke('prepare-profile', profileId, refs, 'MIMESIS', 'mimesis', {}, { '../escape.cfg': 'x' }), /configuration/);
  await assert.rejects(f.invoke('launch-game', 'modded', profileId, refs, 'fingerprint-mimesis', 'MIMESIS', 'mimesis', {}, { 'run.dll': 'x' }), /configuration/);
  assert.equal(f.downloads.length, before);
  assert.equal(f.calls.some(call => call.method === 'launch'), false);
  assert.equal(await readFile(path.join(f.directory, 'profiles', 'mimesis', profileId, 'runtime', 'UserData', 'keep.cfg'), 'utf8'), 'preserve');
  assert(f.history.list().every(record => record.status === 'complete'));
});

test('setup and removal route to the selected game with the real prepared runtime', async t => {
  const f = await fixture(t);
  for (const gameId of GAME_IDS) {
    f.statuses.get(gameId).loader = 'clean';
    const result = await f.invoke('setup-loader', `${gameId}-default`, [loaderFor(gameId)], 'Default', gameId);
    assert.equal(result.loader, 'managed');
    const setup = f.calls.filter(call => call.method === 'setup').at(-1);
    assert.equal(setup.gameId, gameId);
    assert.equal(setup.input.loaderPath, path.join(f.directory, 'profiles', gameId, `${gameId}-default`, 'runtime'));
    f.statuses.get(gameId).loader = 'managed';
    assert.equal((await f.invoke('remove-loader', gameId)).loader, 'clean');
    assert.deepEqual(f.calls.filter(call => call.method === 'remove').at(-1), {
      gameId, method: 'remove', input: f.statuses.get(gameId).gameDir,
    });
  }
});

test('loader setup, modded launch, and opening the profile use the replacement for a locked runtime', async t => {
  const gameId = 'lethal-company';
  const profileId = `${gameId}-default`;
  let lockedRuntime;
  const f = await fixture(t, (root, cache, options) => createProfileBuilder(root, cache, {
    ...options,
    retryDelay: async () => {},
    renamePath: async (source, target) => {
      if (source === lockedRuntime) throw Object.assign(new Error('Windows sharing violation'), { code: 'EPERM' });
      await rename(source, target);
    },
  }));
  const loader = loaderFor(gameId);
  await f.invoke('prepare-profile', profileId, [loader], 'Default', gameId);
  lockedRuntime = path.join(f.directory, 'profiles', gameId, profileId, 'runtime');
  const configFile = 'BepInEx/config/BepInEx.cfg';
  await writeFile(path.join(lockedRuntime, configFile), 'Edited locally');

  f.statuses.get(gameId).loader = 'clean';
  await f.invoke('setup-loader', profileId, [loader, PLUGIN], 'Default', gameId);
  const replacement = f.calls.find(call => call.method === 'setup').input.loaderPath;
  assert.notEqual(replacement, lockedRuntime);
  assert.equal(await readFile(path.join(replacement, configFile), 'utf8'), 'Edited locally');

  f.statuses.get(gameId).loader = 'managed';
  await f.invoke('launch-game', 'modded', profileId, [loader, PLUGIN], undefined, 'Default', gameId);
  assert.equal(f.calls.find(call => call.method === 'launch').input.profilePath, replacement);
  await f.invoke('open-profile', profileId, gameId);
  assert.equal(f.opened.at(-1), replacement);
  assert(f.history.list().every(record => record.status === 'complete'));
});

test('the native busy lock excludes another game while real profile downloads are preparing', async t => {
  const f = await fixture(t);
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.blockDownload(async () => { enter(); await blocked; });
  const pending = f.invoke('prepare-profile', 'peak-default', [loaderFor('peak')], 'Default', 'peak');
  await entered;
  assert.equal(f.actions.isBusy(), true);
  await assert.rejects(f.invoke('prepare-profile', 'repo-default', [loaderFor('repo')], 'Default', 'repo'), /already being prepared/);
  await assert.rejects(f.invoke('launch-game', 'vanilla', 'repo-default', [], undefined, 'Default', 'repo'), /already being prepared/);
  release();
  assert.equal(await pending, true);
  assert.equal(f.actions.isBusy(), false);
  assert.equal(f.history.list().length, 1);
  assert.equal(f.history.list()[0].status, 'complete');
});

test('invalid game routes and failed archive preparation cannot launch or leave active history', async t => {
  const f = await fixture(t);
  for (const gameId of ['unknown', '../peak', '__proto__']) {
    await assert.rejects(f.invoke('game-status', gameId), /supported game/);
    await assert.rejects(f.invoke('launch-game', 'vanilla', 'peak-default', [], undefined, 'Default', gameId), /supported game/);
    await assert.rejects(f.invoke('prepare-profile', 'peak-default', [], 'Default', gameId), /supported game/);
    assert.equal(f.actions.isBusy(), false);
  }
  await assert.rejects(f.invoke('prepare-profile', 'repo-default', [loaderFor('peak')], 'Default', 'peak'), /valid PEAK profile/);
  const bad = { namespace: 'Tests', name: 'Unsafe', version: '1.0.0' };
  await f.addPackage('peak', bad, [{ name: '../outside.dll', content: 'unsafe' }]);
  await assert.rejects(f.invoke('launch-game', 'modded', 'peak-default', [loaderFor('peak'), bad], 'fingerprint-peak', 'Default', 'peak'), /Could not deploy Unsafe/);
  assert.equal(f.history.list().length, 1);
  assert.equal(f.history.list()[0].status, 'failed');
  assert.equal(f.actions.isBusy(), false);
  assert.equal(f.calls.some(call => call.method === 'launch'), false);
});

test('games already running when Ember starts report live status and block another launch or profile changes', async t => {
  const f = await fixture(t);
  for (const gameId of GAME_IDS) {
    f.setRunning(gameId, true, 2);
    const initial = await f.invoke('game-status', gameId);
    assert.equal(initial.running, true);
    assert.equal(initial.launchPending, false);
    assert.equal(initial.processCount, 2);
    const refs = [loaderFor(gameId)];
    await assert.rejects(f.invoke('launch-game', 'vanilla', `${gameId}-default`, [], undefined, 'Default', gameId), /already running/);
    await assert.rejects(f.invoke('prepare-profile', `${gameId}-default`, refs, 'Default', gameId), /already running/);
    f.statuses.get(gameId).loader = 'clean';
    await assert.rejects(f.invoke('setup-loader', `${gameId}-default`, refs, 'Default', gameId), /already running/);
    f.statuses.get(gameId).loader = 'managed';
    await assert.rejects(f.invoke('remove-loader', gameId), /already running/);
    f.setRunning(gameId, false);
    const stopped = await f.invoke('game-status', gameId);
    assert.equal(stopped.running, false);
    assert.equal(stopped.launchPending, false);
    assert.equal(stopped.processCount, 0);
  }
  assert.deepEqual(f.downloads, []);
  assert.equal(f.calls.some(call => call.method === 'launch' || call.method === 'setup' || call.method === 'remove'), false);
});

test('a launch moves through pending, running and stopped states without duplicate Steam requests', async t => {
  const f = await fixture(t);
  const gameId = 'mimesis';
  const launch = () => f.invoke('launch-game', 'vanilla', 'mimesis-default', [], undefined, 'Default', gameId);
  const initial = await f.invoke('game-status', gameId);
  assert.equal(initial.running, false);
  assert.equal(initial.launchPending, false);
  assert.equal(await launch(), true);
  const pending = await f.invoke('game-running-status', gameId);
  assert.equal(pending.running, false);
  assert.equal(pending.launchPending, true);
  assert.equal(f.actions.isBusy(), true);
  await assert.rejects(launch(), /is starting/);
  await assert.rejects(f.invoke('prepare-profile', 'mimesis-default', [loaderFor(gameId)], 'Default', gameId), /is starting/);
  const other = await f.invoke('game-status', 'repo');
  assert.equal(other.launchPending, false, 'launch state stays with the selected game');
  f.setRunning(gameId, true);
  const running = await f.invoke('game-running-status', gameId);
  assert.equal(running.running, true);
  assert.equal(running.launchPending, false);
  assert.equal(f.actions.isBusy(), false, 'the pending lock ends when Windows observes the game');
  await assert.rejects(launch(), /already running/);
  f.setRunning(gameId, false);
  const stopped = await f.invoke('game-running-status', gameId);
  assert.equal(stopped.running, false);
  assert.equal(stopped.launchPending, false);
  assert.equal(await launch(), true);
  assert.equal(f.calls.filter(call => call.method === 'launch').length, 2);
});

test('lightweight running-status polling avoids Steam directory and loader inspection', async t => {
  const f = await fixture(t);
  f.setRunning('mimesis', true, 2);
  assert.deepEqual(await f.invoke('game-running-status', 'mimesis'), {
    gameId: 'mimesis', running: true, launchPending: false, processCount: 2,
  });
  assert.deepEqual(f.calls.map(call => call.method), ['running']);
  for (const gameId of ['unknown', '../peak', '__proto__']) {
    await assert.rejects(f.invoke('game-running-status', gameId), /supported game/);
  }
});

test('an unobserved launch expires after 30 seconds so users can retry', async t => {
  const f = await fixture(t);
  const launch = () => f.invoke('launch-game', 'vanilla', 'repo-default', [], undefined, 'Default', 'repo');
  await launch();
  f.advanceTime(29_999);
  assert.equal((await f.invoke('game-status', 'repo')).launchPending, true);
  await assert.rejects(launch(), /is starting/);
  f.advanceTime(1);
  assert.equal((await f.invoke('game-status', 'repo')).launchPending, false);
  assert.equal(f.actions.isBusy(), false);
  assert.equal(await launch(), true);
  assert.equal(f.calls.filter(call => call.method === 'launch').length, 2);
});

test('failed Steam dispatch clears launch-pending immediately and allows a clean retry', async t => {
  const f = await fixture(t);
  const launch = () => f.invoke('launch-game', 'vanilla', 'repo-default', [], undefined, 'Default', 'repo');
  f.failLaunch(new Error('Steam could not start'));
  await assert.rejects(launch(), /Steam could not start/);
  assert.equal((await f.invoke('game-status', 'repo')).launchPending, false);
  assert.equal(f.actions.isBusy(), false);
  f.failLaunch(null);
  assert.equal(await launch(), true);
  assert.equal((await f.invoke('game-status', 'repo')).launchPending, true);
});

test('launch-pending is visible while Steam dispatch is still completing and concurrent requests remain locked', async t => {
  const f = await fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.blockLaunch(async () => { entered(); await gate; });
  const pending = f.invoke('launch-game', 'vanilla', 'repo-default', [], undefined, 'Default', 'repo');
  await started;
  assert.equal((await f.invoke('game-status', 'repo')).launchPending, true);
  await assert.rejects(f.invoke('launch-game', 'vanilla', 'repo-default', [], undefined, 'Default', 'repo'), /already being prepared/);
  release();
  assert.equal(await pending, true);
  assert.equal(f.calls.filter(call => call.method === 'launch').length, 1);
});
