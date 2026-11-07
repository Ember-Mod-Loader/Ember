const { randomUUID } = require('node:crypto');
const { mkdir, lstat, readFile, writeFile, rename, unlink } = require('node:fs/promises');
const path = require('node:path');

const LEASE_TTL_MS = 120_000;
const MAX_LEASE_BYTES = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const queues = new Map();

function validIdentity(value) {
  return value && UUID.test(value.sessionId) && UUID.test(value.connectionId) &&
    Number.isSafeInteger(value.generation) && value.generation >= 1;
}

function sameIdentity(left, right) {
  return left?.sessionId === right.sessionId && left?.connectionId === right.connectionId && left?.generation === right.generation;
}

function serialized(filePath, operation) {
  const previous = queues.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(filePath, next);
  const release = () => { if (queues.get(filePath) === next) queues.delete(filePath); };
  void next.then(release, release);
  return next;
}

async function readLease(filePath) {
  let info;
  try { info = await lstat(filePath); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Ember could not read its temporary presence session.');
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The temporary presence session file is unavailable.');
  if (info.size > MAX_LEASE_BYTES) return null;
  let saved;
  try { saved = JSON.parse(await readFile(filePath, 'utf8')); } catch (error) {
    if (error instanceof SyntaxError) return null;
    if (error.code === 'ENOENT') return null;
    throw new Error('Ember could not read its temporary presence session.');
  }
  if (saved?.version !== 1 || !validIdentity(saved) || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt < 0) return null;
  return saved;
}

async function saveLease(filePath, identity, expiresAt) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.ember-presence-lease-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, ...identity, expiresAt }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, filePath);
  } catch {
    throw new Error('Ember could not save its temporary presence session.');
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function acquirePresenceLease(filePath, { now = Date.now } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0') || typeof now !== 'function') {
    throw new Error('Choose a valid temporary presence session path.');
  }
  const resolved = path.resolve(filePath);
  function timestamp() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - LEASE_TTL_MS) {
      throw new Error('The presence session clock is unavailable.');
    }
    return value;
  }
  return serialized(resolved, async () => {
    const time = timestamp();
    const saved = await readLease(resolved);
    const reusable = saved && saved.expiresAt > time && saved.expiresAt <= time + LEASE_TTL_MS && saved.generation < Number.MAX_SAFE_INTEGER;
    const identity = Object.freeze({
      sessionId: reusable ? saved.sessionId : randomUUID(),
      connectionId: randomUUID(),
      generation: reusable ? saved.generation + 1 : 1,
    });
    // Save ownership before the first heartbeat so even an abrupt exit can reuse this short lease.
    await saveLease(resolved, identity, time + LEASE_TTL_MS);
    return Object.freeze({
      identity,
      renew() {
        return serialized(resolved, async () => {
          const current = await readLease(resolved);
          if (!sameIdentity(current, identity)) throw new Error('This presence session was replaced by a newer connection.');
          await saveLease(resolved, identity, timestamp() + LEASE_TTL_MS);
        });
      },
    });
  });
}

module.exports = { acquirePresenceLease, LEASE_TTL_MS };
