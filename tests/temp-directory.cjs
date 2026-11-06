const { mkdtemp, realpath, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

async function temporaryDirectory(t) {
  const parent = await realpath(tmpdir());
  const folder = await mkdtemp(path.join(parent, 'modrelay-test-'));
  t.after(async () => {
    const resolved = await realpath(folder);
    if (resolved !== folder || path.dirname(resolved) !== parent) {
      throw new Error('The test directory resolved outside its original location.');
    }
    await rm(resolved, { recursive: true, force: true });
  });
  return folder;
}

module.exports = { temporaryDirectory };

