const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function createDiagnostics(directory, version) {
  const folder = path.join(directory, 'logs');
  const filename = path.join(folder, 'app.log');
  function log(event, details = {}) {
    try {
      mkdirSync(folder, { recursive: true });
      let previous = '';
      try { previous = readFileSync(filename, 'utf8'); } catch {}
      if (Buffer.byteLength(previous) > 48 * 1024) {
        previous = previous.slice(-24 * 1024);
        previous = previous.slice(previous.indexOf('\n') + 1);
      }
      const line = JSON.stringify({ at: new Date().toISOString(), version, event, ...details });
      writeFileSync(filename, previous + line.slice(0, 8000) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch { /* Diagnostics must never prevent startup or shutdown. */ }
  }
  return { log };
}

function errorDetails(error) {
  return String(error?.stack || error?.message || error || 'Unknown error')
    .replace(/https?:\/\/[^\s)]+/g, value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return '[URL]'; } })
    .slice(0, 6000);
}

module.exports = { createDiagnostics, errorDetails };
