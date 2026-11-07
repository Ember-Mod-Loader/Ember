const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { request } = require('node:http');
const test = require('node:test');
const { createPresenceServer } = require('../backend/presence/server.cjs');

async function fixture(t, options = {}) {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const server = createPresenceServer({ now: () => time, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    advance: amount => { time += amount; },
    async call(path, method = 'GET', body, headers = {}) {
      const response = await fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
  };
}

test('presence counts concurrent sessions, renews one without duplication, and expires abandoned clients', async t => {
  const f = await fixture(t);
  const a = randomUUID(), b = randomUUID();
  assert.equal((await f.call('/health')).body.ok, true);
  assert.equal((await f.call('/v1/online')).body.online, 0);
  assert.equal((await f.call('/v1/heartbeat', 'POST', { sessionId: a })).body.online, 1);
  assert.equal((await f.call('/v1/heartbeat', 'POST', { sessionId: b })).body.online, 2);
  f.advance(30_000);
  const renewed = await f.call('/v1/heartbeat', 'POST', { sessionId: a.toUpperCase() });
  assert.equal(renewed.body.online, 2);
  assert.equal(renewed.body.ttlSeconds, 90);
  f.advance(60_000);
  assert.equal((await f.call('/v1/online')).body.online, 1);
  f.advance(30_000);
  const empty = await f.call('/v1/online');
  assert.equal(empty.body.online, 0);
  assert.equal(empty.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(empty.body).sort(), ['online', 'serverTime', 'ttlSeconds']);
});

test('leaving removes only the specified session and is idempotent', async t => {
  const f = await fixture(t);
  const a = randomUUID(), b = randomUUID();
  await f.call('/v1/heartbeat', 'POST', { sessionId: a });
  await f.call('/v1/heartbeat', 'POST', { sessionId: b });
  assert.equal((await f.call('/v1/session', 'DELETE', { sessionId: a })).body.online, 1);
  assert.equal((await f.call('/v1/session', 'DELETE', { sessionId: a })).body.online, 1);
  assert.equal((await f.call('/v1/session', 'DELETE', { sessionId: b })).body.online, 0);
});

test('invalid bodies, browser origins, unknown paths, and methods never create sessions', async t => {
  const f = await fixture(t);
  for (const body of [{}, [], null, { sessionId: 'person@example.test' }, { sessionId: randomUUID(), username: 'private' }]) {
    assert.equal((await f.call('/v1/heartbeat', 'POST', body)).status, 400);
  }
  assert.equal((await f.call('/v1/heartbeat', 'POST', { sessionId: randomUUID() }, { origin: 'https://example.test' })).status, 403);
  assert.equal((await f.call('/v1/heartbeat', 'GET')).status, 405);
  assert.equal((await f.call('/v1/heartbeat', 'POST', { sessionId: randomUUID() }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.call('/v1/online?session=secret')).status, 404);
  assert.equal((await f.call('/v1/online')).body.online, 0);
});

test('oversized request bodies are rejected before being stored', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/v1/heartbeat', 'POST', { sessionId: 'x'.repeat(400) })).status, 413);
  const status = await new Promise((resolve, reject) => {
    const req = request(f.origin + '/v1/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end('x'.repeat(1000));
  });
  assert.equal(status, 413);
  assert.equal((await f.call('/v1/online')).body.online, 0);
});

test('heartbeat cooldown and bounded capacity protect existing sessions without inventing new ones', async t => {
  const f = await fixture(t, { maxSessions: 2 });
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  await f.call('/v1/heartbeat', 'POST', { sessionId: a });
  assert.equal((await f.call('/v1/heartbeat', 'POST', { sessionId: a })).status, 429);
  await f.call('/v1/heartbeat', 'POST', { sessionId: b });
  const full = await f.call('/v1/heartbeat', 'POST', { sessionId: c });
  assert.equal(full.status, 503);
  assert.equal(full.headers.get('retry-after'), '30');
  f.advance(30_000);
  assert.equal((await f.call('/v1/heartbeat', 'POST', { sessionId: a })).body.online, 2);
  f.advance(60_000);
  assert.equal((await f.call('/v1/heartbeat', 'POST', { sessionId: c })).body.online, 2);
});

test('rapid restarts replace one lease and stale requests cannot remove or renew its newer connection', async t => {
  const f = await fixture(t);
  const sessionId = randomUUID();
  const first = { sessionId, connectionId: randomUUID(), generation: 1 };
  const second = { sessionId, connectionId: randomUUID(), generation: 2 };
  assert.equal((await f.call('/v1/heartbeat', 'POST', first)).body.online, 1);
  assert.equal((await f.call('/v1/heartbeat', 'POST', second)).body.online, 1);
  assert.equal((await f.call('/v1/session', 'DELETE', first)).body.online, 1);
  assert.equal((await f.call('/v1/heartbeat', 'POST', first)).status, 409);
  assert.equal((await f.call('/v1/heartbeat', 'POST', { ...second, connectionId: randomUUID() })).status, 409);
  assert.equal((await f.call('/v1/session', 'DELETE', { sessionId })).body.online, 1);
  assert.equal((await f.call('/v1/heartbeat', 'POST', { sessionId })).status, 409);
  assert.equal((await f.call('/v1/session', 'DELETE', second)).body.online, 0);
  assert.equal((await f.call('/v1/heartbeat', 'POST', second)).status, 409);
  assert.equal((await f.call('/v1/heartbeat', 'POST', { sessionId, connectionId: randomUUID(), generation: 3 })).body.online, 1);
});

test('a leave arriving before its heartbeat retires that connection without inventing an online client', async t => {
  const f = await fixture(t);
  const identity = { sessionId: randomUUID(), connectionId: randomUUID(), generation: 1 };
  assert.equal((await f.call('/v1/session', 'DELETE', identity)).body.online, 0);
  assert.equal((await f.call('/v1/heartbeat', 'POST', identity)).status, 409);
  f.advance(30_000);
  await f.call('/v1/session', 'DELETE', identity);
  f.advance(90_000);
  assert.equal((await f.call('/v1/heartbeat', 'POST', identity)).body.online, 1);
});

test('invalid modern connection metadata does not register sessions', async t => {
  const f = await fixture(t);
  const valid = { sessionId: randomUUID(), connectionId: randomUUID(), generation: 1 };
  for (const body of [{ ...valid, generation: 0 }, { ...valid, generation: 1.5 }, { ...valid, generation: '1' },
    { ...valid, connectionId: 'invalid' }, { ...valid, username: 'private' }]) {
    assert.equal((await f.call('/v1/heartbeat', 'POST', body)).status, 400);
  }
  assert.equal((await f.call('/v1/online')).body.online, 0);
});
