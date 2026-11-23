'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { newestInstalled, installRelease, pruneInstalled } = require('./update-store.cjs');
const run = promisify(execFile);

test('portable updates install atomically, verify the package and retain the previous version', { skip: process.platform !== 'win32' }, async t => {
  const tmp = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(tmp, 'hotas-update-store-test-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(dir)), tmp);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const helper = path.join(dir, 'extract.exe');
  await run(path.join(windows, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'), [
    '/nologo', '/optimize+', '/target:exe', '/reference:System.IO.Compression.dll', '/out:' + helper,
    path.join(__dirname, 'update-store-extract.cs'),
  ], { windowsHide: true });
  const store = path.join(dir, 'updates');
  async function fixture(version, wrapper, declaredVersion = version) {
    const base = await fs.mkdtemp(path.join(dir, 'source-'));
    const root = path.join(base, wrapper);
    await fs.mkdir(path.join(root, 'resources/app/src/desktop'), { recursive: true });
    const files = ['HOTAS Uplink.exe', 'resources.pak', 'resources/app/src/desktop/main.cjs',
      'resources/app/src/desktop/update-store-extract.exe'];
    for (const file of files) await fs.writeFile(path.join(root, file), 'fixture');
    await fs.writeFile(path.join(root, 'resources/app/package.json'), JSON.stringify({
      name: 'deltawerks-hotas-uplink', version: declaredVersion,
    }));
    const zip = path.join(base, 'update.zip');
    await run(path.join(windows, 'System32/tar.exe'), ['-a', '-cf', zip, '-C', base, wrapper], { windowsHide: true });
    const release = {version, sha256: createHash('sha256').update(await fs.readFile(zip)).digest('hex')};
    return { release, zip, install: () => installRelease(store, release, zip, helper) };
  }

  assert.equal(await newestInstalled(store, '1.0.0'), null);
  const first = await fixture('1.0.1', 'HOTAS Uplink');
  const exe = path.join(store, '1.0.1/HOTAS Uplink.exe');
  assert.deepEqual(await Promise.all([first.install(), first.install()]), [exe, exe]);
  assert.equal(await newestInstalled(store, '1.0.0'), exe);
  assert.equal(await newestInstalled(store, '1.0.1'), null);

  const bad = await fixture('1.0.2', 'HOTAS-Uplink-1.0.2', '1.0.3');
  await assert.rejects(installRelease(store, { ...bad.release, sha256: '0'.repeat(64) }, bad.zip, helper), /unpack/);
  await assert.rejects(bad.install(), /unexpected package/);
  const wrongWrapper = await fixture('1.0.2', 'Unrelated app');
  await assert.rejects(wrongWrapper.install(), /unpack/);
  assert.deepEqual(await fs.readdir(store), ['1.0.1']);

  await fs.mkdir(path.join(store, '0.1.0')); // Unrelated data is outside updater ownership.
  await fs.writeFile(path.join(store, '0.1.0/keep.txt'), 'personal');
  const second = await fixture('1.0.2', 'HOTAS-Uplink-1.0.2');
  const third = await fixture('1.0.10', 'HOTAS-Uplink-1.0.10');
  await second.install();
  const latest = await third.install();
  assert.equal(await newestInstalled(store, '1.0.0'), latest);
  await pruneInstalled(store, '1.0.2');
  assert.equal(await fs.readFile(exe, 'utf8'), 'fixture');
  await pruneInstalled(store, '1.0.10');
  assert.deepEqual((await fs.readdir(store)).sort(), ['0.1.0', '1.0.10', '1.0.2']);
  assert.equal(await fs.readFile(path.join(store, '0.1.0/keep.txt'), 'utf8'), 'personal');
});
