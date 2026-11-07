const http = require('node:http');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 256;
const RETIRED_TTL_MS = 120_000;

function createPresenceServer({ now = Date.now, ttlMs = 90_000, maxSessions = 50_000, cooldownMs = 10_000 } = {}) {
  const sessions = new Map();
  function prune(time) {
    for (const [id, session] of sessions) if (session.expiresAt <= time) sessions.delete(id);
  }
  function snapshot(time) {
    prune(time);
    const online = [...sessions.values()].filter(session => session.active).length;
    return { online, ttlSeconds: Math.ceil(ttlMs / 1000), serverTime: new Date(time).toISOString() };
  }
  function send(response, status, data, extra = {}) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...extra,
    });
    response.end(JSON.stringify(data));
  }
  function readSession(request) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      request.on('data', chunk => {
        size += chunk.length;
        if (size > BODY_LIMIT) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); return; }
        chunks.push(chunk);
      });
      request.on('error', reject);
      request.on('aborted', () => reject(new Error('Request interrupted.')));
      request.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value) ||
              typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)) throw new Error('Invalid session.');
          const legacy = Object.keys(value).length === 1;
          if (!legacy && (Object.keys(value).length !== 3 || typeof value.connectionId !== 'string' ||
              !SESSION_ID.test(value.connectionId) || !Number.isSafeInteger(value.generation) || value.generation < 1)) throw new Error('Invalid session.');
          resolve({ sessionId: value.sessionId.toLowerCase(),
            connectionId: legacy ? null : value.connectionId.toLowerCase(), generation: legacy ? 0 : value.generation });
        } catch { reject(Object.assign(new Error('Use a valid temporary session ID.'), { status: 400 })); }
      });
    });
  }
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, async (request, response) => {
    response.on('error', () => {});
    // Native clients use main-process requests. Browser origins are intentionally unsupported.
    if (request.headers.origin) { send(response, 403, { error: 'Browser requests are not supported.' }); return; }
    if (request.url === '/health' && request.method === 'GET') {
      send(response, 200, { ok: true, service: 'ember-presence' }); return;
    }
    if (request.url === '/v1/online' && request.method === 'GET') {
      send(response, 200, snapshot(now())); return;
    }
    const validPath = request.url === '/v1/heartbeat' || request.url === '/v1/session';
    if (!validPath) { send(response, 404, { error: 'Not found.' }); return; }
    const expectedMethod = request.url === '/v1/heartbeat' ? 'POST' : 'DELETE';
    if (request.method !== expectedMethod) { send(response, 405, { error: 'Method not allowed.' }, { allow: expectedMethod }); return; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
      send(response, 415, { error: 'Use application/json.' }); return;
    }
    const declaredSize = request.headers['content-length'];
    if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > BODY_LIMIT)) {
      send(response, 413, { error: 'Request too large.' }, { connection: 'close' }); return;
    }
    try {
      const identity = await readSession(request);
      const id = identity.sessionId;
      const time = now();
      prune(time);
      const existing = sessions.get(id);
      const sameOwner = existing && existing.generation === identity.generation && existing.connectionId === identity.connectionId;
      if (expectedMethod === 'DELETE') {
        // Keep a short retirement record so a delayed heartbeat cannot resurrect a closed client.
        if ((!existing && sessions.size < maxSessions) || (sameOwner && existing.active)) {
          sessions.set(id, { ...identity, active: false, lastSeen: time, expiresAt: time + RETIRED_TTL_MS });
        }
      } else {
        if (existing && (identity.generation < existing.generation ||
            (identity.generation === existing.generation && (!sameOwner || !existing.active)))) {
          send(response, 409, { error: 'This connection has been replaced or closed.' }); return;
        }
        if (sameOwner && existing.active && time - existing.lastSeen < cooldownMs) {
          send(response, 429, { error: 'Wait before sending another heartbeat.' }, { 'retry-after': String(Math.ceil((cooldownMs - (time - existing.lastSeen)) / 1000)) }); return;
        }
        if (!existing && sessions.size >= maxSessions) {
          send(response, 503, { error: 'The online service is temporarily full.' }, { 'retry-after': '30' }); return;
        }
        sessions.set(id, { ...identity, active: true, lastSeen: time, expiresAt: time + ttlMs });
      }
      send(response, 200, snapshot(time));
    } catch (error) {
      if (!response.writableEnded) send(response, error.status || 400, { error: error.status === 413 ? 'Request too large.' : 'Use a valid temporary session ID.' }, { connection: 'close' });
    }
  });
  const cleanup = setInterval(() => prune(now()), 15_000);
  cleanup.unref();
  server.once('close', () => { clearInterval(cleanup); sessions.clear(); });
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 1024;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 10000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Set PORT to a valid TCP port.');
  const server = createPresenceServer();
  server.listen(port, '0.0.0.0', () => console.log('Ember presence service is ready.'));
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

module.exports = { createPresenceServer };
