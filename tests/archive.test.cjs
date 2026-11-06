const assert = require('node:assert/strict');
const { mkdir, readdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { extractArchive } = require('../electron/archive.cjs');
const { temporaryDirectory } = require('./temp-directory.cjs');
const { zipFixture } = require('./zip-fixture.cjs');

async function fixture(t, entries, options) {
  const folder = await temporaryDirectory(t);
  const zip = path.join(folder, 'package.zip');
  const stage = path.join(folder, 'stage');
  await Promise.all([mkdir(stage), writeFile(zip, zipFixture(entries, options))]);
  return { folder, zip, stage };
}

test('archive extraction maps validated files, including deflated data, into an empty stage', async t => {
  const { zip, stage } = await fixture(t, [
    { name: 'plugins/', mode: 0o040755 },
    { name: 'plugins/example.dll', content: 'plugin', deflate: true },
    { name: 'README.md', content: 'ignored' },
  ]);
  const seen = [];
  const result = await extractArchive(zip, stage, relative => {
    seen.push(relative);
    return relative.startsWith('plugins/') ? 'BepInEx/' + relative : null;
  });

  assert.deepEqual(seen, ['plugins/example.dll', 'README.md']);
  assert.deepEqual(result, { files: 1, bytes: 6 });
  assert.deepEqual(await readdir(stage), ['BepInEx']);
  assert.equal(await readFile(path.join(stage, 'BepInEx', 'plugins', 'example.dll'), 'utf8'), 'plugin');
});

test('archive rejects unsafe source paths before calling the mapper', async t => {
  for (const name of ['../escape.dll', '/root.dll', 'C:/drive.dll', 'plugins\\evil.dll', 'file:stream', 'NUL.txt', 'COM¹.log', 'trailing. ', 'two//parts.dll']) {
    await t.test(name, async subtest => {
      const { folder, zip, stage } = await fixture(subtest, [{ name, content: 'unsafe' }]);
      await assert.rejects(() => extractArchive(zip, stage, () => assert.fail('unsafe source was mapped')));
      assert.deepEqual(await readdir(stage), []);
      assert.deepEqual((await readdir(folder)).sort(), ['package.zip', 'stage']);
    });
  }
});

test('archive rejects an unsafe mapped path or a nonempty destination', async t => {
  const { zip, stage } = await fixture(t, [{ name: 'good.dll', content: 'contents' }]);
  await assert.rejects(() => extractArchive(zip, stage, () => '../outside.dll'), /unsafe Windows path/);

  const existing = path.join(stage, 'existing.dll');
  await writeFile(existing, 'original');
  await assert.rejects(() => extractArchive(zip, stage, () => 'existing.dll'), /empty staging directory/);
  assert.equal(await readFile(existing, 'utf8'), 'original');
});

test('archive rejects case collisions in source and mapped paths without overwriting', async t => {
  const source = await fixture(t, [
    { name: 'Plugins/one.dll', content: 'first' },
    { name: 'plugins/two.dll', content: 'second' },
  ]);
  await assert.rejects(() => extractArchive(source.zip, source.stage), /conflicting paths/);
  const mapped = await fixture(t, [
    { name: 'first.dll', content: 'first' },
    { name: 'second.dll', content: 'second' },
  ]);
  await assert.rejects(() => extractArchive(mapped.zip, mapped.stage, () => 'same.dll'), /conflicting paths/);
  assert.equal(await readFile(path.join(mapped.stage, 'same.dll'), 'utf8'), 'first');
});

test('archive rejects symlink and Windows reparse entries', async t => {
  for (const entry of [
    { name: 'unix-link', mode: 0o120777, content: '../outside' },
    { name: 'windows-link', attributes: 0x400, content: 'outside' },
  ]) {
    const { zip, stage } = await fixture(t, [entry]);
    await assert.rejects(() => extractArchive(zip, stage), /link or special file/);
    assert.deepEqual(await readdir(stage), []);
  }
});

test('archive checks CRC and declared resource limits before accepting content', async t => {
  const corrupt = await fixture(t, [{ name: 'test.dll', content: 'plugin', checksum: 0 }]);
  await assert.rejects(() => extractArchive(corrupt.zip, corrupt.stage), /checksum/);
  const size = await fixture(t, [{ name: 'large.dll', deflate: true, expandedSize: 1024 ** 3 + 1 }]);
  await assert.rejects(() => extractArchive(size.zip, size.stage), /expanded size limit/);
  assert.deepEqual(await readdir(size.stage), []);
  const count = await fixture(t, [], { declaredEntryCount: 20_001 });
  await assert.rejects(() => extractArchive(count.zip, count.stage), /entry limit/);
});

