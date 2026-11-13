const { createHash } = require('node:crypto');
const { MAX_PROFILE_MODS } = require('./profile-limits.json');
const { encodeThunderstoreProfile, parseThunderstoreProfile, MAX_NATIVE_PROFILE_BYTES } = require('./thunderstore-profile.cjs');
const { fetchProfilePackageVersion, ThunderstorePackageUnavailableError } = require('./thunderstore.cjs');

const ORIGIN = 'https://thunderstore.io';
const MAX_PROFILE_BYTES = 3 * 1024 * 1024;
const KEY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CODE = new RegExp(`^(?:EMBER-)?(${KEY})$`, 'i');
const CDN_HOSTS = new Set(['ccdn.thunderstore.io', 'cdn.thunderstore.io', 'gcdn.thunderstore.io']);
const GAME_IDS = new Set(['lethal-company', 'repo', 'peak', 'mimesis']);

function parseProfileJson(value, importing = false) {
  const message = importing
    ? 'This code does not contain an Ember profile. Use a share code created by Ember.'
    : 'Choose a valid Ember profile to share.';
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_PROFILE_BYTES) {
    throw new Error('Choose an Ember profile up to 3 MB.');
  }
  let payload;
  try { payload = JSON.parse(value); } catch { throw new Error(message); }
  if (payload?.format !== 'modrelay-profile' || payload.version !== 1 || payload.source !== 'thunderstore' ||
      !GAME_IDS.has(payload.gameId) || typeof payload.name !== 'string' || !payload.name.trim() ||
      payload.name.trim().length > 60 || !Array.isArray(payload.mods) ||
      !payload.configs || typeof payload.configs !== 'object' || Array.isArray(payload.configs)) {
    throw new Error(message);
  }
  return payload;
}

function parseCode(value) {
  const match = typeof value === 'string' && value.length <= 100 && CODE.exec(value.trim());
  if (!match) throw new Error('Enter a valid Ember share code.');
  return match[1].toLowerCase();
}

async function cancelBody(response) {
  await response.body?.cancel().catch(() => {});
}

async function readLimited(response, maximum) {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maximum) {
    await cancelBody(response);
    throw new Error('Thunderstore returned a profile that is too large.');
  }
  if (!response.body) throw new Error('Thunderstore returned an empty profile response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        tooLarge = true;
        await reader.cancel().catch(() => {});
        throw new Error('Thunderstore returned a profile that is too large.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (tooLarge) throw error;
    await reader.cancel().catch(() => {});
    throw new Error('The profile download was interrupted. Check your connection and try again.');
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error('Thunderstore returned an unreadable profile.');
  }
}

function cdnTarget(location, key, from) {
  const url = new URL(location, from);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      !CDN_HOSTS.has(url.hostname) || url.pathname !== `/live/modpacks/legacyprofile/${key}`) {
    throw new Error('Thunderstore returned an unexpected profile download location.');
  }
  return url.href;
}

function createSharingClient({ fetchImpl = globalThis.fetch, resolvePackage = (gameId, ref) =>
  fetchProfilePackageVersion(gameId, ref.namespace, ref.name, ref.version) } = {}) {
  const published = new Map();
  const pending = new Map();

  async function request(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'manual' });
    } catch {
      throw new Error('Could not reach Thunderstore profile sharing. Check your connection and try again.');
    }
    if (response.status === 429) {
      await cancelBody(response);
      throw new Error('Thunderstore is limiting profile shares. Wait a minute and try again.');
    }
    if (response.status === 404) {
      await cancelBody(response);
      throw new Error('This share code could not be found. Check the code and try again.');
    }
    return response;
  }

  async function publishProfile(json, format = 'ember') {
    if (format !== 'ember' && format !== 'thunderstore') throw new Error('Choose an available share code format.');
    const profile = parseProfileJson(json);
    const digest = createHash('sha256').update(format).update(json).digest('hex');
    if (published.has(digest)) return published.get(digest);
    if (pending.has(digest)) return pending.get(digest);
    const work = (async () => {
      const content = format === 'ember' ? json : await encodeThunderstoreProfile(profile);
      const response = await request(`${ORIGIN}/api/experimental/legacyprofile/create/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
        body: content,
      });
      if (!response.ok) {
        await cancelBody(response);
        throw new Error(`Could not create a share code (HTTP ${response.status}). Try again later or export a JSON file.`);
      }
      const text = await readLimited(response, 4096);
      let body;
      try { body = JSON.parse(text); } catch { throw new Error('Thunderstore returned an invalid share code.'); }
      if (typeof body?.key !== 'string' || !new RegExp(`^${KEY}$`, 'i').test(body.key)) {
        throw new Error('Thunderstore returned an invalid share code.');
      }
      const key = body.key.toLowerCase();
      const code = format === 'ember' ? `EMBER-${key}` : key;
      published.set(digest, code);
      if (published.size > 50) published.delete(published.keys().next().value);
      return code;
    })();
    pending.set(digest, work);
    try { return await work; } finally { pending.delete(digest); }
  }

  async function downloadProfile(code, maximum) {
    const key = parseCode(code);
    let url = `${ORIGIN}/api/experimental/legacyprofile/get/${key}/`;
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await request(url, { headers: { Accept: '*/*' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await cancelBody(response);
        if (!location || redirects === 2) throw new Error('Thunderstore returned an invalid profile redirect.');
        try { url = cdnTarget(location, key, url); } catch {
          throw new Error('Thunderstore returned an unexpected profile download location.');
        }
        continue;
      }
      if (!response.ok) {
        await cancelBody(response);
        throw new Error(`Could not load this share code (HTTP ${response.status}). Try again later.`);
      }
      return readLimited(response, maximum);
    }
    throw new Error('Could not load this share code.');
  }

  async function resolveProfile(code) {
    const json = await downloadProfile(code, MAX_PROFILE_BYTES);
    parseProfileJson(json, true);
    return json;
  }

  async function resolveThunderstoreProfile(code, gameId) {
    if (!GAME_IDS.has(gameId)) throw new Error('Choose a supported game before importing.');
    try { parseCode(code); } catch { throw new Error('Enter a valid Thunderstore profile code.'); }
    const parsed = await parseThunderstoreProfile(await downloadProfile(code, MAX_NATIVE_PROFILE_BYTES), gameId);
    const packageKey = ref => `${ref.namespace}/${ref.name}`;
    const versionKey = ref => `${packageKey(ref)}@${ref.version}`;
    const versions = new Map();
    const unavailableUpgrades = new Map();
    const upgradedPins = new Map();
    function createEntries() {
      return new Map(parsed.mods.map(ref => [packageKey(ref), {
        ...ref, version: upgradedPins.get(packageKey(ref)) ?? ref.version, explicit: true, mod: null, unavailable: null,
      }]));
    }
    let entries = createEntries();
    const newer = (left, right) => {
      const a = left.split('.').map(Number), b = right.split('.').map(Number);
      for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
      return false;
    };
    function resolveVersion(ref) {
      const key = versionKey(ref);
      if (versions.has(key)) return versions.get(key);
      if (versions.size >= 3 * MAX_PROFILE_MODS) throw new Error('The profile has too many dependency version changes.');
      const result = (async () => {
        let mod;
        try {
          mod = await resolvePackage(gameId, ref);
        } catch (error) {
          if (error instanceof ThunderstorePackageUnavailableError) return { unavailable: error.message || 'This version is unavailable on Thunderstore.' };
          throw new Error(`Could not check ${ref.namespace}/${ref.name} v${ref.version}. ${error.message}`, { cause: error });
        }
        if (!mod || mod.id !== `${gameId}/${ref.namespace}/${ref.name}` || mod.namespace !== ref.namespace || mod.name !== ref.name || mod.version !== ref.version ||
            mod.gameId !== gameId || !Array.isArray(mod.dependencies) || mod.dependencies.length > 300) {
          throw new Error(`Could not resolve ${ref.namespace}/${ref.name} v${ref.version} for the selected game.`);
        }
        return { mod };
      })();
      versions.set(key, result);
      return result;
    }

    async function resolveEntries() {
      while (true) {
        const batch = [...entries.values()].filter(entry => !entry.mod && !entry.unavailable).slice(0, 3);
        if (!batch.length) return;
        const resolved = await Promise.all(batch.map(async entry => {
          const { namespace, name, version } = entry;
          return { entry, version, ...await resolveVersion({ namespace, name, version }) };
        }));
        for (const { entry, version, mod, unavailable } of resolved) {
          if (entry.version !== version) continue;
          if (unavailable) {
            entry.unavailable = unavailable;
            continue;
          }
          entry.mod = mod;
          for (const dependency of mod.dependencies) {
            if (typeof dependency?.namespace !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(dependency.namespace) ||
                typeof dependency.name !== 'string' || !/^[a-z0-9_]{1,128}$/i.test(dependency.name) ||
                typeof dependency.version !== 'string' || !/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(dependency.version)) {
              throw new Error('Thunderstore returned an invalid profile dependency.');
            }
            const key = packageKey(dependency);
            const existing = entries.get(key);
            if (!existing) {
              if (entries.size >= MAX_PROFILE_MODS) throw new Error(`The profile and its dependencies exceed ${MAX_PROFILE_MODS} mods.`);
              entries.set(key, { namespace: dependency.namespace, name: dependency.name, version: dependency.version, enabled: false, explicit: false, mod: null, unavailable: null });
            } else if (!existing.explicit && newer(dependency.version, existing.version)) {
              existing.version = dependency.version;
              existing.mod = null;
              existing.unavailable = null;
            }
          }
        }
      }
    }

    function findBlocked() {
      const blocked = new Map([...entries].filter(([, entry]) => entry.unavailable));
      let changed;
      do {
        changed = false;
        for (const [key, entry] of entries) {
          if (blocked.has(key)) continue;
          for (const ref of entry.mod.dependencies) {
            const target = packageKey(ref);
            const missing = blocked.get(target) ||
              (newer(ref.version, entries.get(target).version) && unavailableUpgrades.get(versionKey(ref)));
            if (!missing) continue;
            blocked.set(key, missing);
            changed = true;
            break;
          }
        }
      } while (changed);
      return blocked;
    }

    let blocked, reachable;
    while (true) {
      await resolveEntries();
      blocked = findBlocked();
      // If an upgrade has a missing dependency of its own, keep the original pin
      // available and skip only mods that need the unusable version.
      const failedPins = [...upgradedPins.keys()].filter(key => blocked.has(key));
      if (failedPins.length) {
        for (const key of failedPins) {
          const { namespace, name, version } = entries.get(key);
          const ref = { namespace, name, version };
          unavailableUpgrades.set(versionKey(ref), ref);
          upgradedPins.delete(key);
        }
        entries = createEntries();
        continue;
      }
      reachable = new Set();
      const upgrades = new Map();
      const visit = key => {
        if (reachable.has(key)) return;
        reachable.add(key);
        for (const ref of entries.get(key).mod.dependencies) {
          const target = packageKey(ref);
          if (newer(ref.version, entries.get(target).version) &&
              (!upgrades.has(target) || newer(ref.version, upgrades.get(target).version))) {
            upgrades.set(target, ref);
          }
          visit(target);
        }
      };
      for (const [key, entry] of entries) if (entry.explicit && !blocked.has(key)) visit(key);
      if (!upgrades.size) break;

      // Resolve the proposed versions before replacing working pins.
      const candidates = [...upgrades].slice(0, 3);
      const resolved = await Promise.all(candidates.map(async ([key, ref]) => ({
        key, ref, ...await resolveVersion({ namespace: ref.namespace, name: ref.name, version: ref.version }),
      })));
      for (const { key, ref, unavailable } of resolved) {
        if (unavailable) {
          unavailableUpgrades.set(versionKey(ref), ref);
        } else {
          const entry = entries.get(key);
          upgradedPins.set(key, ref.version);
          entry.version = ref.version;
          entry.mod = null;
        }
      }
    }

    const skippedMods = [];
    const versionChanges = [];
    for (const ref of parsed.mods) {
      const key = packageKey(ref);
      const missing = blocked.get(key);
      const entry = entries.get(key);
      if (missing) {
        const label = `${key} v${ref.version}`;
        skippedMods.push(missing === entry ? `${label} — ${missing.unavailable}`
          : `${label} — requires unavailable ${packageKey(missing)} v${missing.version}.`);
      } else if (entry.version !== ref.version) {
        versionChanges.push({ namespace: ref.namespace, name: ref.name, from: ref.version, to: entry.version });
      }
    }
    if (skippedMods.length && skippedMods.length === parsed.mods.length) {
      throw new Error('None of the mods in this profile can be imported. Check that you selected the right game or ask for a new profile code.');
    }

    for (const key of entries.keys()) if (!reachable.has(key)) entries.delete(key);
    // Only inferred dependencies follow enabled parents; explicit profile choices stay intact.
    let changed;
    do {
      changed = false;
      for (const entry of entries.values()) {
        if (!entry.enabled) continue;
        for (const dependency of entry.mod.dependencies) {
          const target = entries.get(packageKey(dependency));
          if (!target.explicit && !target.enabled) { target.enabled = true; changed = true; }
        }
      }
    } while (changed);
    const mods = [...entries.values()].map(entry => ({ id: entry.mod.id, version: entry.version, enabled: entry.enabled, package: entry.mod }));
    const unlistedMods = mods.filter(entry => entry.package.unlisted === true)
      .map(({ package: { namespace, name }, version }) => ({ namespace, name, version }));
    const result = JSON.stringify({ format: 'modrelay-profile', version: 1, source: 'thunderstore', gameId,
      name: parsed.name, mods, configs: {}, configFiles: parsed.configFiles,
      userDataFiles: parsed.userDataFiles, importWarnings: parsed.importWarnings, skippedMods, versionChanges, unlistedMods });
    if (Buffer.byteLength(result, 'utf8') > MAX_PROFILE_BYTES) throw new Error('The converted Ember profile exceeds 3 MB.');
    return result;
  }

  return { publishProfile, resolveProfile, resolveThunderstoreProfile };
}

module.exports = { createSharingClient, MAX_PROFILE_BYTES };
