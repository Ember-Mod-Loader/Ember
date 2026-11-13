import { GAMES, getCatalog, getGame, getPackage } from "./catalog.js";
import { REWARD_WALLPAPERS, readRewardCode, readUnlockedRewards } from "./rewards.js";
import limits from "../electron/profile-limits.json" with { type: "json" };

const STORAGE_KEY = "modrelay:workspace:v1";
const LIVE_STORAGE_KEY = "modrelay:thunderstore:v1";
const LATEST_VERSIONS_KEY = "modrelay:latest-versions:v1";
const MAX_LATEST_VERSIONS = 4096;
const MAX_LATEST_VERSIONS_LENGTH = 1024 * 1024;
const PROFILE_FORMAT = "modrelay-profile";
const CODE_PREFIX = "MR1-";
export const WALLPAPERS = [
  { id: "main", name: "Main", file: "./art/ember-landscape.png" },
  { id: "ember-flow", name: "Ember Flow", file: "./art/ember-backdrop.png" },
  { id: "first-flame", name: "First Flame", file: "./art/ember-first-flame.svg" },
  { id: "obsidian", name: "Obsidian", file: "./art/ember-obsidian.png" },
  { id: "crimson-dunes", name: "Crimson Dunes", file: "./art/ember-crimson-dunes.png" },
  { id: "solar-drift", name: "Solar Drift", file: "./art/ember-solar-drift.png" },
  ...REWARD_WALLPAPERS,
];
const DEFAULT_SETTINGS = { launchMode: "modded", confirmRemoval: true, compactMode: false, wallpaper: "main" };
export const MAX_CONFIG_LENGTH = 65536;
export const MAX_IMPORT_LENGTH = 3 * 1024 * 1024;
export const PROFILE_NAME_LIMIT = 60;
const VERSION = /^\d{1,10}\.\d{1,10}\.\d{1,10}$/;
const NAMESPACE = /^[a-z0-9_-]{1,64}$/i;
const PACKAGE_PART = /^[a-z0-9_]{1,128}$/i;

function newId() {
  return globalThis.crypto.randomUUID();
}

function newProfile(gameId, name, id = newId()) {
  return { id, gameId, name, mods: [], configs: {}, configFiles: {}, userDataFiles: {} };
}

function initialState(live) {
  const profiles = GAMES.map(game => newProfile(game.id, "Default", `${game.id}-default`));
  if (!live) profiles[0].mods = [
    { id: "bepinexpack", version: "5.4.2304", enabled: true },
    { id: "morecompany", version: "1.11.1", enabled: true },
    { id: "lethallib", version: "0.16.2", enabled: true },
    { id: "skinwalkers", version: "4.0.4", enabled: true },
    { id: "lethalconfig", version: "1.4.6", enabled: true },
    { id: "betteritemscan", version: "3.0.2", enabled: false },
  ];
  return {
    version: 1,
    activeGameId: GAMES[0].id,
    activeProfileIds: Object.fromEntries(profiles.map(profile => [profile.gameId, profile.id])),
    profiles,
    favorites: [],
    favoritePackages: {},
    settings: { ...DEFAULT_SETTINGS },
    unlockedRewards: [],
    activity: [],
  };
}

function profileName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > PROFILE_NAME_LIMIT) {
    throw new Error(`Enter a profile name between 1 and ${PROFILE_NAME_LIMIT} characters.`);
  }
  return value.trim();
}

function isLaunchMode(mode) {
  return mode === "modded" || mode === "vanilla";
}

function isSetting(key, value) {
  if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return false;
  if (key === "wallpaper") return WALLPAPERS.some(wallpaper => wallpaper.id === value);
  return key === "launchMode" ? isLaunchMode(value) : typeof value === "boolean";
}

function wallpaperAvailable(id, unlockedRewards) {
  const wallpaper = WALLPAPERS.find(item => item.id === id);
  return wallpaper && (!wallpaper.rewardId || unlockedRewards.includes(wallpaper.rewardId));
}

function isNewer(current, latest) {
  const currentParts = current.split(".").map(Number);
  const latestParts = latest.split(".").map(Number);
  for (const [index, part] of latestParts.entries()) {
    if (part !== currentParts[index]) return part > currentParts[index];
  }
  return false;
}

function dependencyOrder(id, resolve = getPackage, seen = new Set()) {
  if (seen.has(id)) return [];
  seen.add(id);
  const refs = resolve(id)?.dependencies ?? [];
  return [...refs.flatMap(dep => dependencyOrder(typeof dep === "string" ? dep : dep.id, resolve, seen)), id];
}

function trustedUrl(value, hosts) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && hosts.includes(url.hostname) ? url.href : "";
  } catch {
    return "";
  }
}

function readReference(value, gameId) {
  if (typeof value?.namespace !== "string" || !NAMESPACE.test(value.namespace) ||
      typeof value.name !== "string" || !PACKAGE_PART.test(value.name) ||
      typeof value.version !== "string" || !VERSION.test(value.version)) {
    throw new Error("This profile contains an invalid Thunderstore package reference.");
  }
  const { namespace, name, version } = value;
  return { id: `${gameId}/${namespace}/${name}`, namespace, name, version };
}

function readCategories(value) {
  if (!Array.isArray(value)) return [];
  const categories = new Map();
  for (const category of value.slice(0, 100)) {
    if (typeof category?.id !== "string" || !/^\d{1,12}$/.test(category.id) ||
        typeof category.name !== "string" || !category.name.trim()) continue;
    categories.set(category.id, { id: category.id, name: category.name.trim().slice(0, 100) });
  }
  return [...categories.values()];
}

function readPackage(value, gameId, allowPreview = false) {
  const reference = readReference(allowPreview && !value?.version ? { ...value, version: "0.0.0" } : value, gameId);
  if (!Array.isArray(value.dependencies) || value.dependencies.length > 300) {
    throw new Error("This profile contains an invalid Thunderstore dependency list.");
  }
  return {
    ...reference,
    gameId,
    version: value.version ?? null,
    author: reference.namespace,
    description: typeof value.description === "string" ? value.description.slice(0, 300) : "",
    category: typeof value.category === "string" ? value.category.slice(0, 70) : "Mods",
    categories: readCategories(value.categories),
    icon: trustedUrl(value.icon, ["ccdn.thunderstore.io", "cdn.thunderstore.io", "gcdn.thunderstore.io"]),
    url: trustedUrl(value.url, ["thunderstore.io"]),
    downloads: Number.isSafeInteger(value.downloads) && value.downloads > 0 ? value.downloads : 0,
    updatedAt: typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : null,
    rating: Number.isSafeInteger(value.rating) && value.rating > 0 ? value.rating : 0,
    deprecated: value.deprecated === true,
    pinned: value.pinned === true,
    nsfw: value.nsfw === true,
    ...(value.unlisted === true ? { unlisted: true } : {}),
    dependencies: value.dependencies.map(ref => readReference(ref, gameId)),
  };
}

function readConfigFiles(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > limits.MAX_CONFIG_FILES) {
    throw new Error(`Choose up to ${limits.MAX_CONFIG_FILES} configuration files.`);
  }
  const paths = new Map();
  const files = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [relative, content] of Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const parts = relative.split("/");
    if (!relative.isWellFormed() || relative.length > 512 || parts.length > 16 || !/\.(?:cfg|json|txt|ya?ml|xml|ini|conf|toml|done)$/i.test(relative) || parts.some(part =>
      !part || part.length > 255 || part === "." || part === ".." || /[<>:"\\|?*\x00-\x1f\x7f]/.test(part) ||
      /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i.test(part.split(".", 1)[0].trimEnd()))) {
      throw new Error("This profile contains an unsupported configuration path.");
    }
    let combined = "";
    for (const [index, part] of parts.entries()) {
      combined += (index ? "/" : "") + part;
      const key = combined.normalize("NFC").toUpperCase();
      const directory = index < parts.length - 1;
      const existing = paths.get(key);
      if (existing && (existing.path !== combined || !existing.directory || !directory)) {
        throw new Error("This profile contains conflicting configuration paths.");
      }
      paths.set(key, { path: combined, directory });
    }
    if (typeof content !== "string" || !content.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) {
      throw new Error("Configuration files must be valid UTF-8 text.");
    }
    bytes += encoder.encode(content).byteLength;
    if (bytes > limits.MAX_CONFIG_TOTAL_BYTES) throw new Error("Profile configuration files exceed 2 MiB.");
    files.push([relative, content]);
  }
  return Object.fromEntries(files);
}

function readProfile(value, live) {
  if (!value || typeof value !== "object" || !getGame(value.gameId) || !Array.isArray(value.mods)) {
    throw new Error("This profile has an unsupported game or invalid mod list.");
  }

  const name = profileName(value.name);
  const modsById = new Map();
  for (const entry of value.mods) {
    const mod = live ? readPackage(entry?.package, value.gameId) : getPackage(entry?.id);
    if (mod?.gameId !== value.gameId || mod.id !== entry.id || modsById.has(entry.id) ||
        typeof entry.version !== "string" || !VERSION.test(entry.version) || (live && mod.version !== entry.version) ||
        typeof entry.enabled !== "boolean") {
      throw new Error("This profile contains a package or version Ember does not recognize.");
    }
    const directIds = new Set(mod.dependencies.map(ref => live ? ref.id : ref));
    const overrides = entry.missingDependencies;
    if (overrides !== undefined && (!Array.isArray(overrides) || overrides.length > 300 ||
        new Set(overrides).size !== overrides.length || overrides.some(id => typeof id !== "string" || !directIds.has(id)))) {
      throw new Error("This profile contains an invalid missing dependency override.");
    }
    modsById.set(entry.id, { id: entry.id, version: entry.version, enabled: entry.enabled, ...(live ? { package: mod } : {}),
      ...(overrides?.length ? { missingDependencies: [...overrides] } : {}) });
  }

  for (const entry of modsById.values()) {
    const mod = entry.package ?? getPackage(entry.id);
    for (const ref of mod.dependencies) {
      const dependencyId = live ? ref.id : ref;
      const dependency = modsById.get(dependencyId);
      if ((!dependency && !entry.missingDependencies?.includes(dependencyId)) ||
          (dependency && live && isNewer(dependency.version, ref.version))) {
        throw new Error(`${mod.name} requires ${live ? ref.name : getPackage(ref).name}.`);
      }
    }
    if (entry.missingDependencies) {
      entry.missingDependencies = entry.missingDependencies.filter(id => !modsById.has(id));
      if (!entry.missingDependencies.length) delete entry.missingDependencies;
    }
  }

  const configs = {};
  if (!value.configs || typeof value.configs !== "object" || Array.isArray(value.configs)) {
    throw new Error("This profile has invalid configuration data.");
  }
  for (const [id, content] of Object.entries(value.configs)) {
    if (!modsById.has(id) || !getPackage(id)?.config || typeof content !== "string" || content.length > MAX_CONFIG_LENGTH) {
      throw new Error("This profile has invalid configuration data.");
    }
    configs[id] = content;
  }

  return { gameId: value.gameId, name, mods: [...modsById.values()], configs,
    configFiles: readConfigFiles(value.configFiles), userDataFiles: readConfigFiles(value.userDataFiles) };
}

function loadState(storage, live) {
  const fallback = initialState(live);
  try {
    const saved = JSON.parse(storage?.getItem(live ? LIVE_STORAGE_KEY : STORAGE_KEY));
    if (saved?.version !== fallback.version || !Array.isArray(saved.profiles)) return fallback;

    const profiles = saved.profiles.map(profile => {
      if (typeof profile?.id !== "string" || !profile.id) throw new Error("Invalid profile ID.");
      return { id: profile.id, ...readProfile(profile, live) };
    });
    if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) return fallback;
    for (const game of GAMES) {
      if (!profiles.some(profile => profile.gameId === game.id)) {
        profiles.push(fallback.profiles.find(profile => profile.gameId === game.id));
      }
    }
    const activeProfileIds = Object.fromEntries(GAMES.map(({ id }) => {
      const gameProfiles = profiles.filter(profile => profile.gameId === id);
      return [id, gameProfiles.find(profile => profile.id === saved.activeProfileIds?.[id])?.id ?? gameProfiles[0].id];
    }));
    const unlockedRewards = readUnlockedRewards(saved.unlockedRewards);
    const savedSettings = Object.entries(saved.settings ?? {}).filter(([key, value]) => isSetting(key, value) &&
      (key !== "wallpaper" || wallpaperAvailable(value, unlockedRewards)));
    const favoritePackages = {};
    if (live && Array.isArray(saved.favorites)) {
      for (const id of saved.favorites) {
        const entry = saved.favoritePackages?.[id];
        if (getGame(entry?.gameId)) {
          const mod = readPackage(entry, entry.gameId, true);
          if (mod.id === id) favoritePackages[id] = mod;
        }
      }
    }
    return {
      version: fallback.version,
      activeGameId: getGame(saved.activeGameId)?.id ?? fallback.activeGameId,
      activeProfileIds,
      profiles,
      favorites: live ? Object.keys(favoritePackages) : Array.isArray(saved.favorites) ? [...new Set(saved.favorites.filter(getPackage))] : [],
      favoritePackages,
      settings: { ...DEFAULT_SETTINGS, ...Object.fromEntries(savedSettings) },
      unlockedRewards,
      activity: Array.isArray(saved.activity) ? saved.activity.filter(entry => entry &&
        typeof entry.id === "string" && typeof entry.at === "string" && typeof entry.type === "string" &&
        Number.isFinite(Date.parse(entry.at)) && typeof entry.message === "string" &&
        getGame(entry.gameId) && typeof entry.profileId === "string").slice(0, 75) : [],
    };
  } catch {
    return fallback;
  }
}

function toCode(json) {
  let bytes = "";
  for (const byte of new TextEncoder().encode(json)) bytes += String.fromCharCode(byte);
  return CODE_PREFIX + btoa(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeProfile(value, live) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Paste a Ember profile code or choose a profile file.");
  if (value.length > MAX_IMPORT_LENGTH) throw new Error("This profile is too large to import.");
  let payload;
  try {
    let text = value.trim();
    if (text.startsWith(CODE_PREFIX)) {
      const bytes = atob(text.slice(CODE_PREFIX.length).replaceAll("-", "+").replaceAll("_", "/"));
      text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes, char => char.charCodeAt(0)));
    }
    payload = JSON.parse(text);
  } catch {
    throw new Error("This is not a valid Ember profile code or JSON file.");
  }
  if (payload?.format !== PROFILE_FORMAT || payload.version !== 1) {
    throw new Error("Choose a profile exported by Ember.");
  }
  if ((payload.source === "thunderstore") !== live) {
    throw new Error(live ? "This profile uses the retired sample catalog. Import a Thunderstore profile instead." : "Open the Thunderstore workspace to import this profile.");
  }
  return readProfile(payload, live);
}

export function createManager(storage = globalThis.localStorage, { live = false } = {}) {
  let state = loadState(storage, live);
  const packages = new Map();
  const installedPackageIds = () => new Set(state.profiles.flatMap(profile => profile.mods.map(entry => entry.id)));
  let installedIds = live ? installedPackageIds() : new Set();
  const latestVersions = new Map();
  if (live) {
    try {
      const raw = storage?.getItem(LATEST_VERSIONS_KEY);
      const entries = raw?.length <= MAX_LATEST_VERSIONS_LENGTH ? JSON.parse(raw) : null;
      if (Array.isArray(entries)) {
        for (const pair of entries.slice(0, MAX_LATEST_VERSIONS)) {
          if (!Array.isArray(pair) || pair.length !== 2) continue;
          const [id, version] = pair;
          if (installedIds.has(id) && typeof version === "string" && VERSION.test(version)) latestVersions.set(id, version);
        }
      }
    } catch {
      // The version cache is optional and can be rebuilt by the next check.
    }
  }

  function rememberLatestVersion(id, version, checked = false) {
    if (!version || !installedIds.has(id)) return false;
    const previous = latestVersions.get(id);
    if (version === previous || (previous && !checked && !isNewer(previous, version))) return false;
    latestVersions.delete(id);
    latestVersions.set(id, version);
    return true;
  }

  function saveLatestVersions() {
    while (latestVersions.size > MAX_LATEST_VERSIONS) latestVersions.delete(latestVersions.keys().next().value);
    try {
      storage?.setItem(LATEST_VERSIONS_KEY, JSON.stringify([...latestVersions]));
    } catch {
      // Keep the observed versions available in memory if disk storage fails.
    }
  }

  function syncInstalledIds() {
    const previousIds = installedIds;
    installedIds = installedPackageIds();
    let changed = false;
    for (const id of latestVersions.keys()) {
      if (!installedIds.has(id)) {
        latestVersions.delete(id);
        changed = true;
      }
    }
    for (const id of installedIds) {
      if (!previousIds.has(id) && rememberLatestVersion(id, packages.get(id)?.version)) changed = true;
    }
    if (changed) saveLatestVersions();
  }

  const activeGame = () => getGame(state.activeGameId);
  const gameProfiles = () => state.profiles.filter(profile => profile.gameId === state.activeGameId);
  const activeProfile = () => gameProfiles().find(profile => profile.id === state.activeProfileIds[state.activeGameId]);
  const snapshot = (id, profile = activeProfile()) => profile.mods.find(entry => entry.id === id)?.package ?? getPackage(id);
  const packageById = id => packages.get(id) ?? snapshot(id) ?? state.favoritePackages[id];
  const installed = () => activeProfile().mods.map(entry => {
    const latest = packageById(entry.id);
    const latestVersion = latestVersions.get(entry.id) ?? (latest?.version || entry.version);
    const snapshotMod = entry.package ?? latest;
    const mod = live && latest && snapshotMod ? { ...snapshotMod,
      category: latest.category, categories: latest.categories,
      deprecated: latest.deprecated, pinned: latest.pinned, nsfw: latest.nsfw,
    } : snapshotMod;
    return { ...entry, mod, latestVersion, hasUpdate: isNewer(entry.version, latestVersion) };
  });

  function commit(change, type, message, profile = activeProfile()) {
    const next = structuredClone(state);
    const result = change(next);
    if (message) {
      next.activity.unshift({
        id: newId(), type, message, at: new Date().toISOString(), gameId: profile.gameId, profileId: profile.id,
      });
      next.activity.length = Math.min(next.activity.length, 75);
    }
    try {
      storage?.setItem(live ? LIVE_STORAGE_KEY : STORAGE_KEY, JSON.stringify(next));
    } catch {
      throw new Error("Ember could not save the workspace. Check that local storage is available.");
    }
    state = next;
    if (live) syncInstalledIds();
    return result;
  }

  function findProfile(id) {
    const profile = gameProfiles().find(item => item.id === id);
    if (!profile) throw new Error("That profile could not be found for this game.");
    return profile;
  }

  function findMod(id) {
    const mod = packageById(id);
    if (mod?.gameId !== state.activeGameId) throw new Error("That package could not be found for this game.");
    return mod;
  }

  function findInstalled(id) {
    const entry = activeProfile().mods.find(item => item.id === id);
    if (!entry) throw new Error("Install this package in the current profile first.");
    return entry;
  }

  function uniqueName(name, gameId, ignoredId) {
    const desired = profileName(name);
    const conflicts = candidate => state.profiles.some(profile => profile.id !== ignoredId &&
      profile.gameId === gameId && profile.name.toLowerCase() === candidate.toLowerCase());
    if (conflicts(desired)) throw new Error("A profile with this name already exists for this game.");
    return desired;
  }

  function addProfile(profile, message) {
    return commit(draft => {
      draft.profiles.push(profile);
      draft.activeGameId = profile.gameId;
      draft.activeProfileIds[profile.gameId] = profile.id;
      return profile;
    }, "profile", message, profile);
  }

  function changeProfile(change, type, message) {
    const { id } = activeProfile();
    return commit(draft => {
      const profile = draft.profiles.find(profile => profile.id === id);
      const result = change(profile);
      const installedIds = new Set(profile.mods.map(entry => entry.id));
      for (const entry of profile.mods) {
        if (!entry.missingDependencies) continue;
        entry.missingDependencies = entry.missingDependencies.filter(dependencyId => !installedIds.has(dependencyId));
        if (!entry.missingDependencies.length) delete entry.missingDependencies;
      }
      return result;
    }, type, message);
  }

  function ensureDependencies(profile, id, enabled, enableExisting = true) {
    const added = [];
    for (const dependencyId of dependencyOrder(id).slice(0, -1)) {
      const dependency = profile.mods.find(item => item.id === dependencyId);
      if (dependency) {
        if (enabled && enableExisting) dependency.enabled = true;
      } else {
        profile.mods.push({ id: dependencyId, version: getPackage(dependencyId).version, enabled });
        added.push(dependencyId);
      }
    }
    return added;
  }

  function dependentMods(id, enabledOnly = false) {
    const profile = activeProfile();
    const resolve = key => snapshot(key, profile);
    return profile.mods.filter(item => item.id !== id && (!enabledOnly || item.enabled) &&
      dependencyOrder(item.id, resolve).includes(id)).map(item => ({ ...resolve(item.id), enabled: item.enabled }));
  }

  function getRemovalRequirements(id) {
    findInstalled(id);
    return { mod: snapshot(id), dependents: dependentMods(id) };
  }

  function getToggleRequirements(id, enabled) {
    findInstalled(id);
    if (typeof enabled !== "boolean") throw new Error("Choose whether to enable this package.");
    const profile = activeProfile();
    const resolve = key => snapshot(key, profile);
    const installedById = new Map(profile.mods.map(entry => [entry.id, entry]));
    const order = enabled ? dependencyOrder(id, resolve).filter(dependencyId => dependencyId !== id) : [];
    const missing = new Map();
    for (const parentId of [id, ...order]) {
      for (const ref of resolve(parentId)?.dependencies ?? []) {
        const dependencyId = typeof ref === "string" ? ref : ref.id;
        if (installedById.has(dependencyId)) continue;
        const candidate = typeof ref === "string" ? getPackage(ref) : ref;
        const current = missing.get(dependencyId);
        if (candidate && (!current || isNewer(current.version, candidate.version))) missing.set(dependencyId, candidate);
      }
    }
    return {
      mod: resolve(id),
      dependencies: order.filter(dependencyId => installedById.has(dependencyId) && !installedById.get(dependencyId).enabled).map(resolve),
      missingDependencies: enabled ? order.filter(dependencyId => missing.has(dependencyId)).map(dependencyId => missing.get(dependencyId)) : [],
      dependents: enabled ? [] : dependentMods(id, true),
    };
  }

  return {
    live,
    get state() { return state; },
    get game() { return activeGame(); },
    get profile() { return activeProfile(); },
    get profiles() { return gameProfiles(); },
    get catalog() { return getCatalog(state.activeGameId); },
    get installed() { return installed(); },
    get updates() { return installed().filter(entry => entry.hasUpdate); },
    get wallpapers() { return structuredClone(WALLPAPERS.filter(wallpaper => !wallpaper.rewardId || state.unlockedRewards.includes(wallpaper.rewardId))); },
    packageById,
    registerPackages(list, { checkedLatest = false } = {}) {
      let changed = false;
      for (const raw of list) {
        if (checkedLatest) {
          // A version check does not include a full dependency list.
          const { id, version } = readReference(raw, raw.gameId);
          if (rememberLatestVersion(id, version, true)) changed = true;
          continue;
        }
        const mod = readPackage(raw, raw.gameId, true);
        const existing = packages.get(mod.id);
        if (existing?.version && (!mod.version || isNewer(mod.version, existing.version))) continue;
        packages.set(mod.id, mod);
        // Replaying the same catalog version cannot undo a later explicit check.
        if ((mod.version !== existing?.version || !latestVersions.has(mod.id)) &&
            rememberLatestVersion(mod.id, mod.version)) changed = true;
      }
      if (changed) saveLatestVersions();
    },
    get configs() {
      const profile = activeProfile();
      return profile.mods.flatMap(({ id }) => {
        const mod = snapshot(id, profile);
        return mod.config ? [{ id, ...mod.config, text: profile.configs[id] ?? mod.config.text, mod }] : [];
      });
    },

    switchGame(id) {
      const game = getGame(id);
      if (!game) throw new Error("That game could not be found.");
      if (id !== state.activeGameId) commit(draft => { draft.activeGameId = id; });
      return game;
    },

    switchProfile(id) {
      const profile = findProfile(id);
      if (id !== activeProfile().id) commit(draft => { draft.activeProfileIds[profile.gameId] = id; });
      return profile;
    },

    createProfile(name) {
      const gameId = state.activeGameId;
      const profile = newProfile(gameId, uniqueName(name, gameId));
      return addProfile(profile, `Created profile ${profile.name}.`);
    },

    cloneProfile(id, name) {
      const source = findProfile(id);
      const profile = { ...structuredClone(source), id: newId(), name: uniqueName(name, source.gameId) };
      return addProfile(profile, `Duplicated ${source.name} as ${profile.name}.`);
    },

    renameProfile(id, name) {
      const profile = findProfile(id);
      const nextName = uniqueName(name, profile.gameId, id);
      if (nextName === profile.name) return profile;
      return commit(draft => {
        const target = draft.profiles.find(item => item.id === id);
        target.name = nextName;
        return target;
      }, "profile", `Renamed ${profile.name} to ${nextName}.`, profile);
    },

    deleteProfile(id) {
      const profile = findProfile(id);
      const replacement = gameProfiles().find(item => item.id !== id);
      if (!replacement) throw new Error("Keep at least one profile for each game.");
      return commit(draft => {
        draft.profiles = draft.profiles.filter(item => item.id !== id);
        if (draft.activeProfileIds[profile.gameId] === id) draft.activeProfileIds[profile.gameId] = replacement.id;
      }, "profile", `Deleted profile ${profile.name}.`, profile);
    },

    install(id) {
      const mod = findMod(id);
      if (activeProfile().mods.some(entry => entry.id === id)) return [];
      return changeProfile(profile => {
        const added = ensureDependencies(profile, id, true);
        profile.mods.push({ id, version: mod.version, enabled: true });
        return [...added, id];
      }, "install", `Added ${mod.name} to ${activeProfile().name}.`);
    },

    getToggleRequirements,

    setEnabled(id, enabled, { includeDependencies = false, includeDependents = false, force = false } = {}) {
      const entry = findInstalled(id);
      if (typeof enabled !== "boolean") throw new Error("Choose whether to enable this package.");
      if ([includeDependencies, includeDependents, force].some(value => typeof value !== "boolean")) throw new Error("Choose a valid toggle action.");
      if (entry.enabled === enabled && !(!force && (enabled ? includeDependencies : includeDependents))) return [];
      const { mod, dependencies, missingDependencies, dependents } = getToggleRequirements(id, enabled);
      if (!force && missingDependencies.length) {
        throw new Error(`Install ${missingDependencies[0].name} before enabling ${mod.name}.`);
      }
      if (!force && !includeDependencies && dependencies.length) {
        throw new Error(`Enable ${dependencies[0].name} before enabling ${mod.name}.`);
      }
      if (!force && !includeDependents && dependents.length) {
        throw new Error(`${dependents[0].name} requires ${mod.name}. Disable ${dependents[0].name} first.`);
      }
      const affected = !force ? (enabled && includeDependencies ? dependencies : !enabled && includeDependents ? dependents : []) : [];
      const ids = new Set([id, ...affected.map(item => item.id)]);
      return changeProfile(target => {
        const changed = target.mods.filter(item => ids.has(item.id) && item.enabled !== enabled);
        for (const item of changed) item.enabled = enabled;
        return changed.map(item => item.id);
      }, "toggle", `${enabled ? "Enabled" : "Disabled"} ${mod.name}${affected.length ? ` and ${affected.length} ${enabled ? "required" : "dependent"} ${affected.length === 1 ? "mod" : "mods"}` : ""}.`);
    },

    getRemovalRequirements,

    remove(id, { includeDependents = false, force = false } = {}) {
      if (typeof includeDependents !== "boolean" || typeof force !== "boolean") throw new Error("Choose a valid removal action.");
      const { mod, dependents } = getRemovalRequirements(id);
      if (dependents.length && !includeDependents && !force) throw new Error(`${dependents[0].name} requires ${mod.name}. Remove it first.`);
      const ids = new Set([id, ...(includeDependents && !force ? dependents.map(item => item.id) : [])]);
      return changeProfile(profile => {
        const removed = profile.mods.filter(entry => ids.has(entry.id)).map(entry => entry.id);
        profile.mods = profile.mods.filter(entry => !ids.has(entry.id));
        for (const removedId of removed) delete profile.configs[removedId];
        if (force) {
          for (const entry of profile.mods) {
            const directIds = (snapshot(entry.id, profile)?.dependencies ?? []).map(ref => typeof ref === "string" ? ref : ref.id);
            const acknowledged = directIds.filter(dependencyId => ids.has(dependencyId));
            if (acknowledged.length) entry.missingDependencies = [...new Set([...(entry.missingDependencies ?? []), ...acknowledged])];
          }
        }
        return removed;
      }, "remove", `Removed ${mod.name}${ids.size > 1 ? ` and ${ids.size - 1} dependent ${ids.size === 2 ? "mod" : "mods"}` : ""} from ${activeProfile().name}.`);
    },

    update(id) {
      const entry = findInstalled(id);
      const mod = getPackage(id);
      if (!isNewer(entry.version, mod.version)) return [];
      return changeProfile(profile => {
        ensureDependencies(profile, id, entry.enabled, false);
        profile.mods.find(item => item.id === id).version = mod.version;
        return [id];
      }, "update", `Updated ${mod.name} to ${mod.version}.`);
    },

    updateAll() {
      const updates = installed().filter(entry => entry.hasUpdate);
      if (!updates.length) return [];
      return changeProfile(profile => {
        for (const entry of updates) {
          ensureDependencies(profile, entry.id, entry.enabled, false);
          profile.mods.find(item => item.id === entry.id).version = entry.mod.version;
        }
        return updates.map(entry => entry.id);
      }, "update", `Updated ${updates.length} ${updates.length === 1 ? "package" : "packages"}.`);
    },

    toggleFavorite(id) {
      const mod = findMod(id);
      const favorite = !state.favorites.includes(id);
      return commit(draft => {
        if (favorite) {
          draft.favorites.push(id);
          if (live) draft.favoritePackages[id] = mod;
        } else {
          draft.favorites = draft.favorites.filter(item => item !== id);
          delete draft.favoritePackages[id];
        }
        return favorite;
      });
    },

    exportProfile(id = activeProfile().id) {
      const { gameId, name, mods, configs, configFiles, userDataFiles } = findProfile(id);
      const payload = { format: PROFILE_FORMAT, version: 1, ...(live ? { source: "thunderstore" } : {}), gameId, name, mods, configs, configFiles, userDataFiles };
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      return {
        code: toCode(JSON.stringify(payload)),
        json: JSON.stringify(payload, null, 2),
        filename: `${gameId}-${slug || "profile"}.ember.json`,
      };
    },

    readImport(text) {
      return decodeProfile(text, live);
    },

    importProfile(text, downloaded = []) {
      const input = decodeProfile(text, live);
      if (live) {
        const archives = new Map(downloaded.map(mod => [`${mod.id}@${mod.version}`, mod]));
        for (const entry of input.mods) {
          const mod = archives.get(`${entry.id}@${entry.version}`);
          if (!mod) throw new Error(`Download ${entry.package.name} before importing this profile.`);
          entry.package = readPackage(mod, input.gameId);
          if (entry.missingDependencies) {
            entry.missingDependencies = entry.missingDependencies.filter(id => entry.package.dependencies.some(ref => ref.id === id));
            if (!entry.missingDependencies.length) delete entry.missingDependencies;
          }
        }
      }
      const profile = { id: newId(), ...readProfile(input, live) };
      const names = new Set(state.profiles.filter(item => item.gameId === profile.gameId).map(item => item.name.toLowerCase()));
      const originalName = profile.name;
      for (let suffix = 2; names.has(profile.name.toLowerCase()); suffix++) {
        const label = ` (${suffix})`;
        profile.name = originalName.slice(0, PROFILE_NAME_LIMIT - label.length).trimEnd() + label;
      }
      return addProfile(profile, `Imported profile ${profile.name}.`);
    },

    recordDownloads(profileId, gameId, downloaded, roots) {
      const profile = state.profiles.find(item => item.id === profileId && item.gameId === gameId);
      if (!profile) throw new Error("The profile was removed while the packages downloaded.");
      const rootIds = new Set(roots);
      return commit(draft => {
        const target = draft.profiles.find(item => item.id === profileId);
        const entries = new Map(target.mods.map(entry => [entry.id, entry]));
        const originalIds = new Set(entries.keys());
        for (const raw of downloaded) {
          const mod = readPackage(raw, gameId);
          const current = entries.get(mod.id);
          if (!current || isNewer(current.version, mod.version)) {
            const missingDependencies = current?.missingDependencies?.filter(id => mod.dependencies.some(ref => ref.id === id));
            entries.set(mod.id, { id: mod.id, version: mod.version, enabled: current?.enabled ?? rootIds.has(mod.id), package: mod,
              ...(missingDependencies?.length ? { missingDependencies } : {}) });
          }
        }
        const resolve = key => entries.get(key)?.package;
        for (const entry of entries.values()) {
          if (!entry.enabled) continue;
          for (const id of dependencyOrder(entry.id, resolve)) {
            if (entries.has(id) && (!originalIds.has(id) || (rootIds.has(entry.id) && !originalIds.has(entry.id)))) {
              entries.get(id).enabled = true;
            }
          }
        }
        target.mods = readProfile({ ...target, mods: [...entries.values()] }, true).mods;
      }, "download", `Downloaded ${rootIds.size} Thunderstore ${rootIds.size === 1 ? "package" : "packages"} for ${profile.name}.`, profile);
    },

    saveConfig(id, text) {
      findInstalled(id);
      const mod = getPackage(id);
      if (!mod.config) throw new Error("This package has no editable configuration.");
      if (typeof text !== "string" || text.length > MAX_CONFIG_LENGTH) throw new Error("This configuration is too large to save.");
      return changeProfile(profile => { profile.configs[id] = text; }, "config", `Saved ${mod.config.name}.`);
    },

    resetConfig(id) {
      findInstalled(id);
      const mod = getPackage(id);
      if (!mod.config) throw new Error("This package has no editable configuration.");
      return changeProfile(profile => { delete profile.configs[id]; }, "config", `Restored defaults for ${mod.config.name}.`);
    },

    setSetting(key, value) {
      if (!isSetting(key, value)) throw new Error("That setting is not supported.");
      if (key === "wallpaper") {
        if (!wallpaperAvailable(value, state.unlockedRewards)) throw new Error("Unlock this wallpaper with a code first.");
      }
      return commit(draft => { draft.settings[key] = value; });
    },

    redeemCode(value) {
      const reward = readRewardCode(value);
      const wallpaper = WALLPAPERS.find(item => item.id === reward.wallpaperId);
      if (!wallpaper.rewardId || state.unlockedRewards.includes(reward.id)) return { status: "already-unlocked", wallpaper: structuredClone(wallpaper) };
      return commit(draft => {
        draft.unlockedRewards.push(reward.id);
        return { status: "unlocked", wallpaper: structuredClone(wallpaper) };
      });
    },

    recordLaunch(profileId, mode) {
      const profile = state.profiles.find(item => item.id === profileId);
      if (!profile || !isLaunchMode(mode)) return;
      return commit(() => {}, "launch", `Requested a ${mode} Steam launch for ${profile.name}.`, profile);
    },

    previewLaunch(mode = state.settings.launchMode) {
      if (!isLaunchMode(mode)) throw new Error("Choose a vanilla or modded launch.");
      const game = activeGame();
      const profile = activeProfile();
      const enabledMods = mode === "modded" ? installed().filter(entry => entry.enabled) : [];
      const message = mode === "modded"
        ? `Prepared a modded launch for ${game.name} with ${profile.name} (${enabledMods.length} enabled ${enabledMods.length === 1 ? "mod" : "mods"}).`
        : `Prepared a vanilla launch for ${game.name}.`;
      return commit(() => ({ mode, game, profile, enabledMods, message }), "launch", message);
    },
  };
}
