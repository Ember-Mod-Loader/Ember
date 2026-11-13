const { randomUUID } = require('node:crypto');
const { mkdir, readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { MAX_PROFILE_MODS } = require('./profile-limits.json');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 1024 ** 3;
const TERMINAL_LIMIT = 50;
const COMPLETED_RETENTION_MS = 30_000;
const FAILED_RETENTION_MS = 5 * 60_000;
const FINISHED_RETENTION_MS = { complete: COMPLETED_RETENTION_MS, failed: FAILED_RETENTION_MS };
const GAMES = new Set(['lethal-company', 'repo', 'peak', 'mimesis']);
const ACTIVE = new Set(['resolving', 'downloading', 'saving']);
const STATES = new Set([...ACTIVE, 'complete', 'failed']);
const PACKAGE_STATES = new Set(['queued', 'downloading', 'complete']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function label(value, maximum) {
  if (typeof value !== 'string') throw new Error('Invalid download information.');
  const text = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!text || text.length > maximum) throw new Error('Invalid download information.');
  return text;
}

function context(value) {
  if (!UUID.test(value?.id ?? '') || !GAMES.has(value?.gameId)) throw new Error('Invalid download operation.');
  return {
    id: value.id,
    gameId: value.gameId,
    profileId: label(value.profileId, 100),
    profileName: label(value.profileName, 60),
    label: label(value.label, 180),
  };
}

function bytes(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_PACKAGE_BYTES;
}

function packageRecord(mod, gameId) {
  if (typeof mod?.namespace !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(mod.namespace) ||
      typeof mod.name !== 'string' || !/^[a-z0-9_]{1,128}$/i.test(mod.name) ||
      typeof mod.version !== 'string' || !/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(mod.version) ||
      mod.id !== `${gameId}/${mod.namespace}/${mod.name}`) {
    throw new Error('Invalid download package.');
  }
  return {
    key: `${mod.id}@${mod.version}`,
    id: mod.id,
    namespace: mod.namespace,
    name: mod.name,
    version: mod.version,
    status: 'queued',
    received: 0,
    total: null,
    cached: false,
  };
}

function errorText(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return typeof message === 'string' && message.trim()
    ? message.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500)
    : 'The download could not finish. Try again.';
}

function readRecord(value) {
  const record = context(value);
  if (!STATES.has(value.status) || !Number.isFinite(Date.parse(value.createdAt)) ||
      !Number.isFinite(Date.parse(value.updatedAt)) || !Array.isArray(value.packages) || value.packages.length > MAX_PROFILE_MODS) {
    throw new Error('Invalid download history.');
  }
  const keys = new Set();
  record.packages = value.packages.map(item => {
    const entry = packageRecord(item, record.gameId);
    if (keys.has(entry.key) || item.key !== entry.key || !PACKAGE_STATES.has(item.status) ||
        !bytes(item.received) || (item.total !== null && !bytes(item.total)) ||
        (item.total !== null && item.total < item.received)) throw new Error('Invalid download history.');
    keys.add(entry.key);
    return { ...entry, status: item.status, received: item.received, total: item.total, cached: item.cached === true };
  });
  record.status = value.status;
  record.createdAt = new Date(value.createdAt).toISOString();
  record.updatedAt = new Date(value.updatedAt).toISOString();
  record.error = value.status === 'failed' ? errorText(value.error) : '';
  return record;
}

function bounded(records) {
  const retained = new Set(records.filter(record => !ACTIVE.has(record.status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, TERMINAL_LIMIT).map(record => record.id));
  return records.filter(record => ACTIVE.has(record.status) || retained.has(record.id));
}

function expiresAt(record) {
  return Date.parse(record.updatedAt) + FINISHED_RETENTION_MS[record.status];
}

async function createDownloadHistory(filePath, publish = () => {}, {
  now = Date.now, setCleanupTimeout = setTimeout, clearCleanupTimeout = clearTimeout,
} = {}) {
  let records = [];
  try {
    const info = await stat(filePath);
    if (info.isFile() && info.size <= MAX_FILE_BYTES) {
      const saved = JSON.parse(await readFile(filePath, 'utf8'));
      if (saved?.version === 1 && Array.isArray(saved.records) && saved.records.length <= 1000) {
        const ids = new Set();
        for (const value of saved.records) {
          try {
            const record = readRecord(value);
            if (!ids.has(record.id)) records.push(record);
            ids.add(record.id);
          } catch {}
        }
      }
    }
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') throw new Error('Ember could not read its download history.');
  }
  records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  records = bounded(records);

  let writes = Promise.resolve();
  let transitions = Promise.resolve();
  let timer;
  let cleanupTimer;
  let lastWriteAt = 0;

  function emit(record) {
    try { publish(structuredClone(record)); } catch {}
  }

  function scheduleCleanup(retryAfter = 0) {
    clearCleanupTimeout(cleanupTimer);
    cleanupTimer = undefined;
    const finished = records.filter(record => !ACTIVE.has(record.status));
    if (!finished.length) return;
    const nextExpiry = Math.min(...finished.map(expiresAt));
    cleanupTimer = setCleanupTimeout(() => {
      cleanupTimer = undefined;
      return removeFinished(undefined, true).catch(() => {});
    }, Math.min(2_147_483_647, Math.max(retryAfter, nextExpiry - now(), 0)));
    cleanupTimer?.unref?.();
  }

  function removeFinished(gameId, expiredOnly = false) {
    const task = transitions.catch(() => {}).then(async () => {
      const time = now();
      const removed = records.filter(record => !ACTIVE.has(record.status) &&
        (gameId === undefined || record.gameId === gameId) &&
        (!expiredOnly || expiresAt(record) <= time));
      if (!removed.length) { scheduleCleanup(); return []; }
      const ids = new Set(removed.map(record => record.id));
      records = records.filter(record => !ids.has(record.id));
      clearTimeout(timer);
      timer = undefined;
      try {
        await save();
      } catch {
        for (const record of removed) {
          if (!records.some(item => item.id === record.id)) records.push(record);
        }
        records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        scheduleCleanup(1000);
        throw new Error('Ember could not clear download history. Check disk space and folder permissions.');
      }
      for (const record of removed) emit({ id: record.id, removed: true });
      scheduleCleanup();
      return [...ids];
    });
    transitions = task;
    return task;
  }

  function save() {
    const task = writes.catch(() => {}).then(async () => {
      lastWriteAt = Date.now();
      const capturedIds = new Set(records.map(record => record.id));
      let retained = bounded(records);
      let snapshot = JSON.stringify({ version: 1, records: retained });
      while (Buffer.byteLength(snapshot) > MAX_FILE_BYTES) {
        const oldest = retained.filter(record => !ACTIVE.has(record.status))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).at(-1);
        if (!oldest) throw new Error('Active download history is too large.');
        retained = retained.filter(record => record.id !== oldest.id);
        snapshot = JSON.stringify({ version: 1, records: retained });
      }
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = path.join(path.dirname(filePath), `.ember-history-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, snapshot, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, filePath);
        const retainedIds = new Set(retained.map(record => record.id));
        const pruned = records.filter(record => capturedIds.has(record.id) && !retainedIds.has(record.id));
        records = records.filter(record => !capturedIds.has(record.id) || retainedIds.has(record.id));
        for (const record of pruned) emit({ id: record.id, removed: true });
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
    writes = task;
    return task;
  }

  function scheduleSave() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void save().catch(() => {});
    }, Math.max(0, lastWriteAt + 1000 - Date.now()));
    timer.unref?.();
  }

  function find(id) {
    const record = records.find(item => item.id === id);
    if (!record) throw new Error('That download could not be found.');
    return record;
  }

  function replace(record, notify = true) {
    const index = records.findIndex(item => item.id === record.id);
    if (index === -1) records.unshift(record);
    else records[index] = record;
    if (notify) emit(record);
  }

  function durable(id, change) {
    const task = transitions.catch(() => {}).then(async () => {
      const previous = records.find(record => record.id === id);
      const next = change(previous);
      if (next === previous) return;
      replace(next, false);
      clearTimeout(timer);
      timer = undefined;
      try {
        await save();
        records = bounded(records);
        const committed = records.find(record => record.id === id);
        if (committed) emit(committed);
        scheduleCleanup();
      } catch {
        if (records.find(record => record.id === id) === next) {
          if (previous) replace(previous, false);
          else records = records.filter(record => record.id !== id);
        }
        throw new Error('Ember could not save download history. Check disk space and folder permissions.');
      }
    });
    transitions = task;
    return task;
  }

  const interrupted = records.filter(record => ACTIVE.has(record.status));
  for (const record of interrupted) {
    replace({
      ...record,
      status: 'failed',
      updatedAt: new Date(now()).toISOString(),
      error: 'Ember closed before this download finished. Try it again.',
    });
  }
  if (interrupted.length) {
    records = bounded(records);
    await save();
  }
  await removeFinished(undefined, true).catch(() => {});

  return {
    list() { return structuredClone(bounded(records)); },
    clearFinished(gameId) {
      if (!GAMES.has(gameId)) throw new Error('Choose a valid game to clear finished downloads.');
      return removeFinished(gameId);
    },
    async start(value) {
      const info = context(value);
      await durable(info.id, previous => {
        if (previous) throw new Error('This download operation already exists.');
        const timestamp = new Date(now()).toISOString();
        return { ...info, status: 'resolving', createdAt: timestamp, updatedAt: timestamp, packages: [], error: '' };
      });
      return info.id;
    },
    plan(id, mods) {
      const previous = find(id);
      if (!ACTIVE.has(previous.status) || previous.status === 'saving') return;
      if (!Array.isArray(mods) || mods.length > MAX_PROFILE_MODS) throw new Error(`Choose up to ${MAX_PROFILE_MODS} package versions.`);
      const existing = new Map(previous.packages.map(item => [item.key, item]));
      const packages = new Map();
      for (const mod of mods) {
        const entry = packageRecord(mod, previous.gameId);
        packages.set(entry.key, existing.get(entry.key) ?? entry);
      }
      replace({ ...previous, status: 'downloading', updatedAt: new Date(now()).toISOString(), packages: [...packages.values()] });
      scheduleSave();
    },
    progress(id, key, event) {
      const previous = records.find(record => record.id === id);
      if (!previous || previous.status !== 'downloading' || !['downloading', 'complete'].includes(event?.status) ||
          !bytes(event.received) || (event.total !== null && event.total !== undefined && !bytes(event.total))) return;
      const item = previous.packages.find(entry => entry.key === key);
      if (!item || item.status === 'complete') return;
      const received = Math.max(item.received, event.received);
      const reportedTotal = event.total ?? item.total;
      const total = event.status === 'complete' ? received
        : reportedTotal === null ? null : Math.max(received, reportedTotal);
      const next = {
        ...item, received, total, status: event.status,
        cached: event.status === 'complete' && event.cached === true,
      };
      replace({
        ...previous, updatedAt: new Date(now()).toISOString(),
        packages: previous.packages.map(entry => entry.key === key ? next : entry),
      });
      scheduleSave();
    },
    ready(id) {
      return durable(id, previous => {
        if (!previous) return find(id);
        if (previous.status === 'saving' || previous.status === 'complete') return previous;
        if (!ACTIVE.has(previous.status) || previous.packages.some(item => item.status !== 'complete')) {
          throw new Error('The download has not finished.');
        }
        return { ...previous, status: 'saving', updatedAt: new Date(now()).toISOString() };
      });
    },
    complete(id, profile) {
      const target = profile === undefined ? {} : {
        profileId: label(profile?.profileId, 100),
        profileName: label(profile?.profileName, 60),
      };
      return durable(id, previous => {
        if (!previous) return find(id);
        if (previous.status === 'complete') return previous;
        if (previous.status !== 'saving') throw new Error('Save this download to the profile before completing it.');
        return { ...previous, ...target, status: 'complete', updatedAt: new Date(now()).toISOString(), error: '' };
      });
    },
    fail(id, error) {
      return durable(id, previous => {
        if (!previous) return find(id);
        if (previous.status === 'complete' || previous.status === 'failed') return previous;
        return { ...previous, status: 'failed', updatedAt: new Date(now()).toISOString(), error: errorText(error) };
      });
    },
  };
}

module.exports = { createDownloadHistory, COMPLETED_RETENTION_MS, FAILED_RETENTION_MS };
