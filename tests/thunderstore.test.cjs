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

test('update lookups share the latest listing cache without fetching dependency details', async t => {
  const api = service(t, ({ pathname }) => pathname.includes('/listing/')
    ? Response.json(listing({ dependency_count: 1, dependencies: [], is_deprecated: true }))
    : Response.json({
      namespace: 'Team-Name',
      name: 'Plugin',
      version_number: '1.2.3',
      is_active: true,
      dependencies: ['Shared-Team-Runtime-2.10.0'],
    }));
  const args = [gameId, 'Team-Name', 'Plugin'];
  const [first, second] = await Promise.all([api.fetchPackageUpdate(...args), api.fetchPackageUpdate(...args)]);

  assert.deepEqual(first, second);
  assert.equal(first.id, 'lethal-company/Team-Name/Plugin');
  assert.equal(first.version, '1.2.3');
  assert.equal(first.deprecated, true);
  assert.deepEqual(first.dependencies, []);
  assert.deepEqual(api.requests.map(url => url.pathname), [
    '/api/cyberstorm/listing/lethal-company/Team-Name/Plugin/',
  ]);

  const full = await api.fetchPackage(...args);
  assert.equal(full.dependencies[0].version, '2.10.0');
  assert.deepEqual({ ...full, dependencies: [] }, first);
  assert.deepEqual(api.requests.map(url => url.pathname), [
    '/api/cyberstorm/listing/lethal-company/Team-Name/Plugin/',
    '/api/experimental/package/Team-Name/Plugin/1.2.3/',
  ]);
});

test('update lookups reject mismatched, restricted, or unversioned listings', async t => {
  const api = service(t, ({ pathname }) => Response.json(listing({
    name: 'WrongPlugin',
    ...({
      OtherGame: { community_identifier: 'repo', name: 'OtherGame' },
      OtherTeam: { namespace: 'Other-Team', name: 'OtherTeam' },
      Restricted: { name: 'Restricted', is_nsfw: true },
      BadVersion: { name: 'BadVersion', latest_version_number: 'unknown' },
    })[pathname.split('/').at(-2)],
  })));

  for (const name of ['Plugin', 'OtherGame', 'OtherTeam', 'Restricted', 'BadVersion']) {
    await assert.rejects(() => api.fetchPackageUpdate(gameId, 'Team-Name', name), /no matching package/);
  }
  assert.equal(api.requests.length, 5);
});

test('deprecated search is opt-in, keeps tag/status metadata, and does not include NSFW packages', async t => {
  const api = service(t, ({ pathname, searchParams }) => pathname.endsWith('/filters/')
    ? Response.json({ package_categories: [] })
    : Response.json({ count: 2, next: null, results: [
      listing({ name: searchParams.has('deprecated') ? 'OldPlugin' : 'CurrentPlugin', is_deprecated: searchParams.has('deprecated'), is_pinned: true }),
      listing({ name: 'Filtered', is_nsfw: true }),
    ] }));
  const current = await api.fetchCatalog({ gameId });
  const included = await api.fetchCatalog({ gameId, showDeprecated: true });
  const queries = api.requests.filter(url => url.pathname.includes('/listing/')).map(url => url.searchParams);
  assert.equal(queries[0].has('deprecated'), false);
  assert.equal(queries[1].get('deprecated'), 'true');
  assert.equal(queries[1].has('nsfw'), false);
  assert.equal(current.mods[0].deprecated, false);
  assert.deepEqual(included.mods.map(mod => [mod.name, mod.deprecated, mod.pinned, mod.nsfw, mod.categories]), [
    ['OldPlugin', true, true, false, [{ id: '19', name: 'Gameplay' }]],
  ]);
  await assert.rejects(() => api.fetchCatalog({ gameId, showDeprecated: 'true' }), /invalid Thunderstore search/i);
});

test('exact-version downloads reuse cached listing tags and flags without an extra metadata request', async t => {
  const api = service(t, ({ pathname }) => pathname.includes('/listing/')
    ? Response.json(listing({ is_deprecated: true, is_pinned: true, dependency_count: 0, dependencies: [] }))
    : Response.json({ namespace: 'Team-Name', name: 'Plugin', version_number: '1.0.0', is_active: true, dependencies: [] }));
  await api.fetchPackage(gameId, 'Team-Name', 'Plugin');
  const old = await api.fetchPackageVersion(gameId, 'Team-Name', 'Plugin', '1.0.0');
  assert.equal(old.version, '1.0.0');
  assert.equal(old.deprecated, true);
  assert.equal(old.pinned, true);
  assert.deepEqual(old.categories, [{ id: '19', name: 'Gameplay' }]);
  assert.equal(api.requests.length, 2);
});

test('profile lookups require the game listing, reuse its latest version, and resolve only the requested older version', async t => {
  const api = service(t, ({ pathname }) => {
    if (pathname.includes('/listing/')) {
      return Response.json(listing(pathname.includes('/OldPlugin/')
        ? { name: 'OldPlugin', dependency_count: 1, dependencies: [] }
        : { dependency_count: 0, dependencies: [] }));
    }
    assert.equal(pathname, '/api/experimental/package/Team-Name/OldPlugin/1.0.0/');
    return Response.json({
      namespace: 'Team-Name', name: 'OldPlugin', version_number: '1.0.0', is_active: true,
      dependencies: ['Shared-Team-Runtime-2.10.0'],
    });
  });
  const latest = await api.fetchListedPackageVersion(gameId, 'Team-Name', 'Plugin', '1.2.3');
  assert.equal(latest.version, '1.2.3');
  const older = await api.fetchListedPackageVersion(gameId, 'Team-Name', 'OldPlugin', '1.0.0');
  assert.equal(older.version, '1.0.0');
  assert.equal(older.dependencies[0].version, '2.10.0');
  assert.deepEqual(api.requests.map(url => url.pathname), [
    '/api/cyberstorm/listing/lethal-company/Team-Name/Plugin/',
    '/api/cyberstorm/listing/lethal-company/Team-Name/OldPlugin/',
    '/api/experimental/package/Team-Name/OldPlugin/1.0.0/',
  ]);
});

test('profile lookups distinguish unavailable packages from unexpected metadata and service failures', async t => {
  const api = service(t, ({ pathname }) => {
    const scoped = pathname.includes('/listing/');
    const name = pathname.split('/').at(scoped ? -2 : -3);
    if (scoped) {
      if (name === 'Unlisted') return new Response(null, { status: 404 });
      if (name === 'ServiceError') return new Response(null, { status: 503 });
      return Response.json(listing({ name, is_nsfw: name === 'Restricted',
        community_identifier: name === 'OtherGame' ? 'repo' : gameId }));
    }
    if (name === 'UnknownVersion') return new Response(null, { status: 404 });
    return Response.json({
      namespace: 'Team-Name', name, version_number: '1.0.0',
      is_active: name === 'InactiveVersion' ? false : 'no', dependencies: [],
    });
  });
  const lookup = name => api.fetchListedPackageVersion(gameId, 'Team-Name', name, '1.0.0');
  for (const name of ['Unlisted', 'Restricted', 'UnknownVersion', 'InactiveVersion']) {
    await assert.rejects(() => lookup(name), api.ThunderstorePackageUnavailableError);
  }
  assert(api.requests.every(({ pathname }) => !pathname.includes('/api/experimental/package/Team-Name/Unlisted/') &&
    !pathname.includes('/api/experimental/package/Team-Name/Restricted/')));
  for (const name of ['ServiceError', 'OtherGame', 'MalformedVersion']) {
    await assert.rejects(() => lookup(name), error => !(error instanceof api.ThunderstorePackageUnavailableError));
  }
});

test('invalid queries, package identities, and versions do not send network requests', async t => {
  const api = service(t, () => assert.fail('unexpected network request'));
  await assert.rejects(() => api.fetchCatalog({ gameId: '../another-game' }), /does not support/);
  await assert.rejects(() => api.fetchCatalog({ gameId, page: 0 }), /invalid Thunderstore search/i);
  await assert.rejects(() => api.fetchCatalog({ gameId, category: '1&evil' }), /invalid Thunderstore search/i);
  await assert.rejects(() => api.fetchPackage(gameId, '../escape', 'Plugin'), /invalid Thunderstore package/i);
  await assert.rejects(() => api.fetchPackageUpdate(gameId, '../escape', 'Plugin'), /invalid Thunderstore package/i);
  await assert.rejects(() => api.fetchPackageVersion(gameId, 'Team-Name', 'Plugin', '../1.2.3'), /invalid Thunderstore package version/i);
  await assert.rejects(() => api.fetchListedPackageVersion(gameId, 'Team-Name', 'Plugin', '../1.2.3'), /invalid Thunderstore package version/i);
  assert.deepEqual(api.requests, []);
});

