const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const { lstat, readdir, readFile, realpath, open, unlink, mkdtemp, rename, copyFile, rmdir } = require('node:fs/promises');
const { createGameFileManager } = require('./game-files.cjs');

const exec = promisify(execFile);
// Each launcher is bound to one Steam app. Never infer the game from a supplied path.
const SUPPORTED_GAMES = Object.freeze({
  'lethal-company': Object.freeze({ id: 'lethal-company', name: 'Lethal Company', steamId: '1966720', executable: 'Lethal Company.exe', dataDirectory: 'Lethal Company_Data' }),
  repo: Object.freeze({ id: 'repo', name: 'R.E.P.O.', steamId: '3241660', executable: 'REPO.exe', dataDirectory: 'REPO_Data' }),
  peak: Object.freeze({ id: 'peak', name: 'PEAK', steamId: '3527290', executable: 'PEAK.exe', dataDirectory: 'PEAK_Data' }),
  mimesis: Object.freeze({ id: 'mimesis', name: 'MIMESIS', steamId: '2827200', executable: 'MIMESIS.exe', dataDirectory: 'MIMESIS_Data' }),
});

function supportedGame(gameId) {
  if (!Object.hasOwn(SUPPORTED_GAMES, gameId)) throw new Error('Choose a supported game.');
  return SUPPORTED_GAMES[gameId];
}
const PROXY = 'winhttp.dll';
const INI = 'doorstop_config.ini';
const VERSION_FILE = '.doorstop_version';
const OWNERSHIP_FILE = '.modspindle-doorstop.json';
const ROOT_FILES = [PROXY, INI, VERSION_FILE, OWNERSHIP_FILE];
const OTHER_PROXIES = ['version.dll', 'dxgi.dll', 'dinput8.dll', 'd3d11.dll', 'winmm.dll', 'dsound.dll'];
const OTHER_LOADERS = ['melonloader', 'ue4ss', 'bepinex', 'bepinexpack', '.thunderstoremm'];
const PRELOADER = ['BepInEx', 'core', 'BepInEx.Preloader.dll'];
const SETUP_LIMIT = 2 * 1024 * 1024;
const MELON_OWNERSHIP = '.ember-melonloader.json';

function isLocalPath(value) {
  return typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) && !value.includes('\0');
}

async function info(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function readSmall(file, maximum = SETUP_LIMIT) {
  const metadata = await info(file);
  if (!metadata?.isFile() || metadata.size > maximum) return null;
  return readFile(file);
}

function absoluteKey(value) {
  return path.resolve(value).toLowerCase();
}

function systemExecutable(name) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
}

async function steamRoots() {
  const registryKeys = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];
  const values = await Promise.all(registryKeys.map(async ([key, value]) => {
    try {
      const { stdout } = await exec(systemExecutable('reg.exe'), ['query', key, '/v', value], { windowsHide: true, timeout: 4000 });
      return /^\s*\S+\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im.exec(stdout)?.[1].trim();
    } catch {
      return null;
    }
  }));
  for (const key of ['ProgramFiles(x86)', 'ProgramFiles']) {
    if (process.env[key]) values.push(path.join(process.env[key], 'Steam'));
  }
  return values.filter(isLocalPath);
}

async function installedGames(findRoots, game) {
  const installs = new Map();
  for (const root of await findRoots()) {
    if (!isLocalPath(root)) continue;
    const steamExe = path.join(root, 'Steam.exe');
    if (!(await info(steamExe))?.isFile()) continue;
    const config = (await readSmall(path.join(root, 'steamapps', 'libraryfolders.vdf')))?.toString('utf8') ?? '';
    const libraries = [root, ...Array.from(config.matchAll(/"path"\s+"((?:\\.|[^"\\])+)"/gi), match => match[1].replaceAll('\\\\', '\\'))];
    for (const library of libraries) {
      if (!isLocalPath(library)) continue;
      const manifestFile = path.join(library, 'steamapps', `appmanifest_${game.steamId}.acf`);
      const manifest = (await readSmall(manifestFile))?.toString('utf8') ?? '';
      const appId = /"appid"\s+"(\d+)"/i.exec(manifest)?.[1];
      const installDir = /"installdir"\s+"([^"]+)"/i.exec(manifest)?.[1];
      if (appId !== game.steamId || !installDir || !/^[^<>:"/\\|?*\x00-\x1f]+$/.test(installDir) || /^\.{1,2}$/.test(installDir)) continue;
      const candidate = path.join(library, 'steamapps', 'common', installDir);
      if (!(await info(path.join(candidate, game.executable)))?.isFile() ||
          !(await info(path.join(candidate, game.dataDirectory)))?.isDirectory()) continue;
      const gameDir = await realpath(candidate);
      const key = absoluteKey(gameDir);
      if (!installs.has(key)) installs.set(key, { gameId: game.id, gameDir, steamExe: await realpath(steamExe) });
    }
  }
  return installs;
}

function readIni(content) {
  const sections = new Map();
  let section;
  for (const line of content.split(/\r?\n/)) {
    const label = /^\s*\[([\w]+)\]\s*$/i.exec(line)?.[1];
    if (label) {
      const key = label.toLowerCase();
      if (sections.has(key)) return null;
      section = new Map();
      sections.set(key, section);
    } else if (section) {
      const pair = /^\s*([\w]+)\s*=\s*(.*?)\s*$/i.exec(line);
      if (!pair) continue;
      const key = pair[1].toLowerCase();
      if (section.has(key)) return null;
      section.set(key, pair[2]);
    }
  }
  return sections;
}

function proxyHasFlag(buffer, flag) {
  return ['utf8', 'utf16le'].some(encoding => buffer.includes(Buffer.from(flag + '\0', encoding)));
}

function isX64Pe(buffer) {
  if (buffer.length < 64 || buffer.readUInt16LE(0) !== 0x5a4d) return false;
  const offset = buffer.readUInt32LE(0x3c);
  return offset <= buffer.length - 6 && buffer.readUInt32LE(offset) === 0x4550 && buffer.readUInt16LE(offset + 4) === 0x8664;
}

async function doorstopFiles(dir, gameId = 'lethal-company') {
  const [proxy, config, version] = await Promise.all([
    readSmall(path.join(dir, PROXY)), readSmall(path.join(dir, INI), 128 * 1024), readSmall(path.join(dir, VERSION_FILE), 64),
  ]);
  if (!proxy || !config || !isX64Pe(proxy) || !proxyHasFlag(proxy, INI)) return null;
  const sections = readIni(config.toString('utf8'));
  const versionText = version?.toString('utf8').trim() ?? '';
  // The official PEAK pack ships its Doorstop fork with this exact version marker.
  const knownVersion4 = /^4\.\d+\.\d+$/.test(versionText) || (gameId === 'peak' && versionText === '4.4.1PEAK');
  const major = sections?.has('general') && !sections.has('unitydoorstop') && knownVersion4 &&
    proxyHasFlag(proxy, '--doorstop-enabled') && proxyHasFlag(proxy, '--doorstop-target-assembly') ? 4
    : sections?.has('unitydoorstop') && !sections.has('general') && !version &&
    proxyHasFlag(proxy, '--doorstop-enable') && proxyHasFlag(proxy, '--doorstop-target') ? 3 : 0;
  if (!major) return null;
  const settings = sections.get(major === 4 ? 'general' : 'unitydoorstop');
  const ignoreDisable = settings.get(major === 4 ? 'ignore_disable_switch' : 'ignoredisableswitch');
  if (!/^(?:true|false)$/i.test(settings.get('enabled') ?? '') ||
      (ignoreDisable !== undefined && !/^(?:true|false)$/i.test(ignoreDisable))) return null;
  return { proxy, config, version, major, ignoresDisable: ignoreDisable?.toLowerCase() === 'true' };
}

async function melonFiles(dir, requireRuntime = false) {
  const proxyNames = [];
  for (const name of ['version.dll', 'winhttp.dll']) if (await info(path.join(dir, name))) proxyNames.push(name);
  if (proxyNames.length !== 1) return null;
  const proxyName = proxyNames[0];
  const proxy = await readSmall(path.join(dir, proxyName), 32 * 1024 * 1024);
  if (!proxy || !isX64Pe(proxy) || !proxy.includes(Buffer.from('--no-mods')) ||
      !['utf8', 'utf16le'].some(encoding => proxy.includes(Buffer.from('MelonLoader', encoding)))) return null;
  const dobbyInfo = await info(path.join(dir, 'dobby.dll'));
  const dobby = dobbyInfo ? await readSmall(path.join(dir, 'dobby.dll'), 32 * 1024 * 1024) : null;
  if (dobbyInfo && (!dobby || !isX64Pe(dobby))) return null;
  if (requireRuntime) {
    if (await info(path.join(dir, ...PRELOADER))) return null;
    for (const framework of ['net35', 'net6']) {
      const assembly = path.join(dir, 'MelonLoader', framework, 'MelonLoader.dll');
      if (!(await info(assembly))?.isFile() || absoluteKey(await realpath(assembly)) !== absoluteKey(assembly)) return null;
    }
  }
  return { proxyName, proxy, dobby };
}

function ownsMelon(marker, files) {
  try {
    const parsed = JSON.parse(marker?.toString('utf8') ?? 'null');
    return parsed?.version === 1 && (parsed.proxyName ?? 'version.dll') === files.proxyName && parsed.proxy === digest(files.proxy) && parsed.dobby === (files.dobby ? digest(files.dobby) : null);
  } catch { return false; }
}

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function ownsFiles(marker, files) {
  if (!marker) return false;
  try {
    const parsed = JSON.parse(marker.toString('utf8'));
    return parsed.version === 1 && parsed.proxy === digest(files.proxy) && parsed.config === digest(files.config) &&
      parsed.doorstopVersion === (files.version ? digest(files.version) : null);
  } catch {
    return false;
  }
}

async function inspectInstall(install) {
  const { gameDir } = install;
  const names = new Set((await readdir(gameDir)).map(name => name.toLowerCase()));
  const base = { ...install, doorstopMajor: null, loaderKind: null, canLaunchVanilla: false };
  const blocked = { ...base, loader: 'unsupported', message: 'This Steam folder contains an unrecognized mod loader. Use a clean installation or a compatible Unity Doorstop setup.' };
  if ((names.has('version.dll') !== names.has(PROXY)) && !names.has('ue4ss') &&
      !OTHER_PROXIES.filter(name => name !== 'version.dll').some(name => names.has(name))) {
    const files = await melonFiles(gameDir);
    if (files) {
    const managed = ownsMelon(await readSmall(path.join(gameDir, MELON_OWNERSHIP), 4096), files);
    return { ...base, loader: managed ? 'managed' : 'existing', loaderKind: 'melonloader', canLaunchVanilla: true,
      loaderFingerprint: digest(JSON.stringify([gameDir.toLowerCase(), digest(files.proxy), files.dobby ? digest(files.dobby) : null])),
      message: managed ? 'The Ember MelonLoader is ready.' : 'A compatible MelonLoader is already installed.' };
    }
  }
  if (OTHER_PROXIES.some(name => names.has(name)) || names.has('melonloader') || names.has('ue4ss') || names.has(MELON_OWNERSHIP)) return blocked;
  if (!ROOT_FILES.some(name => names.has(name))) {
    if (OTHER_LOADERS.some(name => names.has(name))) return blocked;
    return { ...base, loader: 'clean', canLaunchVanilla: true, message: `Set up ${install.gameId === 'mimesis' ? 'MelonLoader' : 'the mod loader'} to launch a modded profile.` };
  }
  const files = await doorstopFiles(gameDir, install.gameId);
  if (!files) return blocked;
  const managed = ownsFiles(await readSmall(path.join(gameDir, OWNERSHIP_FILE), 4096), files);
  return {
    ...base, loader: managed ? 'managed' : 'existing', loaderKind: 'bepinex', doorstopMajor: files.major, canLaunchVanilla: !files.ignoresDisable,
    loaderFingerprint: digest(JSON.stringify([gameDir.toLowerCase(), digest(files.proxy), digest(files.config), files.version ? digest(files.version) : null])),
    message: managed ? 'The Ember loader is ready.' : 'A compatible Unity Doorstop loader is already installed. Choose whether to reuse it.',
  };
}

// Exact Windows executable basenames, also verified against the installed Steam games.
const SUPPORTED_GAME_EXECUTABLES = new Map(Object.values(SUPPORTED_GAMES)
  .map(game => [game.executable.toLowerCase(), game.name]));

async function runningProcesses(run) {
  const { stdout } = await run(systemExecutable('tasklist.exe'), ['/FO', 'CSV', '/NH'], {
    windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024,
  });
  const lines = typeof stdout === 'string' ? stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  const processes = new Map();
  for (const line of lines) {
    const match = /^"([^"\r\n]+)","(\d{1,10})","[^"\r\n]*","\d{1,10}","[^"\r\n]*"$/.exec(line);
    const pid = match && Number(match[2]);
    if (!match || !Number.isSafeInteger(pid) || pid > 0xffffffff) throw new Error('Unreadable process enumeration.');
    const image = match[1].toLowerCase();
    if (processes.has(pid) && processes.get(pid) !== image) throw new Error('Conflicting process enumeration.');
    processes.set(pid, image);
  }
  if (!processes.size) throw new Error('Unreadable process enumeration.');
  return [...processes].map(([pid, image]) => ({ pid, image }));
}

async function runningImages(run) {
  return (await runningProcesses(run)).map(process => process.image);
}

function createGameRunningCheck({ gameId = 'lethal-company', run = exec, platform = process.platform } = {}) {
  const game = supportedGame(gameId);
  return async function getRunningStatus() {
    if (platform !== 'win32') throw new Error('Game process checks are available only on Windows.');
    let processes;
    try { processes = await runningProcesses(run); }
    catch { throw new Error(`Ember could not confirm whether ${game.name} is running.`); }
    const processCount = processes.filter(process => process.image === game.executable.toLowerCase()).length;
    return { running: processCount > 0, processCount };
  };
}

function createGameGuard({ gameId = 'lethal-company', run = exec, platform = process.platform } = {}) {
  const game = supportedGame(gameId);
  return async function assertGameClosed() {
    if (platform !== 'win32') throw new Error('Game process checks are available only on Windows.');
    let names;
    try {
      names = await runningImages(run);
    } catch {
      throw new Error(`Ember could not confirm whether ${game.name} is running.`);
    }
    if (names.includes(game.executable.toLowerCase())) {
      throw new Error(`Close ${game.name} before changing the loader or starting another session.`);
    }
  };
}

function createSupportedGameGuard({ run = exec, platform = process.platform } = {}) {
  return async function assertSupportedGamesClosed() {
    if (platform !== 'win32') throw new Error('Game process checks are available only on Windows.');
    let names;
    try {
      names = await runningImages(run);
    } catch {
      throw new Error('Ember could not confirm whether supported games are running. Close them and try updating again.');
    }
    const running = [...new Set(names.filter(name => SUPPORTED_GAME_EXECUTABLES.has(name)))]
      .map(name => SUPPORTED_GAME_EXECUTABLES.get(name));
    if (running.length) throw new Error(`Close ${running.join(', ')} before installing a client update.`);
  };
}

function spawnSteam(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: path.dirname(executable), shell: false, windowsHide: true, detached: true, stdio: 'ignore',
    });
    child.once('error', () => reject(new Error('Windows could not start Steam. Open Steam and try again.')));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function buildDisabledConfig(files) {
  const [section, key, ignore] = files.major === 4
    ? ['General', 'target_assembly', 'ignore_disable_switch']
    : ['UnityDoorstop', 'targetAssembly', 'ignoreDisableSwitch'];
  const changes = new Map([
    ['enabled', ['enabled', 'false']], [key.toLowerCase(), [key, 'BepInEx\\core\\BepInEx.Preloader.dll']],
    [ignore.toLowerCase(), [ignore, 'false']],
  ]);
  const output = [];
  let inSection = false;
  const appendMissing = () => {
    for (const [name, value] of changes.values()) output.push(`${name}=${value}`);
    changes.clear();
  };
  for (const line of files.config.toString('utf8').split(/\r?\n/)) {
    const label = /^\s*\[([\w]+)\]\s*$/.exec(line)?.[1];
    if (label) {
      if (inSection) appendMissing();
      inSection = label.toLowerCase() === section.toLowerCase();
    }
    const name = inSection && /^\s*([\w]+)\s*=/.exec(line)?.[1].toLowerCase();
    const change = changes.get(name);
    if (change) {
      output.push(`${change[0]}=${change[1]}`);
      changes.delete(name);
    } else output.push(line);
  }
  if (inSection) appendMissing();
  return Buffer.from(output.join('\r\n'), 'utf8');
}

async function installRootFiles(dir, files) {
  const written = new Map();
  try {
    for (const [name, contents] of files) {
      const filename = path.join(dir, name);
      const handle = await open(filename, 'wx');
      try {
        const created = await handle.stat();
        written.set(filename, created);
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    let cleanupFailed = false;
    for (const [filename, created] of [...written].reverse()) {
      try {
        const current = await info(filename);
        if (current?.isFile() && current.dev === created.dev && current.ino === created.ino) await unlink(filename);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new Error('Loader setup stopped. Check the Steam game folder for Ember setup files before trying again.');
    if (error.code === 'EEXIST') throw new Error('Another loader file appeared during setup. Ember did not overwrite it.');
    if (error.code === 'EPERM' || error.code === 'EACCES') throw new Error('Windows denied access to the Steam game folder. Check your Steam library permissions.');
    throw new Error('Ember could not set up the loader in this Steam folder.');
  }
}

async function removeRootFiles(dir, files) {
  const backup = await mkdtemp(path.join(dir, '.modspindle-doorstop-removal-'));
  const moved = [];
  const matches = async (file, expected) => {
    const current = await readSmall(file, expected.length);
    return current?.equals(expected) === true;
  };
  try {
    for (const [name, contents] of files) {
      const source = path.join(dir, name);
      const target = path.join(backup, name);
      if (!(await matches(source, contents))) throw new Error('A loader file changed during removal.');
      await rename(source, target);
      moved.push(name);
      if (!(await matches(target, contents))) throw new Error('A loader file changed during removal.');
    }
    for (const name of moved) {
      if (await info(path.join(dir, name))) throw new Error('Another loader file appeared during removal.');
    }
  } catch {
    let preserved = false;
    for (const name of moved.reverse()) {
      try {
        const source = path.join(backup, name);
        await copyFile(source, path.join(dir, name), constants.COPYFILE_EXCL);
        await unlink(source);
      } catch {
        preserved = true;
      }
    }
    if (!preserved) await rmdir(backup).catch(() => { preserved = true; });
    throw new Error(preserved
      ? `Loader removal stopped. Recovery files are in ${backup}.`
      : 'Loader removal stopped. The Ember files were restored.');
  }
  try {
    for (const [name, contents] of files) {
      const file = path.join(backup, name);
      if (!(await matches(file, contents))) return backup;
      await unlink(file);
    }
    await rmdir(backup);
    return null;
  } catch {
    return backup;
  }
}

function createSteamAdapter({ gameId = 'lethal-company', findRoots = steamRoots, assertClosed, startSteam = spawnSteam, runProcesses = exec, platform = process.platform } = {}) {
  const game = supportedGame(gameId);
  assertClosed ??= createGameGuard({ gameId, run: runProcesses, platform });
  const getRunningStatus = createGameRunningCheck({ gameId, run: runProcesses, platform });
  let operation = false;

  async function getLaunchStatus(gameDir) {
    if (!isLocalPath(gameDir)) throw new Error(`Select a ${game.name} folder in a local Steam library.`);
    const canonical = await realpath(gameDir).catch(() => null);
    const install = canonical && (await installedGames(findRoots, game)).get(absoluteKey(canonical));
    if (!install) throw new Error(`Choose the ${game.name} folder registered in your Steam library.`);
    return inspectInstall(install);
  }

  async function findGame() {
    if (process.platform !== 'win32') return null;
    const [install] = (await installedGames(findRoots, game)).values();
    return install ? inspectInstall(install) : null;
  }

  async function exclusive(callback) {
    if (operation) throw new Error(`A ${game.name} setup or launch is already in progress.`);
    operation = true;
    try {
      return await callback();
    } finally {
      operation = false;
    }
  }

  async function prepareDoorstop({ gameDir, loaderPath }) {
    return exclusive(async () => {
      const status = await getLaunchStatus(gameDir);
      if (status.loader === 'managed') return status;
      if (status.loader !== 'clean') throw new Error('This Steam folder already contains loader files. Choose reuse for a compatible loader.');
      const canonical = isLocalPath(loaderPath) && await realpath(loaderPath).catch(() => null);
      const melon = canonical && await melonFiles(canonical, true);
      if (melon) {
        await assertClosed();
        const marker = Buffer.from(JSON.stringify({ version: 1, proxyName: melon.proxyName, proxy: digest(melon.proxy), dobby: melon.dobby ? digest(melon.dobby) : null }) + '\n');
        const files = [[MELON_OWNERSHIP, marker]];
        if (melon.dobby) files.push(['dobby.dll', melon.dobby]);
        files.push([melon.proxyName, melon.proxy]);
        await installRootFiles(status.gameDir, files);
        return inspectInstall(status);
      }
      const files = canonical && await doorstopFiles(canonical, game.id);
      if (!files) throw new Error('The staged profile needs an official Windows x64 BepInEx pack.');
      await assertClosed();
      const config = buildDisabledConfig(files);
      const marker = Buffer.from(JSON.stringify({
        version: 1, proxy: digest(files.proxy), config: digest(config), doorstopVersion: files.version ? digest(files.version) : null,
      }) + '\n');
      const rootFiles = [[INI, config]];
      if (files.version) rootFiles.push([VERSION_FILE, files.version]);
      rootFiles.push([OWNERSHIP_FILE, marker], [PROXY, files.proxy]);
      await installRootFiles(status.gameDir, rootFiles);
      return inspectInstall(status);
    });
  }

  async function removeManagedDoorstop(gameDir) {
    return exclusive(async () => {
      const status = await getLaunchStatus(gameDir);
      if (status.loader !== 'managed') throw new Error('Only unchanged loader files installed by Ember can be removed here.');
      await assertClosed();
      await createGameFileManager(status.gameDir).restore();
      if (status.loaderKind === 'melonloader') {
        const files = await melonFiles(status.gameDir);
        const marker = await readSmall(path.join(status.gameDir, MELON_OWNERSHIP), 4096);
        if (!files || !ownsMelon(marker, files)) throw new Error('The MelonLoader files changed. Ember did not remove them.');
        const entries = [[files.proxyName, files.proxy], [MELON_OWNERSHIP, marker]];
        if (files.dobby) entries.push(['dobby.dll', files.dobby]);
        const backup = await removeRootFiles(status.gameDir, entries);
        const result = await inspectInstall(status);
        return backup ? { ...result, message: `Loader removed. Recovery files are in ${backup}.` } : result;
      }
      const files = await doorstopFiles(status.gameDir, game.id);
      const marker = await readSmall(path.join(status.gameDir, OWNERSHIP_FILE), 4096);
      if (!files || !ownsFiles(marker, files)) throw new Error('The loader files changed. Ember left them in place.');
      const owned = [[PROXY, files.proxy], [INI, files.config]];
      if (files.version) owned.push([VERSION_FILE, files.version]);
      owned.push([OWNERSHIP_FILE, marker]);
      const backup = await removeRootFiles(status.gameDir, owned);
      const result = await inspectInstall({ gameId: game.id, gameDir: status.gameDir, steamExe: status.steamExe });
      return backup ? { ...result, message: `Loader removed. Windows kept a backup at ${backup}.` } : result;
    });
  }

  async function launchGame({ gameDir, mode, profilePath, loaderPath = profilePath, allowExistingDoorstop = false, loaderFingerprint }) {
    return exclusive(async () => {
      if (mode !== 'modded' && mode !== 'vanilla') throw new Error('Choose a modded or vanilla launch.');
      const status = await getLaunchStatus(gameDir);
      const args = ['-applaunch', game.steamId];
      const enable = status.doorstopMajor === 4 ? '--doorstop-enabled' : '--doorstop-enable';
      const gameFiles = createGameFileManager(status.gameDir);
      if (mode === 'vanilla') {
        if (!status.canLaunchVanilla) throw new Error('The game folder’s loader prevents Ember from safely launching vanilla.');
        if (status.loaderKind === 'melonloader') args.push('--no-mods');
        else if (status.doorstopMajor) args.push(enable, 'false');
      } else {
        if (status.loader === 'existing' && (allowExistingDoorstop !== true ||
            (loaderFingerprint !== undefined && loaderFingerprint !== status.loaderFingerprint))) {
          throw new Error('Confirm reuse of the existing Unity Doorstop loader first.');
        }
        if (status.loader !== 'managed' && status.loader !== 'existing') throw new Error(status.message);
        const profile = isLocalPath(profilePath) && await realpath(profilePath).catch(() => null);
        if (status.loaderKind === 'melonloader') {
          const files = profile && await melonFiles(profile, true);
          if (!files) throw new Error('Prepare a profile containing MelonLoader 0.7.0 or newer before launching.');
          const installed = await melonFiles(status.gameDir);
          if (!installed || installed.proxyName !== files.proxyName || digest(installed.proxy) !== digest(files.proxy) ||
              (installed.dobby ? digest(installed.dobby) : null) !== (files.dobby ? digest(files.dobby) : null)) {
            if (status.loader !== 'managed' || !installed) throw new Error('This game folder uses a different MelonLoader version. Use a matching profile or remove that loader first.');
            await assertClosed();
            const previousMarker = await readSmall(path.join(status.gameDir, MELON_OWNERSHIP), 4096);
            if (!ownsMelon(previousMarker, installed)) throw new Error('The installed MelonLoader changed. Review it in Settings.');
            const oldEntries = [[installed.proxyName, installed.proxy], [MELON_OWNERSHIP, previousMarker]];
            if (installed.dobby) oldEntries.push(['dobby.dll', installed.dobby]);
            const recovery = await removeRootFiles(status.gameDir, oldEntries);
            if (recovery) throw new Error(`MelonLoader update stopped. Recovery files are in ${recovery}.`);
            const newMarker = Buffer.from(JSON.stringify({ version: 1, proxyName: files.proxyName, proxy: digest(files.proxy), dobby: files.dobby ? digest(files.dobby) : null }) + '\n');
            const newEntries = [[MELON_OWNERSHIP, newMarker]];
            if (files.dobby) newEntries.push(['dobby.dll', files.dobby]);
            newEntries.push([files.proxyName, files.proxy]);
            try { await installRootFiles(status.gameDir, newEntries); }
            catch (error) { await installRootFiles(status.gameDir, oldEntries); throw error; }
          }
          args.push('--melonloader.basedir', profile);
        } else {
        const assembly = profile && path.join(profile, ...PRELOADER);
        const target = assembly && await realpath(assembly).catch(() => null);
        if (!target || absoluteKey(target) !== absoluteKey(assembly) || !(await info(assembly))?.isFile()) {
          throw new Error('Prepare a profile containing the BepInEx preloader before launching.');
        }
        const loader = isLocalPath(loaderPath) && await realpath(loaderPath).catch(() => null);
        const files = loader && await doorstopFiles(loader, game.id);
        if (!files || files.major !== status.doorstopMajor) {
          throw new Error(`This game folder uses Doorstop ${status.doorstopMajor}. Use a profile with a matching BepInExPack version.`);
        }
        args.push(enable, 'true', status.doorstopMajor === 4 ? '--doorstop-target-assembly' : '--doorstop-target', target);
        }
      }
      await assertClosed();
      if (mode === 'modded') await gameFiles.apply(await realpath(profilePath));
      else await gameFiles.restore();
      try { await startSteam(status.steamExe, args); }
      catch (error) { if (mode === 'modded') await gameFiles.restore(); throw error; }
      return { mode, gameDir: status.gameDir };
    });
  }

  const adapter = { findGame, getLaunchStatus, prepareDoorstop, removeManagedDoorstop, launchGame, assertGameClosed: assertClosed,
    getRunningStatus, isGameRunning: async () => (await getRunningStatus()).running };
  if (gameId === 'lethal-company') Object.assign(adapter, {
    findLethalCompany: findGame, launchLethalCompany: launchGame, assertLethalCompanyClosed: assertClosed,
  });
  return adapter;
}

module.exports = { ...createSteamAdapter(), createSteamAdapter, createGameLauncher: createSteamAdapter,
  SUPPORTED_GAMES, createGameGuard, createSupportedGameGuard, createGameRunningCheck,
  assertSupportedGamesClosed: createSupportedGameGuard() };
