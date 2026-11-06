const assert = require('node:assert/strict');
const test = require('node:test');
const { createSharingClient, MAX_PROFILE_BYTES } = require('../electron/sharing.cjs');

const key = '01a1ad5d-bee6-0706-b9fa-a899094432e0';
const code = `EMBER-${key}`;
const createUrl = 'https://thunderstore.io/api/experimental/legacyprofile/create/';
const getUrl = `https://thunderstore.io/api/experimental/legacyprofile/get/${key}/`;
const cdnUrl = `https://ccdn.thunderstore.io/live/modpacks/legacyprofile/${key}`;
const profile = JSON.stringify({
  format: 'modrelay-profile', version: 1, source: 'thunderstore', gameId: 'lethal-company', name: 'Café crew',
  mods: [{ id: 'lethal-company/Team/Plugin', version: '1.2.0', enabled: false, missingDependencies: ['lethal-company/Team/Runtime'],
    package: { namespace: 'Team', name: 'Plugin', version: '1.2.0', dependencies: [{ namespace: 'Team', name: 'Runtime', version: '1.0.0' }] } }],
  configs: { example: 'Welcome = café ☕' },
}, null, 2);

test('short sharing uploads exact profile bytes and resolves through the approved CDN on another client', async () => {
  const publisher = createSharingClient({ fetchImpl: async (url, options) => {
    assert.equal(url, createUrl);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/octet-stream');
    assert.equal(options.redirect, 'manual');
    assert(options.signal instanceof AbortSignal);
    assert.equal(options.body, profile);
    return new Response(JSON.stringify({ key: key.toUpperCase() }));
  } });
  assert.equal(await publisher.publishProfile(profile), code);
  const urls = [];
  const recipient = createSharingClient({ fetchImpl: async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Accept, '*/*');
    if (url === getUrl) return new Response(null, { status: 302, headers: { Location: cdnUrl } });
    assert.equal(url, cdnUrl);
    return new Response(profile);
  } });
  assert.equal(await recipient.resolveProfile(code), profile);
  assert.deepEqual(urls, [getUrl, cdnUrl]);
});

test('sharing coalesces concurrent identical snapshots and reuses a successful code', async () => {
  let calls = 0;
  let finish;
  const client = createSharingClient({ fetchImpl: async () => {
    calls++;
    await new Promise(resolve => { finish = resolve; });
    return new Response(JSON.stringify({ key }));
  } });
  const first = client.publishProfile(profile);
  const second = client.publishProfile(profile);
  finish();
  assert.deepEqual(await Promise.all([first, second]), [code, code]);
  assert.equal(await client.publishProfile(profile), code);
  assert.equal(calls, 1);
});

test('invalid profile envelopes, oversized UTF-8, and malformed share codes never make a request', async () => {
  const client = createSharingClient({ fetchImpl: async () => { throw new Error('Network must not run'); } });
  for (const value of ['', '{', '{}', JSON.stringify({ ...JSON.parse(profile), configs: [] }),
    JSON.stringify({ ...JSON.parse(profile), source: 'sample' }), 'é'.repeat(MAX_PROFILE_BYTES / 2 + 1)]) {
    await assert.rejects(client.publishProfile(value), /profile/i);
  }
  for (const value of ['', `https://thunderstore.io/${key}`, '../' + key, code + '/', 'EMBER-' + key + '?x=1', key.repeat(4)]) {
    await assert.rejects(client.resolveProfile(value), /valid Ember share code/);
  }
});

test('a bare uppercase UUID is accepted while native Thunderstore archives get an honest format error', async () => {
  let requested;
  const client = createSharingClient({ fetchImpl: async url => {
    requested = url;
    return new Response('#r2modman\nUEsDBAoA');
  } });
  await assert.rejects(client.resolveProfile(' ' + key.toUpperCase() + ' '), /does not contain an Ember profile/);
  assert.equal(requested, getUrl);
});

test('profile downloads refuse redirects outside the fixed host and profile path before following them', async () => {
  for (const location of [
    'https://evil.example/' + key,
    `http://ccdn.thunderstore.io/live/modpacks/legacyprofile/${key}`,
    `https://ccdn.thunderstore.io:8443/live/modpacks/legacyprofile/${key}`,
    `https://user@ccdn.thunderstore.io/live/modpacks/legacyprofile/${key}`,
    `https://ccdn.thunderstore.io/package/${key}`,
    cdnUrl + '?redirect=https://evil.example',
    cdnUrl + '#fragment',
    cdnUrl.replace(key, '00000000-0000-0000-0000-000000000000'),
  ]) {
    let calls = 0;
    const client = createSharingClient({ fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { Location: location } });
    } });
    await assert.rejects(client.resolveProfile(code), /unexpected profile download location/);
    assert.equal(calls, 1);
  }
});

test('profile downloads bound redirect chains and require a location', async () => {
  for (const headers of [{ Location: cdnUrl }, {}]) {
    let calls = 0;
    const client = createSharingClient({ fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 302, headers });
    } });
    await assert.rejects(client.resolveProfile(code), /invalid profile redirect/);
    assert(calls <= 3);
  }
});

test('profile downloads enforce byte limits on headers and chunked bodies', async () => {
  let canceled = false;
  const oversized = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_PROFILE_BYTES + 1)); },
    cancel() { canceled = true; },
  });
  const streamed = createSharingClient({ fetchImpl: async () => new Response(oversized) });
  await assert.rejects(streamed.resolveProfile(code), /too large/);
  assert.equal(canceled, true);
  const declared = createSharingClient({ fetchImpl: async () => new Response(profile, { headers: { 'Content-Length': String(MAX_PROFILE_BYTES + 1) } }) });
  await assert.rejects(declared.resolveProfile(code), /too large/);
});

test('create rejects unexpected API keys, redirects, and oversized API responses', async () => {
  for (const response of [
    new Response(JSON.stringify({ key: 'not-a-uuid' })),
    new Response(JSON.stringify({ key: code })),
    new Response('{'),
    new Response('x'.repeat(4097)),
    new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }),
  ]) {
    const client = createSharingClient({ fetchImpl: async () => response });
    await assert.rejects(client.publishProfile(profile), /share code|too large/);
  }
});

test('interrupted response streams report a retryable download error', async () => {
  const failed = new ReadableStream({ start(controller) { controller.error(new Error('socket closed')); } });
  const client = createSharingClient({ fetchImpl: async () => new Response(failed) });
  await assert.rejects(client.resolveProfile(code), /profile download was interrupted/);
});

test('service errors explain unavailable codes, rate limits, and network failures without poisoning retries', async () => {
  for (const [status, pattern] of [[404, /could not be found/], [429, /limiting profile shares/], [503, /HTTP 503/]]) {
    const client = createSharingClient({ fetchImpl: async () => new Response(null, { status }) });
    await assert.rejects(client.resolveProfile(code), pattern);
  }
  let attempts = 0;
  const client = createSharingClient({ fetchImpl: async () => {
    if (++attempts === 1) throw new Error('offline');
    return new Response(JSON.stringify({ key }));
  } });
  await assert.rejects(client.publishProfile(profile), /Could not reach Thunderstore/);
  assert.equal(await client.publishProfile(profile), code);
  assert.equal(attempts, 2);
});
