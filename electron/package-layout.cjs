const { once } = require('node:events');
const yauzl = require('yauzl');

const ROOT_STAGE = '.ember-game-files';
const META = /^(?:manifest\.json|icon\.png|readme(?:\..*)?|changelog(?:\..*)?|license(?:\..*)?)$/i;
const BEPINEX_FOLDERS = new Set(['plugins', 'patchers', 'config', 'core', 'monomod']);
const PROXIES = new Set(['winhttp.dll', 'version.dll', 'dobby.dll', 'dxgi.dll', 'dinput8.dll', 'd3d11.dll', 'winmm.dll', 'dsound.dll', 'doorstop_config.ini', '.doorstop_version']);
const ALTERNATE_LAYOUT = /^(?:melonloader|mods|userdata|userlibs|ue4ss|gdweave|returnofmodding|shimloader|slimvml|sideloader)(?:\/|$)/i;
const GAME_LAYOUTS = Object.freeze({
  'lethal-company': { data: 'Lethal Company_Data', folders: ['Lethal Company'] },
  repo: { data: 'REPO_Data', folders: ['REPO', 'R.E.P.O.'] },
  peak: { data: 'PEAK_Data', folders: ['PEAK'] },
  mimesis: { data: 'MIMESIS_Data', folders: ['MIMESIS'] },
});

function unsupported(entry, reason) {
  throw new Error(`This package uses a game layout Ember cannot deploy: ${entry}. ${reason}`);
}

function gameFile(entry, gameId) {
  const game = GAME_LAYOUTS[gameId];
  const parts = entry.split('/');
  const first = parts[0].toLowerCase();
  const gameFolder = game.folders.some(folder => folder.toLowerCase() === first);
  if (first === 'root' || gameFolder) {
    if (parts.length < 2) unsupported(entry, 'A game-root folder must contain files.');
    return validateRoot(parts.slice(1).join('/'), game);
  }
  if (first === game.data.toLowerCase()) return validateRoot(`${game.data}/${parts.slice(1).join('/')}`, game);
  if (/_data$/i.test(parts[0])) unsupported(entry, 'This data folder belongs to another game.');
  return null;
}

function validateRoot(entry, game) {
  const first = entry.split('/')[0].toLowerCase();
  if (PROXIES.has(first) || first === 'unityplayer.dll' || first === 'bepinex' || ALTERNATE_LAYOUT.test(entry)) {
    unsupported(entry, 'Loader files must come from the selected loader package.');
  }
  if (/\.(?:exe|com|bat|cmd|ps1|vbs|sh)$/i.test(entry)) unsupported(entry, 'Game executables and installer scripts are not deployed as mod files.');
  if (/_data$/i.test(entry.split('/')[0]) && first !== game.data.toLowerCase()) {
    unsupported(entry, 'This data folder belongs to another game.');
  }
  return `${ROOT_STAGE}/${entry}`;
}

function clearLayout(entry, kind) {
  const first = entry.split('/')[0].toLowerCase();
  return first === 'bepinex' || first === 'root' || /_data$/i.test(first) ||
    ALTERNATE_LAYOUT.test(entry) ||
    (kind === 'bepinex' ? BEPINEX_FOLDERS.has(first) : ['melonloader', 'mods', 'plugins', 'userlibs', 'userdata'].includes(first));
}

async function wrapperPrefix(archivePath, kind, gameId) {
  const archive = await yauzl.openPromise(archivePath, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
  const names = [];
  try {
    if (archive.entryCount > 20_000) throw new Error('The archive exceeds the 20,000-entry limit.');
    for await (const entry of archive.eachEntry()) {
      if (!entry.fileName.endsWith('/')) names.push(entry.fileName);
    }
  } finally {
    const closed = once(archive, 'close');
    archive.close();
    await closed;
  }
  let payload = names.filter(name => !META.test(name));
  let prefix = '';
  let confirmed = '';
  for (let depth = 0; depth < 4 && payload.length; depth++) {
    const first = payload[0].split('/')[0];
    if (clearLayout(first, kind) || GAME_LAYOUTS[gameId].folders.some(folder => folder.toLowerCase() === first.toLowerCase())) break;
    if (!payload.every(name => name.startsWith(`${first}/`))) break;
    const stripped = payload.map(name => name.slice(first.length + 1));
    prefix += `${first}/`;
    if (stripped.some(name => clearLayout(name, kind) || /^manifest\.json$/i.test(name))) confirmed = prefix;
    payload = stripped.filter(name => !META.test(name));
  }
  return confirmed;
}

async function createPackageMapper(archivePath, { directory, gameId, loader, isLoader = false }) {
  if (!GAME_LAYOUTS[gameId]) throw new Error('Choose a supported game for package deployment.');
  const kind = loader.kind;
  const prefix = await wrapperPrefix(archivePath, kind, gameId);
  return original => {
    let entry = prefix && original.startsWith(prefix) ? original.slice(prefix.length) : original;
    const first = entry.split('/')[0];
    if ((first.toLowerCase() === 'root' || GAME_LAYOUTS[gameId].folders.some(folder => folder.toLowerCase() === first.toLowerCase())) &&
        /^(?:bepinex|melonloader|plugins|patchers|config|core|monomod|mods|userlibs|userdata)\//i.test(entry.slice(first.length + 1))) {
      entry = entry.slice(first.length + 1);
    }
    if (META.test(entry) || META.test(original)) return null;
    if (/\/(?:bepinex|melonloader|ue4ss)\//i.test(entry) && !/^(?:bepinex|melonloader|root)\//i.test(entry)) {
      unsupported(entry, 'The archive has an ambiguous loader wrapper. Put all mod files under one package folder or use a documented layout.');
    }
    if (isLoader) {
      if (kind === 'melonloader') {
        if (/^melonloader\//i.test(entry)) return `MelonLoader/${entry.slice('MelonLoader/'.length)}`;
        if (['version.dll', 'winhttp.dll', 'dobby.dll'].includes(entry.toLowerCase())) return entry.toLowerCase();
        return null;
      }
      const known = /^(?:bepinex\/)?(core|config|plugins|patchers|monomod)\/(.+)$/i.exec(entry);
      if (known) return `BepInEx/${known[1].toLowerCase()}/${known[2]}`;
      return ['winhttp.dll', 'doorstop_config.ini', '.doorstop_version'].includes(entry.toLowerCase()) ? entry.toLowerCase() : null;
    }
    const root = gameFile(entry, gameId);
    if (root) return root;
    if (PROXIES.has(entry.toLowerCase())) unsupported(entry, 'Loader replacement files are not ordinary plugins.');
    if (kind === 'melonloader') {
      if (/^bepinex\//i.test(entry) || /\.mm\.dll$/i.test(entry) || /^(?:core|patchers|monomod|ue4ss|gdweave|returnofmodding|shimloader)\//i.test(entry)) {
        unsupported(entry, 'This mod requires a different loader than the selected profile.');
      }
      if (/^melonloader\//i.test(entry)) unsupported(entry, 'Only the selected MelonLoader package may supply loader files.');
      const userData = /^userdata\/(.+)$/i.exec(entry);
      if (userData) return `UserData/${directory}/${userData[1]}`;
      return `Mods/${directory}/${entry}`;
    }
    const known = /^(?:bepinex\/)?(plugins|patchers|config|core|monomod)\/(.+)$/i.exec(entry);
    if (known) {
      const folder = known[1].toLowerCase();
      return ['config', 'core'].includes(folder)
        ? `BepInEx/${folder}/${known[2]}`
        : `BepInEx/${folder}/${directory}/${known[2]}`;
    }
    if (/^bepinex\//i.test(entry) || ALTERNATE_LAYOUT.test(entry)) unsupported(entry, 'Choose a package made for this game and loader.');
    if (/\.(?:exe|com|bat|cmd|ps1|vbs|sh)$/i.test(entry)) unsupported(entry, 'Installer executables and scripts are not plugins.');
    if (/\.mm\.dll$/i.test(entry)) return `BepInEx/monomod/${directory}/${entry}`;
    return `BepInEx/plugins/${directory}/${entry}`;
  };
}

module.exports = { createPackageMapper, ROOT_STAGE };
