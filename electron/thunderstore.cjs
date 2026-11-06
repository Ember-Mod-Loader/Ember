const ORIGIN = 'https://thunderstore.io';
const COMMUNITIES = new Map([
  ['lethal-company', 'lethal-company'],
  ['repo', 'repo'],
  ['peak', 'peak'],
  ['valheim', 'valheim'],
  ['risk-of-rain-2', 'riskofrain2'],
]);
const ORDERS = new Map([
  ['popular', 'most-downloaded'],
  ['rating', 'top-rated'],
  ['updated', 'last-updated'],
  ['newest', 'newest'],
]);
const ICON_HOSTS = new Set(['ccdn.thunderstore.io', 'cdn.thunderstore.io']);
const NAMESPACE = /^[a-z0-9_-]{1,64}$/i;
const NAME = /^[a-z0-9_]{1,128}$/i;
const VERSION = /^\d{1,10}\.\d{1,10}\.\d{1,10}$/;
const DEPENDENCY = /^([a-z0-9_-]{1,64})-([a-z0-9_]{1,128})-(\d{1,10}\.\d{1,10}\.\d{1,10})$/i;
const cache = new Map();
const pending = new Map();
let retryAt = 0;

function community(gameId) {
  const identifier = COMMUNITIES.get(gameId);
  if (!identifier) throw new Error('Thunderstore does not support this game in Ember.');
  return identifier;
}

function validIdentity(namespace, name) {
  return typeof namespace === 'string' && NAMESPACE.test(namespace) &&
    typeof name === 'string' && NAME.test(name);
}

function validVersion(version) {
  return typeof version === 'string' && VERSION.test(version);
}

function packageIdentity(gameId, namespace, name) {
  if (!validIdentity(namespace, name)) throw new Error('Invalid Thunderstore package name.');
  return { id: `${gameId}/${namespace}/${name}`, namespace, name };
}

function packagePage(communityId, namespace, name) {
  return `${ORIGIN}/c/${communityId}/p/${namespace}/${name}/`;
}

function packageDownload(namespace, name, version) {
  return `${ORIGIN}/package/download/${namespace}/${name}/${version}/`;
}

function safeIcon(value) {
  const url = typeof value === 'string' && URL.parse(value);
  return url && url.protocol === 'https:' && ICON_HOSTS.has(url.host) &&
    !url.username && !url.password ? url.href : '';
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function categoryList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(category => category && typeof category.id === 'string' && /^\d{1,12}$/.test(category.id) &&
    typeof category.name === 'string' && category.name.length > 0)
    .map(({ id, name }) => ({ id, name: name.slice(0, 100) }));
}

function readDependencies(gameId, dependencies) {
  if (!Array.isArray(dependencies)) throw new Error('Thunderstore returned incomplete dependency information.');
  return dependencies.map(value => {
    const match = typeof value === 'string' && DEPENDENCY.exec(value);
    if (!match) throw new Error('Thunderstore returned an invalid dependency.');
    const [, namespace, name, version] = match;
    return { ...packageIdentity(gameId, namespace, name), version };
  });
}

function normalizeListing(gameId, communityId, value) {
  const identity = packageIdentity(gameId, value.namespace, value.name);
  const categories = categoryList(value.categories);
  const version = validVersion(value.latest_version_number) ? value.latest_version_number : null;
  const category = categories.find(({ name }) => !['BepInEx', 'Mods', 'Misc'].includes(name))?.name ??
    categories[0]?.name ?? 'Mods';
  return {
    ...identity,
    gameId,
    author: identity.namespace,
    description: typeof value.description === 'string' ? value.description.slice(0, 512) : '',
    icon: safeIcon(value.icon_url),
    category,
    categories,
    downloads: count(value.download_count),
    updatedAt: typeof value.last_updated === 'string' && Number.isFinite(Date.parse(value.last_updated)) ? value.last_updated : null,
    rating: count(value.rating_count),
    size: count(value.size),
    pinned: value.is_pinned === true,
    deprecated: value.is_deprecated === true,
    url: packagePage(communityId, identity.namespace, identity.name),
    version,
    dependencies: [],
    downloadUrl: version ? packageDownload(identity.namespace, identity.name, version) : '',
  };
}

async function request(url) {
  if (retryAt > Date.now()) throw new Error('Thunderstore is limiting requests. Wait a moment, then try again.');
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
      redirect: 'error',
    });
  } catch {
    throw new Error('Could not reach Thunderstore. Check your connection and try again.');
  }
  if (response.status === 429) {
    const header = response.headers.get('retry-after') ?? '';
    const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    retryAt = Date.now() + Math.min(60000, Math.max(1000, delay || 10000));
    throw new Error('Thunderstore is limiting requests. Wait a moment, then try again.');
  }
  if (response.status === 404) throw new Error('Thunderstore could not find this package or catalog page.');
  if (!response.ok) throw new Error(`Thunderstore is unavailable right now (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error('Thunderstore returned an unreadable response. Try again in a moment.');
  }
}

function getJson(path, ttl) {
  const cached = cache.get(path);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.body);
  if (pending.has(path)) return pending.get(path);
  const result = request(`${ORIGIN}${path}`).then(body => {
    cache.delete(path);
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(path, { body, expires: Date.now() + ttl });
    return body;
  }).finally(() => pending.delete(path));
  pending.set(path, result);
  return result;
}

async function fetchCatalog({ gameId, query = '', sort = 'popular', page = 1, category = '' } = {}) {
  const communityId = community(gameId);
  if (typeof query !== 'string' || query.length > 160 || !ORDERS.has(sort) ||
    !Number.isSafeInteger(page) || page < 1 || page > 10000 ||
    typeof category !== 'string' || (category && !/^\d{1,12}$/.test(category))) {
    throw new Error('Invalid Thunderstore search options.');
  }
  const params = new URLSearchParams({ ordering: ORDERS.get(sort), page: String(page) });
  if (query.trim()) params.set('q', query.trim());
  if (category) params.set('included_categories', category);
  const [listing, filters] = await Promise.all([
    getJson(`/api/cyberstorm/listing/${communityId}/?${params}`, 5 * 60_000),
    getJson(`/api/cyberstorm/community/${communityId}/filters/`, 60 * 60_000),
  ]);
  if (!Array.isArray(listing?.results)) throw new Error('Thunderstore returned an invalid catalog.');
  const mods = listing.results.filter(value => value?.community_identifier === communityId &&
    !value.is_nsfw && validIdentity(value.namespace, value.name))
    .map(value => normalizeListing(gameId, communityId, value));
  return {
    mods,
    count: count(listing.count),
    hasMore: typeof listing.next === 'string' && Boolean(listing.next),
    categories: categoryList(filters?.package_categories),
  };
}

async function fetchPackage(gameId, namespace, name) {
  const communityId = community(gameId);
  packageIdentity(gameId, namespace, name);
  const value = await getJson(`/api/cyberstorm/listing/${communityId}/${namespace}/${name}/`, 3 * 60_000);
  if (value?.community_identifier !== communityId || value.namespace !== namespace || value.name !== name ||
    value.is_nsfw || !validVersion(value.latest_version_number)) {
    throw new Error('Thunderstore has no matching package for this game.');
  }
  const mod = normalizeListing(gameId, communityId, value);
  if (!Array.isArray(value.dependencies) || value.dependencies.length !== value.dependency_count ||
    value.dependencies.some(ref => !validIdentity(ref?.namespace, ref?.name) || !validVersion(ref?.version_number))) {
    const exact = await fetchPackageVersion(gameId, namespace, name, mod.version);
    return { ...mod, dependencies: exact.dependencies };
  }
  const dependencies = value.dependencies.map(ref => ({
    ...packageIdentity(gameId, ref.namespace, ref.name), version: ref.version_number,
  }));
  return { ...mod, dependencies };
}

async function fetchPackageVersion(gameId, namespace, name, version) {
  const communityId = community(gameId);
  const identity = packageIdentity(gameId, namespace, name);
  if (!validVersion(version)) throw new Error('Invalid Thunderstore package version.');
  const value = await getJson(`/api/experimental/package/${namespace}/${name}/${version}/`, 15 * 60_000);
  if (value?.namespace !== namespace || value.name !== name || value.version_number !== version || value.is_active !== true) {
    throw new Error(`Thunderstore does not have an active ${namespace}/${name} v${version} download.`);
  }
  return {
    ...normalizeListing(gameId, communityId, {
      ...identity,
      description: value.description,
      icon_url: value.icon,
      download_count: value.downloads,
      latest_version_number: version,
    }),
    dependencies: readDependencies(gameId, value.dependencies),
  };
}

module.exports = { fetchCatalog, fetchPackage, fetchPackageVersion };
