const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isNewerVersion, isValidVersion } = require('./client-updates.cjs');

const AUTOMATIC_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RECORD_BYTES = 4096;

function createUpdateAttempts(filePath, { version, now = Date.now, io = fs } = {}) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') ||
      !isValidVersion(version) ||
      typeof now !== 'function') {
    throw new Error('A valid update attempt file and installed version are required.');
  }
  let pending = Promise.resolve();
  let reservation = null;
  const serialize = task => {
    const work = pending.catch(() => {}).then(task);
    pending = work;
    return work;
  };

  async function read() {
    let metadata;
    try { metadata = await io.lstat(filePath); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES) throw new Error('The client update attempt record is invalid.');
    const saved = JSON.parse(await io.readFile(filePath, 'utf8'));
    if (saved?.format !== 1 || !Object.hasOwn(saved, 'attempt')) throw new Error('The client update attempt record is invalid.');
    if (saved.attempt === null) return null;
    const attempt = saved.attempt;
    if (typeof attempt.fromVersion !== 'string' || !isNewerVersion(attempt.toVersion, attempt.fromVersion) ||
        !Number.isSafeInteger(attempt.attemptedAt) || attempt.attemptedAt < 0 ||
        typeof attempt.token !== 'string' || !/^[0-9a-f-]{36}$/i.test(attempt.token)) {
      throw new Error('The client update attempt record is invalid.');
    }
    return attempt;
  }

  async function write(attempt) {
    await io.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = path.join(path.dirname(filePath), `.ember-update-attempt-${randomUUID()}.tmp`);
    try {
      await io.writeFile(temporary, JSON.stringify({ format: 1, attempt }), { flag: 'wx', mode: 0o600 });
      await io.rename(temporary, filePath);
    } finally {
      await io.rm(temporary, { force: true }).catch(() => {});
    }
  }

  function validPair(value) {
    return value?.fromVersion === version && isNewerVersion(value?.toVersion, version);
  }

  return {
    reserveAutomaticInstall(value) {
      return serialize(async () => {
        if (!validPair(value)) return false;
        const attemptedAt = now();
        if (!Number.isSafeInteger(attemptedAt) || attemptedAt < 0) throw new Error('The update attempt time is invalid.');
        const previous = await read();
        if (previous?.fromVersion === value.fromVersion && previous.toVersion === value.toVersion &&
            attemptedAt - previous.attemptedAt < AUTOMATIC_RETRY_WINDOW_MS) return false;
        const attempt = { fromVersion: value.fromVersion, toVersion: value.toVersion, attemptedAt, token: randomUUID() };
        await write(attempt);
        reservation = attempt;
        return true;
      });
    },
    releaseAutomaticInstall(value) {
      return serialize(async () => {
        if (!reservation || !validPair(value) || reservation.fromVersion !== value.fromVersion || reservation.toVersion !== value.toVersion) return;
        const current = await read();
        if (current?.token === reservation.token) await write(null);
        reservation = null;
      });
    },
  };
}

module.exports = { createUpdateAttempts, AUTOMATIC_RETRY_WINDOW_MS };
