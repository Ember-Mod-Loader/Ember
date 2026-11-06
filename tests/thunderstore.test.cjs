const assert = require('node:assert/strict');
const test = require('node:test');

const modulePath = require.resolve('../electron/thunderstore.cjs');
const origin = 'https://thunderstore.io';
const gameId = 'lethal-company';

function service(t, responseFor) {
  delete require.cache[modulePath];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url);
    assert.equal(request.origin, origin);
    assert.equal(options.redirect, 'error');
    requests.push(request);
    return responseFor(request);
  });
  return { ...require(modulePath), requests };
}

function listing(fields = {}) {
  return {
    community_identifier: gameId,
    namespace: 'Team-Name',
    name: 'Plugin',
    latest_version_number: '1.2.3',
    description: 'A test listing.',
    icon_url: 'https://ccdn.thunderstore.io/plugin.png',
    categories: [{ id: '19', name: 'Gameplay' }],
    download_count: 12,
    ...fields,
  };
}

test('catalog normalizes the selected community, encodes search options, and coalesces requests', async t => {
  const api = service(t, ({ pathname }) => pathname.endsWith('/filters/')
    ? Response.json({ package_categories: [{ id: '19', name: 'Gameplay' }, { id: '../x', name: 'Unsafe' }] })
    : Response.json({
      count: 4,
      next: 'next-page',
      results: [
        listing(),
        listing({ name: 'Other', icon_url: 'https://ccdn.thunderstore.io.example.test/unsafe.png' }),
        listing({ community_identifier: 'repo' }),
        listing({ is_nsfw: true }),
        listing({ name: '../unsafe' }),
      ],
    }));
  const options = { gameId, query: 'space & symbols', sort: 'rating', page: 2, category: '19' };
  const [first, second] = await Promise.all([api.fetchCatalog(options), api.fetchCatalog(options)]);

  assert.deepEqual(first, second);
  assert.equal(api.requests.length, 2);
  const query = api.requests.find(url => url.pathname.includes('/listing/')).searchParams;
  assert.equal(query.get('q'), options.query);
  assert.equal(query.get('page'), '2');
  assert.equal(query.get('ordering'), 'top-rated');
  assert.equal(query.get('included_categories'), '19');
  assert.deepEqual(first.mods.map(mod => [mod.id, mod.icon]), [
    ['lethal-company/Team-Name/Plugin', 'https://ccdn.thunderstore.io/plugin.png'],
    ['lethal-company/Team-Name/Other', ''],
  ]);
  assert.deepEqual(first.categories, [{ id: '19', name: 'Gameplay' }]);
  assert.equal(first.hasMore, true);
});

test('package details recover exact dependency versions from the version API', async t => {
  const api = service(t, ({ pathname }) => pathname.includes('/listing/')
    ? Response.json(listing({ dependency_count: 1, dependencies: [] }))
    : Response.json({
      namespace: 'Team-Name',
      name: 'Plugin',
      version_number: '1.2.3',
      is_active: true,
      dependencies: ['Shared-Team-Runtime-2.10.0'],
    }));

  const result = await api.fetchPackage(gameId, 'Team-Name', 'Plugin');
  assert.deepEqual(result.dependencies, [
    { id: 'lethal-company/Shared-Team/Runtime', namespace: 'Shared-Team', name: 'Runtime', version: '2.10.0' },
  ]);
  assert.deepEqual(api.requests.map(url => url.pathname), [
    '/api/cyberstorm/listing/lethal-company/Team-Name/Plugin/',
    '/api/experimental/package/Team-Name/Plugin/1.2.3/',
  ]);
});

test('invalid queries, package identities, and versions do not send network requests', async t => {
  const api = service(t, () => assert.fail('unexpected network request'));
  await assert.rejects(() => api.fetchCatalog({ gameId: '../another-game' }), /does not support/);
  await assert.rejects(() => api.fetchCatalog({ gameId, page: 0 }), /invalid Thunderstore search/i);
  await assert.rejects(() => api.fetchCatalog({ gameId, category: '1&evil' }), /invalid Thunderstore search/i);
  await assert.rejects(() => api.fetchPackage(gameId, '../escape', 'Plugin'), /invalid Thunderstore package/i);
  await assert.rejects(() => api.fetchPackageVersion(gameId, 'Team-Name', 'Plugin', '../1.2.3'), /invalid Thunderstore package version/i);
  assert.deepEqual(api.requests, []);
});

