const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeConfigFiles } = require('../electron/config-files.cjs');

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
  for (const text of [null, 42, 'binary\0data', '\u0001binary', '\ud800', 'x'.repeat(256 * 1024 + 1)]) {
    assert.throws(() => normalizeConfigFiles({ 'test.cfg': text }), /text up to/);
  }
});

test('configuration limits bound file counts and aggregate UTF-8 bytes', () => {
  assert.throws(() => normalizeConfigFiles(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`file${i}.cfg`, '']))), /128/);
  const chunk = 'é'.repeat(128 * 1024);
  assert.equal(Object.keys(normalizeConfigFiles({ 'a.cfg': chunk, 'b.cfg': chunk, 'c.cfg': chunk, 'd.cfg': chunk })).length, 4);
  assert.throws(() => normalizeConfigFiles({ 'a.cfg': chunk, 'b.cfg': chunk, 'c.cfg': chunk, 'd.cfg': chunk, 'e.cfg': 'x' }), /exceed 1 MB/);
  assert.throws(() => normalizeConfigFiles({ 'a.cfg': chunk + 'é' }), /256 KB/);
});
