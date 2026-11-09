const { createHash } = require('node:crypto');
const { parseThunderstoreProfile, MAX_NATIVE_PROFILE_BYTES } = require('./thunderstore-profile.cjs');
const { fetchListedPackageVersion, ThunderstorePackageUnavailableError } = require('./thunderstore.cjs');

const ORIGIN = 'https://thunderstore.io';
const MAX_PROFILE_BYTES = 3 * 1024 * 1024;
const KEY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CODE = new RegExp(`^(?:EMBER-)?(${KEY})$`, 'i');
const CDN_HOSTS = new Set(['ccdn.thunderstore.io', 'cdn.thunderstore.io', 'gcdn.thunderstore.io']);
const GAME_IDS = new Set(['lethal-company', 'repo', 'peak', 'mimesis']);

function profileJson(value, importing = false) {
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
  return value;
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
  fetchListedPackageVersion(gameId, ref.namespace, ref.name, ref.version) } = {}) {
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

  async function publishProfile(json) {
    profileJson(json);
    const digest = createHash('sha256').update(json).digest('hex');
    if (published.has(digest)) return published.get(digest);
    if (pending.has(digest)) return pending.get(digest);
    const work = (async () => {
      const response = await request(`${ORIGIN}/api/experimental/legacyprofile/create/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
        body: json,
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
      const code = `EMBER-${body.key.toLowerCase()}`;
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
    return profileJson(await downloadProfile(code, MAX_PROFILE_BYTES), true);
  }

  async function resolveThunderstoreProfile(code, gameId) {
    if (!GAME_IDS.has(gameId)) throw new Error('Choose a supported game before importing.');
    try { parseCode(code); } catch { throw new Error('Enter a valid Thunderstore profile code.'); }
    const parsed = await parseThunderstoreProfile(await downloadProfile(code, MAX_NATIVE_PROFILE_BYTES), gameId);
    const entries = new Map(parsed.mods.map(ref => [`${ref.namespace}/${ref.name}`, { ...ref, explicit: true, mod: null, unavailable: null }]));
    let requests = 0;
    const newer = (left, right) => {
      const a = left.split('.').map(Number), b = right.split('.').map(Number);
      for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
      return false;
    };
    while (true) {
      const batch = [...entries.values()].filter(entry => !entry.mod && !entry.unavailable).slice(0, 3);
      if (!batch.length) break;
      const resolved = await Promise.all(batch.map(async entry => {
        if (++requests > 1000) throw new Error('The profile has too many dependency version changes.');
        const ref = { namespace: entry.namespace, name: entry.name, version: entry.version };
        let mod;
        try {
          mod = await resolvePackage(gameId, ref);
        } catch (error) {
          if (error instanceof ThunderstorePackageUnavailableError) return { entry, ref, unavailable: error.message };
          throw new Error(`Could not check ${ref.namespace}/${ref.name} v${ref.version}. ${error.message}`, { cause: error });
        }
        if (!mod || mod.id !== `${gameId}/${ref.namespace}/${ref.name}` || mod.namespace !== ref.namespace || mod.name !== ref.name || mod.version !== ref.version ||
            mod.gameId !== gameId || !Array.isArray(mod.dependencies) || mod.dependencies.length > 300) {
          throw new Error(`Could not resolve ${ref.namespace}/${ref.name} v${ref.version} for the selected game.`);
        }
        return { entry, ref, mod };
      }));
      for (const { entry, ref, mod, unavailable } of resolved) {
        if (entry.version !== ref.version) continue;
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
          const key = `${dependency.namespace}/${dependency.name}`;
          const existing = entries.get(key);
          if (!existing) {
            if (entries.size >= 200) throw new Error('The profile and its dependencies exceed 200 mods.');
            entries.set(key, { namespace: dependency.namespace, name: dependency.name, version: dependency.version, enabled: false, explicit: false, mod: null, unavailable: null });
          } else if (!existing.explicit && newer(dependency.version, existing.version)) {
            existing.version = dependency.version;
            existing.mod = null;
            existing.unavailable = null;
          }
        }
      }
    }
    // Track the unavailable requirement that prevents each dependent from importing.
    const blocked = new Map([...entries].filter(([, entry]) => entry.unavailable));
    let changed;
    do {
      changed = false;
      for (const [key, entry] of entries) {
        if (blocked.has(key)) continue;
        const missing = entry.mod.dependencies.map(ref => blocked.get(`${ref.namespace}/${ref.name}`)).find(Boolean);
        if (missing) { blocked.set(key, missing); changed = true; }
      }
    } while (changed);
    const skippedMods = [];
    for (const [key, entry] of entries) {
      const missing = blocked.get(key);
      if (!entry.explicit || !missing) continue;
      const label = `${entry.namespace}/${entry.name} v${entry.version}`;
      skippedMods.push(missing === entry ? `${label} — ${missing.unavailable}`
        : `${label} — requires unavailable ${missing.namespace}/${missing.name} v${missing.version}.`);
    }
    if (skippedMods.length && skippedMods.length === parsed.mods.length) {
      throw new Error('None of the mods in this profile can be imported. Check that you selected the right game or ask for a new profile code.');
    }

    // Keep the closure of the remaining explicit mods and their final versions.
    const reachable = new Set();
    const visit = key => {
      if (reachable.has(key)) return;
      reachable.add(key);
      const { mod } = entries.get(key);
      for (const dependency of mod.dependencies) {
        const targetKey = `${dependency.namespace}/${dependency.name}`;
        const target = entries.get(targetKey);
        if (newer(dependency.version, target.version)) {
          throw new Error(`${mod.name} requires ${dependency.name} v${dependency.version}, but the shared profile selects v${target.version}.`);
        }
        visit(targetKey);
      }
    };
    for (const [key, entry] of entries) if (entry.explicit && !blocked.has(key)) visit(key);
    for (const key of entries.keys()) if (!reachable.has(key)) entries.delete(key);
    // Only inferred dependencies follow enabled parents; explicit profile choices stay intact.
    do {
      changed = false;
      for (const entry of entries.values()) {
        if (!entry.enabled) continue;
        for (const dependency of entry.mod.dependencies) {
          const target = entries.get(`${dependency.namespace}/${dependency.name}`);
          if (!target.explicit && !target.enabled) { target.enabled = true; changed = true; }
        }
      }
    } while (changed);
    const mods = [...entries.values()].map(entry => ({ id: entry.mod.id, version: entry.version, enabled: entry.enabled, package: entry.mod }));
    const result = JSON.stringify({ format: 'modrelay-profile', version: 1, source: 'thunderstore', gameId,
      name: parsed.name, mods, configs: {}, configFiles: parsed.configFiles,
      userDataFiles: parsed.userDataFiles, importWarnings: parsed.importWarnings, skippedMods });
    if (Buffer.byteLength(result, 'utf8') > MAX_PROFILE_BYTES) throw new Error('The converted Ember profile exceeds 3 MB.');
    return result;
  }

  return { publishProfile, resolveProfile, resolveThunderstoreProfile };
}

module.exports = { createSharingClient, MAX_PROFILE_BYTES };
