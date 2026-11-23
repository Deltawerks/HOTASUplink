const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createUpdater } = require('./auto-update.cjs');

test('update checks share one download, clean up the ZIP and find a prepared app offline', async () => {
  const version = '0.5.4', release = { version: '0.5.5' };
  const storeDir = path.resolve('test-update-store');
  let exe = null, tempZip, downloads = 0, checks = 0;
  const updater = createUpdater({ version, storeDir, supported: true, newest: async () => exe,
    check: async () => { checks++; return release; },
    download: async (offered, zip) => {
      assert.equal(offered, release);
      downloads++;
      tempZip = zip;
      await fs.writeFile(zip, 'fixture');
    },
    install: async (store, offered, zip) => {
      assert.equal(await fs.readFile(zip, 'utf8'), 'fixture');
      exe = path.join(store, offered.version, 'HOTAS Uplink.exe');
      return exe;
    },
  });
  await assert.rejects(updater.downloadUpdate(), /Check/);
  const [one, two] = await Promise.all([updater.checkUpdate(), updater.checkUpdate()]);
  assert.deepEqual(one, { status: 'available', version: release.version });
  assert.deepEqual(one, two);
  const ready = { status: 'ready', version: release.version };
  assert.deepEqual(await Promise.all([updater.downloadUpdate(), updater.downloadUpdate()]), [ready, ready]);
  assert.deepEqual(await updater.checkUpdate(), ready);
  assert.equal(await updater.cached(), exe);
  assert.equal(checks, 1);
  assert.equal(downloads, 1);
  await assert.rejects(fs.stat(path.dirname(tempZip)), { code: 'ENOENT' });
});

test('source launches stay offline and downloads require a newer release', async () => {
  const opts = { version: '0.5.4', newest: () => null, check: () => null };
  const current = createUpdater({ ...opts, supported: true });
  assert.deepEqual(await current.checkUpdate(), { status: 'current', version: opts.version });
  await assert.rejects(current.downloadUpdate(), /Check/);
  const offline = createUpdater({ ...opts, supported: false, check: assert.fail, newest: assert.fail });
  assert.deepEqual(await offline.checkUpdate(), { status: 'unsupported', version: opts.version });
  assert.equal(await offline.cached(), null);
});
