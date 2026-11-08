const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { setImmediate: tick } = require('node:timers/promises');
const { createClientUpdates, isNewerVersion } = require('../electron/client-updates.cjs');

function mockUpdater() {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.installs = [];
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('checking-for-update');
    updater.emit('update-not-available', { version: '0.5.0' });
    return { updateInfo: { version: '0.5.0' } };
  };
  updater.quitAndInstall = (...args) => updater.installs.push(args);
  return updater;
}

function options(updater, extra = {}) { return { updater, version: '0.5.0', ...extra }; }

test('installed updater uses verified library downloads and defensive status snapshots', () => {
  const updater = mockUpdater();
  const client = createClientUpdates(options(updater, { publish: state => { state.latestVersion = 'mutated'; } }));
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  updater.emit('update-available', { version: '0.5.1', releaseNotes: '<script>no</script>' });
  const snapshot = client.getStatus();
  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.latestVersion, '0.5.1');
  assert.equal(snapshot.releaseNotes, undefined);
  snapshot.message = 'overwritten';
  assert.notEqual(client.getStatus().message, snapshot.message);
  client.dispose();
});

test('concurrent manual checks coalesce and only a server no-update event reports up-to-date', async () => {
  const updater = mockUpdater();
  let resolve;
  updater.checkForUpdates = () => {
    updater.checks++;
    return new Promise(done => { resolve = done; });
  };
  const client = createClientUpdates(options(updater));
  const first = client.checkForUpdates();
  const second = client.checkForUpdates();
  assert.equal(first, second);
  await tick();
  assert.equal(updater.checks, 1);
  assert.equal(client.getStatus().status, 'checking');
  updater.emit('update-not-available');
  resolve({ updateInfo: { version: '0.5.0' } });
  assert.equal((await first).status, 'up-to-date');
  updater.checkForUpdates = async () => { updater.checks++; updater.emit('update-not-available'); return {}; };
  assert.equal((await client.checkForUpdates()).status, 'up-to-date');
  assert.equal(updater.checks, 2);
});

test('manual available update progresses to ready and installs only when explicitly requested', async () => {
  const updater = mockUpdater();
  const events = [];
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('update-available', { version: '0.5.1' });
    return { downloadPromise: Promise.resolve([]) };
  };
  let prepared = 0;
  const client = createClientUpdates(options(updater, { publish: state => events.push(state), beforeInstall: () => { prepared++; } }));
  await client.checkForUpdates();
  updater.emit('download-progress', { percent: 52.5, transferred: 525, total: 1000, bytesPerSecond: 42 });
  assert.deepEqual(client.getStatus().progress, { percent: 52.5, transferred: 525, total: 1000, bytesPerSecond: 42 });
  updater.emit('update-downloaded', { version: '0.5.1' });
  await tick();
  assert.equal(client.getStatus().status, 'downloaded');
  assert.equal(updater.installs.length, 0);
  await client.checkForUpdates();
  assert.equal(updater.checks, 1);
  await Promise.all([client.installUpdate(), client.installUpdate()]);
  assert.equal(prepared, 1);
  assert.deepEqual(updater.installs, [[true, true]]);
  assert.equal(client.getStatus().status, 'installing');
  assert.equal(events.at(-1).status, 'installing');
});

test('startup checks automatically install a downloaded update only after the safety check', async () => {
  const updater = mockUpdater();
  const calls = [];
  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '0.5.1' });
    return {};
  };
  const client = createClientUpdates(options(updater, {
    canInstall: async () => { calls.push('safe'); return true; },
    beforeInstall: () => { calls.push('reserve'); },
  }));
  await client.checkForUpdates({ automatic: true });
  updater.emit('update-downloaded', { version: '0.5.1' });
  await tick();
  assert.deepEqual(calls, ['safe', 'reserve']);
  assert.deepEqual(updater.installs, [[true, true]]);
});

test('the manual Update client action downloads and silently restarts without a second install click', async () => {
  const updater = mockUpdater();
  const contexts = [];
  let reservations = 0;
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.1' }); return {}; };
  const client = createClientUpdates(options(updater, {
    beforeInstall: context => contexts.push(context),
    reserveAutomaticInstall: () => { reservations++; return false; },
  }));
  await client.checkForUpdates({ installWhenReady: true });
  assert.deepEqual(updater.installs, []);
  updater.emit('update-downloaded', { version: '0.5.1' });
  await tick();
  assert.equal(client.getStatus().status, 'installing');
  assert.deepEqual(updater.installs, [[true, true]]);
  assert.deepEqual(contexts, [{ automatic: false, fromVersion: '0.5.0', toVersion: '0.5.1' }]);
  assert.equal(reservations, 0, 'An explicit manual request does not consume or require startup restart reservations.');
});

test('manual updates wait for active work to finish and retry silently through the existing timer hook', async () => {
  const updater = mockUpdater();
  let safe = false;
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.1' }); return {}; };
  const client = createClientUpdates(options(updater, { canInstall: () => safe }));
  await client.checkForUpdates({ installWhenReady: true });
  updater.emit('update-downloaded', { version: '0.5.1' });
  await tick();
  assert.equal(client.getStatus().installBlocked, true);
  assert.match(client.getStatus().message, /restart when ready/);
  assert.deepEqual(updater.installs, []);
  safe = true;
  await Promise.all([client.retryAutomaticInstall(), client.retryAutomaticInstall()]);
  assert.deepEqual(updater.installs, [[true, true]]);
});

test('manual Update client installs a previously downloaded update without another network check', async () => {
  const updater = mockUpdater();
  const client = createClientUpdates(options(updater));
  updater.emit('update-downloaded', { version: '0.5.1' });
  await Promise.all([client.checkForUpdates({ installWhenReady: true }), client.checkForUpdates({ installWhenReady: true })]);
  assert.equal(updater.checks, 0);
  assert.deepEqual(updater.installs, [[true, true]]);
});

test('manual update intent can join an in-progress download and retry a suppressed startup update', async () => {
  const updater = mockUpdater();
  let reservations = 0;
  updater.checkForUpdates = async () => { updater.checks++; updater.emit('update-available', { version: '0.5.1' }); return {}; };
  const client = createClientUpdates(options(updater, { reserveAutomaticInstall: () => { reservations++; return false; } }));
  await client.checkForUpdates({ automatic: true });
  await client.checkForUpdates({ installWhenReady: true });
  updater.emit('update-downloaded', { version: '0.5.1' });
  await tick();
  assert.equal(updater.checks, 1, 'The manual action joins the existing download without another metadata request.');
  assert.equal(reservations, 0);
  assert.deepEqual(updater.installs, [[true, true]]);

  const second = mockUpdater();
  second.checkForUpdates = async () => { second.emit('update-available', { version: '0.5.1' }); return {}; };
  const paused = createClientUpdates(options(second, { reserveAutomaticInstall: () => false }));
  await paused.checkForUpdates({ automatic: true });
  second.emit('update-downloaded', { version: '0.5.1' });
  await tick();
  assert.equal(paused.getStatus().installBlocked, true);
  await paused.checkForUpdates({ installWhenReady: true });
  assert.deepEqual(second.installs, [[true, true]]);
});

test('cancelled, failed, and no-update checks cannot leave a manual restart intent armed', async () => {
  for (const terminal of ['update-cancelled', 'error', 'update-not-available']) {
    const updater = mockUpdater();
    updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.1' }); return {}; };
    const client = createClientUpdates(options(updater));
    await client.checkForUpdates({ installWhenReady: true });
    updater.emit(terminal, new Error('network connection failed'));
    updater.emit('update-downloaded', { version: '0.5.1' });
    await tick();
    await client.retryAutomaticInstall();
    assert.deepEqual(updater.installs, [], terminal);
    assert.equal(client.getStatus().status, 'downloaded');
    client.dispose();
  }
});

test('failed manual installer handoffs stop background retries while another explicit update click can retry', async () => {
  const updater = mockUpdater();
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.1' }); return {}; };
  let attempts = 0;
  updater.quitAndInstall = () => { attempts++; throw new Error('Native installer failed'); };
  const client = createClientUpdates(options(updater));
  await client.checkForUpdates({ installWhenReady: true });
  updater.emit('update-downloaded', { version: '0.5.1' });
  await tick();
  assert.equal(attempts, 1);
  assert.equal(client.getStatus().status, 'downloaded');
  await client.retryAutomaticInstall();
  assert.equal(attempts, 1);
  updater.quitAndInstall = (...args) => updater.installs.push(args);
  await client.checkForUpdates({ installWhenReady: true });
  assert.deepEqual(updater.installs, [[true, true]]);
});

test('the installed NSIS adapter receives silent and force-run flags for the manual update flow', async () => {
  const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
  const updater = mockUpdater();
  const spawned = [];
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.1' }); return {}; };
  const native = {
    installerPath: 'C:\\test-only\\Ember-Setup.exe',
    installDirectory: 'C:\\test-only\\Ember',
    downloadedUpdateHelper: null,
    spawnLog: async (file, args) => { spawned.push({ file, args }); },
    dispatchError: error => assert.fail(error.message),
  };
  updater.quitAndInstall = (isSilent, isForceRunAfter) => NsisUpdater.prototype.doInstall.call(native, { isSilent, isForceRunAfter, isAdminRightsRequired: false });
  const client = createClientUpdates(options(updater));
  await client.checkForUpdates({ installWhenReady: true });
  updater.emit('update-downloaded', { version: '0.5.1' });
  await tick();
  assert.deepEqual(spawned, [{ file: native.installerPath, args: ['--updated', '/S', '--force-run', '/D=C:\\test-only\\Ember'] }]);
  assert.equal(client.getStatus().status, 'installing');
});

test('busy or running-game guards preserve the ready update and allow a later safe retry', async () => {
  for (const denied of [() => false, () => undefined, () => { throw new Error('Game is running'); }]) {
    const updater = mockUpdater();
    updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.1' }); return {}; };
    let guard = denied;
    let prepared = 0;
    const client = createClientUpdates(options(updater, { canInstall: () => guard(), beforeInstall: () => { prepared++; } }));
    await client.checkForUpdates({ automatic: true });
    updater.emit('update-downloaded', { version: '0.5.1' });
    await tick();
    assert.equal(client.getStatus().status, 'downloaded');
    assert.equal(client.getStatus().installBlocked, true);
    assert.equal(updater.installs.length, 0);
    assert.equal(prepared, 0);
    await client.installUpdate();
    assert.equal(updater.installs.length, 0);
    guard = () => true;
    await client.installUpdate();
    assert.equal(prepared, 1);
    assert.deepEqual(updater.installs, [[true, true]]);
  }
});

test('portable and development builds never query or install updates', async () => {
  for (const extra of [{ portable: true }, { enabled: false }]) {
    const updater = mockUpdater();
    const client = createClientUpdates(options(updater, extra));
    assert.equal((await client.checkForUpdates({ automatic: true })).status, 'unsupported');
    await client.installUpdate();
    assert.equal(updater.checks, 0);
    assert.deepEqual(updater.installs, []);
    assert.equal(updater.listenerCount('update-downloaded'), 0);
    client.dispose();
  }
});

test('automatic retry installs after busy work ends without installing manually downloaded updates', async () => {
  for (const automatic of [true, false]) {
    const updater = mockUpdater();
    updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.1' }); return {}; };
    let safe = false;
    const client = createClientUpdates(options(updater, { canInstall: () => safe }));
    await client.checkForUpdates({ automatic });
    updater.emit('update-downloaded', { version: '0.5.1' });
    await tick();
    assert.equal(updater.installs.length, 0);
    safe = true;
    await client.retryAutomaticInstall();
    assert.deepEqual(updater.installs, automatic ? [[true, true]] : []);
    if (!automatic) assert.equal(client.getStatus().status, 'downloaded');
  }
});

test('startup retry survives a reservation race but stops automatically retrying a failed installer launch', async () => {
  const updater = mockUpdater();
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.1' }); return {}; };
  let reserve = false;
  const client = createClientUpdates(options(updater, { beforeInstall: () => { if (!reserve) throw new Error('Work started meanwhile'); } }));
  await client.checkForUpdates({ automatic: true });
  updater.emit('update-downloaded', { version: '0.5.1' });
  await tick();
  assert.equal(client.getStatus().status, 'downloaded');
  assert.equal(client.getStatus().installBlocked, true);
  reserve = true;
  updater.quitAndInstall = () => { updater.installs.push('attempt'); throw new Error('Installer could not start'); };
  await client.retryAutomaticInstall();
  assert.deepEqual(updater.installs, ['attempt']);
  await client.retryAutomaticInstall();
  assert.deepEqual(updater.installs, ['attempt']);
  updater.quitAndInstall = (...args) => updater.installs.push(args);
  await client.installUpdate();
  assert.deepEqual(updater.installs, ['attempt', [true, true]]);
});

test('missing first release and network failures are retryable and never claim up-to-date', async () => {
  const updater = mockUpdater();
  let error = new Error('404 latest.yml not found');
  updater.checkForUpdates = async () => { throw error; };
  const client = createClientUpdates(options(updater));
  assert.match((await client.checkForUpdates()).message, /No published client update/);
  assert.equal(client.getStatus().status, 'error');
  error = Object.assign(new Error('private internal details'), { code: 'ENOTFOUND' });
  assert.match((await client.checkForUpdates()).message, /Check your connection/);
  updater.checkForUpdates = async () => { updater.emit('update-not-available'); return {}; };
  assert.equal((await client.checkForUpdates()).status, 'up-to-date');
});

test('auto-download promise rejections are observed and verification failures remain visible', async () => {
  const updater = mockUpdater();
  let reject;
  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '0.5.1' });
    return { downloadPromise: new Promise((_, fail) => { reject = fail; }) };
  };
  const client = createClientUpdates(options(updater));
  await client.checkForUpdates({ automatic: true });
  reject(new Error('sha512 checksum mismatch, secret URL omitted'));
  await tick();
  assert.equal(client.getStatus().status, 'error');
  assert.match(client.getStatus().message, /did not pass verification/);
  assert.equal(client.getStatus().message.includes('secret URL'), false);
  assert.equal(updater.installs.length, 0);
});

test('progress values are bounded and invalid metadata never initiates installation', async () => {
  const updater = mockUpdater();
  const client = createClientUpdates(options(updater));
  updater.emit('download-progress', { percent: Infinity, transferred: -1, total: NaN, bytesPerSecond: 1e25 });
  assert.deepEqual(client.getStatus().progress, { percent: 0, transferred: 0, total: 0, bytesPerSecond: Number.MAX_SAFE_INTEGER });
  updater.emit('download-progress', { percent: 200, transferred: 2.9, total: 3.9, bytesPerSecond: -1 });
  assert.deepEqual(client.getStatus().progress, { percent: 100, transferred: 2, total: 3, bytesPerSecond: 0 });
  updater.emit('update-downloaded', { version: '<b>bad</b>' });
  await client.installUpdate();
  assert.equal(client.getStatus().status, 'error');
  assert.equal(updater.installs.length, 0);
});

test('failed pre-install reservation never starts the installer, and disposal drops later events', async () => {
  const updater = mockUpdater();
  const events = [];
  const client = createClientUpdates(options(updater, { publish: status => events.push(status), beforeInstall: () => { throw new Error('Busy'); } }));
  updater.emit('update-downloaded', { version: '0.5.1' });
  await client.installUpdate();
  assert.equal(client.getStatus().status, 'downloaded');
  assert.equal(client.getStatus().installBlocked, true);
  assert.equal(updater.installs.length, 0);
  const before = client.getStatus();
  const count = events.length;
  client.dispose();
  updater.emit('update-downloaded', { version: '0.5.2' });
  assert.deepEqual(await client.checkForUpdates(), before);
  assert.deepEqual(await client.installUpdate(), before);
  assert.equal(events.length, count);
  assert.equal(updater.listenerCount('update-downloaded'), 0);
});

test('SemVer comparison orders numeric components correctly and ignores build metadata', () => {
  for (const [newer, older] of [['0.5.10', '0.5.9'], ['0.10.0', '0.9.99'], ['1.0.0', '1.0.0-rc.1'],
    ['1.0.0-rc.10', '1.0.0-rc.9'], ['1.0.0-beta', '1.0.0-alpha'], ['1.0.0-alpha.1', '1.0.0-alpha'],
    ['1.0.0-alpha.beta', '1.0.0-alpha.1']]) {
    assert.equal(isNewerVersion(newer, older), true, `${newer} > ${older}`);
    assert.equal(isNewerVersion(older, newer), false, `${older} is not > ${newer}`);
  }
  assert.equal(isNewerVersion('0.5.2+new', '0.5.2+old'), false);
  for (const invalid of ['01.0.0', '1.0.0-01', '1.0.0-rc..1', '1.0.0+', 'not-a-version']) {
    assert.equal(isNewerVersion(invalid, '0.0.0'), false);
  }
});

test('same-version and older cached events can never launch an installer, automatically or manually', async () => {
  for (const candidate of ['0.5.0', '0.4.99', '0.5.0+rebuilt']) {
    const updater = mockUpdater();
    updater.checkForUpdates = async () => { updater.emit('update-available', { version: candidate }); return {}; };
    let reserved = 0;
    let before = 0;
    const client = createClientUpdates(options(updater, {
      reserveAutomaticInstall: () => { reserved++; return true; }, beforeInstall: () => { before++; },
    }));
    await client.checkForUpdates({ automatic: true });
    updater.emit('update-downloaded', { version: candidate });
    await tick();
    await client.retryAutomaticInstall();
    await client.installUpdate();
    assert.deepEqual(updater.installs, []);
    assert.equal(reserved, 0);
    assert.equal(before, 0);
    assert.equal(client.getStatus().latestVersion, null);
  }
});

test('an invalidated payload cannot install after an asynchronous game safety check', async () => {
  const updater = mockUpdater();
  let resolve;
  let before = 0;
  const client = createClientUpdates(options(updater, {
    canInstall: () => new Promise(done => { resolve = done; }), beforeInstall: () => { before++; },
  }));
  updater.emit('update-downloaded', { version: '0.5.1' });
  const pending = client.installUpdate();
  await tick();
  updater.emit('update-downloaded', { version: '0.5.0' });
  resolve(true);
  await pending;
  assert.deepEqual(updater.installs, []);
  assert.equal(before, 0);
});

test('automatic reservation failures stop background retries while explicit manual installation remains available', async () => {
  for (const reserve of [() => false, () => { throw new Error('Disk unavailable'); }]) {
    const updater = mockUpdater();
    updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.1' }); return {}; };
    let reservations = 0;
    const contexts = [];
    const client = createClientUpdates(options(updater, {
      reserveAutomaticInstall: context => { reservations++; assert.deepEqual(context, { fromVersion: '0.5.0', toVersion: '0.5.1' }); return reserve(); },
      beforeInstall: context => { contexts.push(context); },
    }));
    await client.checkForUpdates({ automatic: true });
    updater.emit('update-downloaded', { version: '0.5.1' });
    await tick();
    assert.equal(client.getStatus().status, 'downloaded');
    assert.equal(client.getStatus().installBlocked, true);
    assert.match(client.getStatus().message, /previous update restart/);
    await client.retryAutomaticInstall();
    assert.equal(reservations, 1);
    assert.deepEqual(updater.installs, []);
    await client.installUpdate();
    assert.deepEqual(updater.installs, [[true, true]]);
    assert.equal(reservations, 1);
    assert.deepEqual(contexts, [{ automatic: false, fromVersion: '0.5.0', toVersion: '0.5.1' }]);
  }
});

test('automatic attempts are reserved only after safety and rolled back if the native work lock becomes busy', async () => {
  const updater = mockUpdater();
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.1' }); return {}; };
  let safe = false;
  let race = true;
  const calls = [];
  const client = createClientUpdates(options(updater, {
    canInstall: () => { calls.push('safe'); return safe; },
    reserveAutomaticInstall: () => { calls.push('reserve'); return true; },
    releaseAutomaticInstall: () => { calls.push('release'); },
    beforeInstall: context => { calls.push('before'); assert.equal(context.automatic, true); if (race) throw new Error('Work began'); },
  }));
  await client.checkForUpdates({ automatic: true });
  updater.emit('update-downloaded', { version: '0.5.1' });
  await tick();
  assert.deepEqual(calls, ['safe']);
  safe = true;
  await client.retryAutomaticInstall();
  assert.deepEqual(calls, ['safe', 'safe', 'reserve', 'before', 'release']);
  race = false;
  await client.retryAutomaticInstall();
  assert.deepEqual(updater.installs, [[true, true]]);
  assert.deepEqual(calls.slice(-3), ['safe', 'reserve', 'before']);
});
