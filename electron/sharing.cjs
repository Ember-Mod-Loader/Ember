const { createHash } = require('node:crypto');

const ORIGIN = 'https://thunderstore.io';
const MAX_PROFILE_BYTES = 3 * 1024 * 1024;
const KEY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CODE = new RegExp(`^(?:EMBER-)?(${KEY})$`, 'i');
const CDN_HOSTS = new Set(['ccdn.thunderstore.io', 'cdn.thunderstore.io', 'gcdn.thunderstore.io']);
const GAME_IDS = new Set(['lethal-company', 'repo', 'peak']);

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

function createSharingClient({ fetchImpl = globalThis.fetch } = {}) {
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

  async function resolveProfile(code) {
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
      return profileJson(await readLimited(response, MAX_PROFILE_BYTES), true);
    }
    throw new Error('Could not load this share code.');
  }

  return { publishProfile, resolveProfile };
}

module.exports = { createSharingClient, MAX_PROFILE_BYTES };
