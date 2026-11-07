const { randomUUID } = require('node:crypto');

const HEARTBEAT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 60_000;
const STALE_TTL_MS = 90_000;
const LEAVE_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function presenceOrigin(value, allowLocalhost) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Configure an HTTPS presence service origin.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Configure an HTTPS presence service origin.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const local = host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]';
  if ((url.protocol !== 'https:' && !(allowLocalhost && local && url.protocol === 'http:')) ||
      (local && !allowLocalhost) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Configure an HTTPS presence service origin without a path, credentials, query, or fragment.');
  }
  return url.origin;
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch {}
}

async function readPresence(response) {
  if (!response?.ok) {
    if (response) await cancelBody(response);
    throw new Error('Presence is unavailable.');
  }
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await cancelBody(response);
    throw new Error('Presence response is too large.');
  }
  if (!response.body) throw new Error('Presence response is empty.');
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Presence response is too large.');
      }
      parts.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); } catch {
    throw new Error('Presence response is unreadable.');
  }
  if (!Number.isSafeInteger(value?.online) || value.online < 0 || value.ttlSeconds !== STALE_TTL_MS / 1000 ||
      typeof value.serverTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value.serverTime) ||
      !Number.isFinite(Date.parse(value.serverTime))) {
    throw new Error('Presence response is invalid.');
  }
  return { count: value.online, updatedAt: new Date(value.serverTime).toISOString() };
}

function createPresence({
  endpoint = null, fetchImpl = globalThis.fetch, publish = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, allowLocalhost = false, lease = null,
} = {}) {
  if (typeof allowLocalhost !== 'boolean' || typeof fetchImpl !== 'function' || typeof publish !== 'function' ||
      typeof now !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new Error('Invalid presence client options.');
  }
  const origin = presenceOrigin(endpoint, allowLocalhost);
  const supplied = lease?.identity;
  if (lease && (!supplied || !UUID.test(supplied.sessionId) || !UUID.test(supplied.connectionId) ||
      !Number.isSafeInteger(supplied.generation) || supplied.generation < 1 || typeof lease.renew !== 'function')) {
    throw new Error('Invalid temporary presence session lease.');
  }
  // A saved lease is reused only across brief restarts, with new connection ownership each time.
  const identity = Object.freeze(lease ? {
    sessionId: supplied.sessionId, connectionId: supplied.connectionId, generation: supplied.generation,
  } : { sessionId: randomUUID(), connectionId: randomUUID(), generation: 1 });
  let started = false;
  let disposed = false;
  let inFlight = null;
  let heartbeatTimer;
  let freshnessTimer;
  let leavePromise;
  let failures = 0;
  let freshAt = null;
  let state = { status: origin ? 'connecting' : 'not-configured', count: null, updatedAt: null };

  function change(next) {
    if (disposed) return;
    state = next;
    try { publish(structuredClone(state)); } catch {}
  }

  function unavailable() {
    clearTimer(freshnessTimer);
    freshnessTimer = undefined;
    freshAt = null;
    change({ status: 'unavailable', count: null, updatedAt: null });
  }

  function getStatus() {
    if (!disposed && state.status === 'online' && freshAt !== null && now() - freshAt >= STALE_TTL_MS) unavailable();
    return structuredClone(state);
  }

  function request(method, pathname, timeout, readResponse) {
    const controller = new AbortController();
    let rejectGate;
    const gate = new Promise((_, reject) => { rejectGate = reject; });
    const deadline = setTimer(() => {
      controller.abort();
      rejectGate(new Error('Presence request timed out.'));
    }, timeout);
    deadline?.unref?.();
    const cancel = () => {
      clearTimer(deadline);
      controller.abort();
      rejectGate(new Error('Presence request cancelled.'));
    };
    let network;
    try {
      network = Promise.resolve(fetchImpl(`${origin}${pathname}`, {
        method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(identity), signal: controller.signal, redirect: 'error',
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      })).then(async response => {
        if (readResponse) return readPresence(response);
        await cancelBody(response);
      });
    } catch (error) { network = Promise.reject(error); }
    const promise = Promise.race([network, gate]).finally(() => clearTimer(deadline));
    return { promise, cancel };
  }

  function scheduleHeartbeat(delay) {
    clearTimer(heartbeatTimer);
    if (disposed || !started || !origin) return;
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = undefined;
      return heartbeat();
    }, delay);
    heartbeatTimer?.unref?.();
  }

  async function heartbeat() {
    if (disposed || !started || !origin || inFlight) return;
    if (state.status !== 'online') change({ status: 'connecting', count: null, updatedAt: null });
    if (disposed) return;
    const active = request('POST', '/v1/heartbeat', REQUEST_TIMEOUT_MS, true);
    inFlight = active;
    try {
      const next = await active.promise;
      if (disposed || inFlight !== active) return;
      if (lease) await lease.renew();
      if (disposed || inFlight !== active) return;
      failures = 0;
      freshAt = now();
      clearTimer(freshnessTimer);
      freshnessTimer = setTimer(() => { freshnessTimer = undefined; unavailable(); }, STALE_TTL_MS);
      freshnessTimer?.unref?.();
      change({ status: 'online', ...next });
    } catch {
      if (disposed) return;
      failures++;
      unavailable();
    } finally {
      if (inFlight === active) inFlight = null;
      if (!disposed) scheduleHeartbeat(failures ? Math.min(MAX_BACKOFF_MS, HEARTBEAT_MS * 2 ** Math.min(failures - 1, 1)) : HEARTBEAT_MS);
    }
  }

  function start() {
    if (!started && !disposed && origin) {
      started = true;
      void heartbeat();
    }
    return getStatus();
  }

  function dispose() {
    if (disposed) return leavePromise ?? Promise.resolve();
    disposed = true;
    clearTimer(heartbeatTimer);
    clearTimer(freshnessTimer);
    heartbeatTimer = freshnessTimer = undefined;
    inFlight?.cancel();
    inFlight = null;
    state = { status: origin ? 'unavailable' : 'not-configured', count: null, updatedAt: null };
    if (started && origin) leavePromise = request('DELETE', '/v1/session', LEAVE_TIMEOUT_MS, false).promise.catch(() => {});
    else leavePromise = Promise.resolve();
    return leavePromise;
  }

  return { start, getStatus, dispose };
}

module.exports = { createPresence, HEARTBEAT_MS, REQUEST_TIMEOUT_MS, MAX_BACKOFF_MS, STALE_TTL_MS, LEAVE_TIMEOUT_MS, MAX_RESPONSE_BYTES };
