const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeConfigFiles, MAX_CONFIG_FILES, MAX_CONFIG_TOTAL_BYTES } = require('../electron/config-files.cjs');

test('configuration templates preserve text and deterministic paths without mutating input', () => {
  const input = { 'sub/crew.json': '{"name":"café ☕"}\n', 'BepInEx.cfg': '[Logging]\nEnabled = true\r\n' };
  const expected = { 'BepInEx.cfg': input['BepInEx.cfg'], 'sub/crew.json': input['sub/crew.json'] };
  assert.deepEqual(normalizeConfigFiles(input), expected);
  assert.deepEqual(Object.keys(input), ['sub/crew.json', 'BepInEx.cfg']);
  assert.deepEqual(normalizeConfigFiles(), {});
});

test('configuration templates reject unsafe paths, executables, binary text, and Windows collisions', () => {
  for (const file of ['../escape.cfg', '/root.cfg', 'C:/escape.cfg', 'sub\\escape.cfg', 'sub//file.cfg', 'sub/./file.cfg',
    'NUL.cfg', 'COM¹.cfg', 'sub./file.cfg', 'test.cfg:stream', 'malware.dll', 'script.ps1', 'loader.exe', 'file.cfg ', '\ud800.cfg']) {
    assert.throws(() => normalizeConfigFiles({ [file]: 'text' }), /configuration path/);
  }
  for (const files of [
    { 'Case.cfg': 'a', 'case.cfg': 'b' },
    { 'a.cfg': 'file', 'a.cfg/child.cfg': 'nested' },
    { 'Sub/a.cfg': 'a', 'sub/b.cfg': 'b' },
    { 'café.cfg': 'a', 'cafe\u0301.cfg': 'b' },
  ]) assert.throws(() => normalizeConfigFiles(files), /conflicting/);
  for (const text of [null, 42, 'binary\0data', '\u0001binary', '\ud800']) {
    assert.throws(() => normalizeConfigFiles({ 'test.cfg': text }), /valid UTF-8 text/);
  }
});

test('configuration limits bound file counts and aggregate UTF-8 bytes', () => {
  assert.throws(() => normalizeConfigFiles(Object.fromEntries(Array.from({ length: MAX_CONFIG_FILES + 1 }, (_, i) => [`file${i}.cfg`, '']))),
    new RegExp(`up to ${MAX_CONFIG_FILES}`));
  const half = 'é'.repeat(MAX_CONFIG_TOTAL_BYTES / 4);
  assert.equal(Object.keys(normalizeConfigFiles({ 'a.cfg': half, 'b.cfg': half })).length, 2);
  assert.throws(() => normalizeConfigFiles({ 'a.cfg': half, 'b.cfg': half, 'c.cfg': 'x' }), /exceed 2 MiB/);
  const large = half.repeat(2);
  assert.deepEqual(normalizeConfigFiles({ 'large.cfg': large }), { 'large.cfg': large });
  assert.throws(() => normalizeConfigFiles({ 'large.cfg': large + 'é' }), /exceed 2 MiB/);
});
