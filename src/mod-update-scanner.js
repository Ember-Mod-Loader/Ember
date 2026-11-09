const VERSION = /^\d{1,10}\.\d{1,10}\.\d{1,10}$/;
const MAX_CACHED_PACKAGES = 512;

export function createModUpdateScanner({
  fetchPackage, now = Date.now, maxAgeMs = 300_000, concurrency = 4,
}) {
  const cache = new Map();

  async function scan(mods, { signal, force = false } = {}) {
    const entries = [...new Map(mods.map(mod => [mod.id, mod])).values()];
    const results = [];
    const freshResults = [];
    let nextIndex = 0;
    let failed = 0;

    async function worker() {
      while (!signal?.aborted && nextIndex < entries.length) {
        const index = nextIndex++;
        const mod = entries[index];
        const cached = cache.get(mod.id);
        if (!force && cached && cached.expiresAt > now()) {
          results[index] = cached.listing;
          continue;
        }

        try {
          const listing = await fetchPackage(mod.gameId, mod.namespace, mod.name);
          if (signal?.aborted) return;
          if (listing?.id !== mod.id || listing.gameId !== mod.gameId ||
              listing.namespace !== mod.namespace || listing.name !== mod.name ||
              typeof listing.version !== 'string' || !VERSION.test(listing.version)) {
            failed++;
            continue;
          }
          results[index] = listing;
          freshResults[index] = listing;
          cache.delete(mod.id);
          if (cache.size >= MAX_CACHED_PACKAGES) cache.delete(cache.keys().next().value);
          cache.set(mod.id, { listing, expiresAt: now() + maxAgeMs });
        } catch {
          if (!signal?.aborted) failed++;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(entries.length, concurrency) }, worker));
    return { packages: results.filter(Boolean), freshPackages: freshResults.filter(Boolean), failed };
  }

  return { scan };
}
