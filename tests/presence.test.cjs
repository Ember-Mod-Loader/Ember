const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { setImmediate: tick } = require('node:timers/promises');
const { createPresenceServer } = require('../backend/presence/server.cjs');
const {
  createPresence, HEARTBEAT_MS, REQUEST_TIMEOUT_MS, MAX_BACKOFF_MS,
  STALE_TTL_MS, LEAVE_TIMEOUT_MS, MAX_RESPONSE_BYTES,
} = require('../electron/presence.cjs');

async function settle() { await tick(); await tick(); }

function clock() {
  let current = Date.parse('2026-11-06T12:00:00.000Z');
  const timers = new Map();
  return {
    options: {
      now: () => current,
      setTimer(callback, delay) {
        const handle = { unref() {} };
        timers.set(handle, { callback, at: current + delay });
        return handle;
      },
      clearTimer: handle => timers.delete(handle),
    },
    time: () => new Date(current).toISOString(),
    delays: () => [...timers.values()].map(timer => timer.at - current).sort((a, b) => a - b),
    jump(ms) { current += ms; },
    async advance(ms) {
      current += ms;
      for (let turns = 0; turns < 100; turns++) {
        const next = [...timers].find(([, timer]) => timer.at <= current);
        if (!next) { await settle(); return; }
        timers.delete(next[0]);
        const result = next[1].callback();
        if (result?.catch) result.catch(() => {});
        await settle();
      }
      throw new Error('Presence timers did not settle.');
    },
  };
}

function response(online, serverTime = '2026-11-06T12:00:00.000Z', extra = {}) {
  return new Response(JSON.stringify({ online, ttlSeconds: 90, serverTime, ...extra }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(fakeClock, options) {
  return createPresence({ endpoint: 'https://presence.example', ...fakeClock.options, ...options });
}

test('unconfigured presence never sends requests, creates timers, or reports a fabricated count', async () => {
  const time = clock();
  let calls = 0;
  const presence = createPresence({ ...time.options, fetchImpl() { calls++; throw new Error('Must not run'); } });
  assert.deepEqual(presence.getStatus(), { status: 'not-configured', count: null, updatedAt: null });
  presence.start(); presence.start();
  await presence.dispose();
  await presence.dispose();
  assert.equal(calls, 0);
  assert.deepEqual(time.delays(), []);
});

test('presence endpoints are fixed HTTPS origins and localhost needs an explicit test opt-in', async () => {
  for (const endpoint of ['http://presence.example', 'https://user:password@presence.example',
    'https://presence.example/path', 'https://presence.example?x=1', 'https://presence.example/#fragment',
    'file:///tmp/service', '/relative', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 123]) {
    assert.throws(() => createPresence({ endpoint }), /HTTPS presence service/);
  }
  const time = clock();
  const requests = [];
  const presence = createPresence({ endpoint: 'http://127.0.0.1:4567/', allowLocalhost: true, ...time.options,
    fetchImpl(url, options) { requests.push(url); return options.method === 'DELETE' ? new Response(null, { status: 204 }) : response(1); },
  });
  presence.start(); await settle(); await presence.dispose();
  assert.deepEqual(requests, ['http://127.0.0.1:4567/v1/heartbeat', 'http://127.0.0.1:4567/v1/session']);
  assert.throws(() => createPresence({ endpoint: 'http://presence.example', allowLocalhost: true }), /HTTPS presence service/);
});

test('heartbeats publish real counts, reuse one ephemeral session, and expose defensive snapshots', async () => {
  const time = clock();
  const requests = [];
  let count = 3;
  const presence = client(time, {
    publish: status => { status.count = 999; },
    fetchImpl(url, options) {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return options.method === 'DELETE' ? new Response(null, { status: 204 }) : response(count++, time.time());
    },
  });
  assert.equal(presence.start().status, 'connecting');
  presence.start();
  assert.equal(requests.length, 1);
  await settle();
  assert.deepEqual(presence.getStatus(), { status: 'online', count: 3, updatedAt: time.time() });
  const snapshot = presence.getStatus(); snapshot.count = 777;
  assert.equal(presence.getStatus().count, 3);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.deepEqual(Object.keys(requests[0].body), ['sessionId']);
  assert.match(requests[0].body.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await time.advance(HEARTBEAT_MS);
  assert.equal(presence.getStatus().count, 4);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, requests[0].body);
  await presence.dispose();
  assert.deepEqual(requests[2].body, requests[0].body);
  assert.equal(requests[2].options.method, 'DELETE');
  assert.deepEqual(time.delays(), []);
});

test('a new client gets a new session and a genuine server count of zero remains valid', async () => {
  const ids = [];
  for (let index = 0; index < 2; index++) {
    const time = clock();
    const presence = client(time, { fetchImpl(url, options) {
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      ids.push(JSON.parse(options.body).sessionId);
      return response(0);
    } });
    presence.start(); await settle();
    assert.equal(presence.getStatus().status, 'online');
    assert.equal(presence.getStatus().count, 0);
    await presence.dispose();
  }
  assert.notEqual(ids[0], ids[1]);
});

test('network failures clear old counts and back off to sixty seconds before recovering', async () => {
  const time = clock();
  let calls = 0;
  const presence = client(time, { fetchImpl(url, options) {
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    calls++;
    if (calls === 2 || calls === 3) throw new Error('Network unavailable');
    return response(calls === 1 ? 7 : 8, time.time());
  } });
  presence.start(); await settle();
  assert.equal(presence.getStatus().count, 7);
  await time.advance(HEARTBEAT_MS);
  assert.deepEqual(presence.getStatus(), { status: 'unavailable', count: null, updatedAt: null });
  assert.deepEqual(time.delays(), [HEARTBEAT_MS]);
  await time.advance(HEARTBEAT_MS);
  assert.deepEqual(time.delays(), [MAX_BACKOFF_MS]);
  assert.equal(presence.getStatus().count, null);
  await time.advance(MAX_BACKOFF_MS);
  assert.equal(presence.getStatus().count, 8);
  assert.equal(time.delays()[0], HEARTBEAT_MS);
  await presence.dispose();
});

test('invalid, oversized, and interrupted responses report unavailable without zeroing the online count', async () => {
  const malformed = [
    () => response(-1), () => response(1.5), () => response('2'),
    () => response(2, 'not a date'), () => response(2, undefined, { ttlSeconds: 0 }),
    () => new Response('{broken'), () => new Response(Buffer.from([0xff])),
    () => new Response('Service unavailable', { status: 503 }),
    () => new Response('{}', { headers: { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) } }),
    () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1)),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('Interrupted')); } })),
  ];
  for (const makeResponse of malformed) {
    const time = clock();
    const presence = client(time, { fetchImpl(url, options) {
      return options.method === 'DELETE' ? new Response(null, { status: 204 }) : makeResponse();
    } });
    presence.start(); await settle();
    assert.deepEqual(presence.getStatus(), { status: 'unavailable', count: null, updatedAt: null });
    await presence.dispose();
  }
});

test('heartbeats never overlap, timed-out results cannot restore stale counts, and disposal cancels in-flight work', async () => {
  const time = clock();
  const pending = [];
  const events = [];
  let deletes = 0;
  const presence = client(time, { publish: status => events.push(status), fetchImpl(url, options) {
    if (options.method === 'DELETE') { deletes++; return new Response(null, { status: 204 }); }
    return new Promise(resolve => pending.push({ resolve, signal: options.signal }));
  } });
  presence.start(); presence.start();
  assert.equal(pending.length, 1);
  await time.advance(REQUEST_TIMEOUT_MS - 1);
  assert.equal(presence.getStatus().status, 'connecting');
  await time.advance(1);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(presence.getStatus().status, 'unavailable');
  pending[0].resolve(response(100)); await settle();
  assert.equal(presence.getStatus().count, null);
  await time.advance(HEARTBEAT_MS);
  assert.equal(pending.length, 2);
  const published = events.length;
  const disposal = presence.dispose();
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve(response(101));
  await disposal; await settle();
  assert.equal(events.length, published);
  assert.equal(presence.getStatus().count, null);
  assert.deepEqual(time.delays(), []);
  await presence.dispose(); presence.start();
  assert.equal(deletes, 1);
  assert.equal(pending.length, 2);
});

test('stale counts become unavailable even when sleep delayed the timer callbacks', async () => {
  const time = clock();
  const events = [];
  const presence = client(time, { publish: status => events.push(status), fetchImpl(url, options) {
    return options.method === 'DELETE' ? new Response(null, { status: 204 }) : response(5);
  } });
  presence.start(); await settle();
  time.jump(STALE_TTL_MS);
  assert.deepEqual(presence.getStatus(), { status: 'unavailable', count: null, updatedAt: null });
  assert.equal(events.at(-1).status, 'unavailable');
  await presence.dispose();
});

test('best-effort session deletion is bounded to two seconds and never delays or repeats heartbeats', async () => {
  const time = clock();
  let deleteSignal;
  const presence = client(time, { fetchImpl(url, options) {
    if (options.method === 'DELETE') { deleteSignal = options.signal; return new Promise(() => {}); }
    return response(2);
  } });
  presence.start(); await settle();
  let settled = false;
  const disposal = presence.dispose().then(() => { settled = true; });
  assert.deepEqual(time.delays(), [LEAVE_TIMEOUT_MS]);
  await time.advance(LEAVE_TIMEOUT_MS - 1);
  assert.equal(settled, false);
  await time.advance(1);
  await disposal;
  assert.equal(deleteSignal.aborted, true);
  assert.equal(settled, true);
  assert.deepEqual(time.delays(), []);
});

test('disposing from an initial status callback cannot start a heartbeat after the leave request', async () => {
  const time = clock();
  const methods = [];
  let presence;
  presence = client(time, { publish: () => { void presence.dispose(); }, fetchImpl(url, options) {
    methods.push(options.method);
    return new Response(null, { status: 204 });
  } });
  presence.start(); await settle(); await presence.dispose();
  assert.deepEqual(methods, ['DELETE']);
  assert.deepEqual(time.delays(), []);
});

test('two real HTTP clients publish a shared online count and delete their anonymous sessions on disposal', async t => {
  const server = createPresenceServer({ cooldownMs: 0 });
  const clients = [];
  const wireBodies = [];
  server.on('request', request => {
    if (!['POST', 'DELETE'].includes(request.method)) return;
    const parts = [];
    request.on('data', chunk => parts.push(chunk));
    request.on('end', () => wireBodies.push({ method: request.method, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
  });
  t.after(async () => {
    await Promise.all(clients.map(presence => presence.dispose()));
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const bus = new EventEmitter();
  const published = { first: [], second: [] };
  const nextOnline = (name, count) => new Promise((resolve, reject) => {
    const listener = status => {
      if (status.status !== 'online' || status.count !== count) return;
      clearTimeout(deadline); bus.removeListener(name, listener); resolve(status);
    };
    const deadline = setTimeout(() => {
      bus.removeListener(name, listener);
      reject(new Error(`Timed out waiting for ${name} to publish real online count ${count}.`));
    }, 1500);
    bus.on(name, listener);
  });
  const firstClock = clock();
  const secondClock = clock();
  const makeClient = (name, fakeClock) => createPresence({ endpoint, allowLocalhost: true, ...fakeClock.options,
    publish: status => { published[name].push(status); bus.emit(name, status); },
  });
  const first = makeClient('first', firstClock);
  const second = makeClient('second', secondClock);
  clients.push(first, second);
  const firstReady = nextOnline('first', 1);
  first.start(); await firstReady;
  const secondReady = nextOnline('second', 2);
  second.start(); await secondReady;
  let snapshot = await (await fetch(`${endpoint}/v1/online`)).json();
  assert.equal(snapshot.online, 2);
  const firstRefresh = nextOnline('first', 2);
  await firstClock.advance(HEARTBEAT_MS);
  await firstRefresh;
  assert.equal(first.getStatus().count, 2);
  assert.equal(second.getStatus().count, 2);
  const ids = wireBodies.filter(entry => entry.method === 'POST').map(entry => entry.body.sessionId);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids[2], ids[0]);
  for (const { body } of wireBodies) {
    assert.deepEqual(Object.keys(body), ['sessionId']);
    assert.match(body.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  await second.dispose();
  snapshot = await (await fetch(`${endpoint}/v1/online`)).json();
  assert.equal(snapshot.online, 1);
  const remainingRefresh = nextOnline('first', 1);
  await firstClock.advance(HEARTBEAT_MS);
  await remainingRefresh;
  assert.equal(first.getStatus().count, 1);
  await first.dispose();
  snapshot = await (await fetch(`${endpoint}/v1/online`)).json();
  assert.equal(snapshot.online, 0);
  assert.deepEqual(wireBodies.filter(entry => entry.method === 'DELETE').map(entry => entry.body.sessionId), [ids[1], ids[0]]);
  assert(published.first.some(status => status.status === 'online' && status.count === 2));
  assert(published.second.some(status => status.status === 'online' && status.count === 2));
});
