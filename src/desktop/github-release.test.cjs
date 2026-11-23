'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { isStableVersion, compareVersions, checkLatest, downloadRelease } = require('./github-release.cjs');

const version = '0.6.10', bytes = Buffer.from('test release bytes');
const filename = 'HOTAS-Uplink-' + version + '-win32-' + process.arch + '.zip';
const url = 'https://github.com/Deltawerks/HOTASUplink/releases/download/v' + version + '/' + filename;
const sha256 = createHash('sha256').update(bytes).digest('hex');
const release = { version, url, sha256, size: bytes.length };
const asset = { name: filename, state: 'uploaded', digest: 'sha256:' + sha256, size: bytes.length, browser_download_url: url };
const info = { draft: false, prerelease: false, tag_name: 'v' + version, assets: [asset] };
const metadata = data => async () => Response.json(data);

async function temporaryZip(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uplink-release-test-'));
  const file = path.join(dir, 'update.zip');
  t.after(async () => { await fs.rm(file, { force: true }); await fs.rmdir(dir); });
  return file;
}

test('version order compares stable numeric components', () => {
  assert.equal(compareVersions('1.0.0', '0.99.9'), 1);
  assert.equal(compareVersions('0.5.10', '0.5.11'), -1);
  assert.equal(compareVersions(version, version), 0);
  for (const invalid of [null, '../0.1.0', '1.2', '01.2.3', '1.2.3-rc1', '1.2.3+test', '1.2.9007199254740992']) {
    assert.equal(isStableVersion(invalid), false);
    assert.throws(() => compareVersions(invalid, version));
  }
});

test('checks only the official latest stable desktop ZIP for this architecture', async () => {
  const latest = await checkLatest('0.5.3', async (requested, options) => {
    assert.equal(requested, 'https://api.github.com/repos/Deltawerks/HOTASUplink/releases/latest');
    assert.equal(options.redirect, 'error');
    return Response.json({ ...info, assets: [{ ...asset, name: 'Source code.zip' }, asset] });
  });
  assert.deepEqual(latest, release);
  for (const current of [version, '0.7.0']) assert.equal(await checkLatest(current, metadata(info)), null);
  for (const flag of ['draft', 'prerelease']) {
    assert.equal(await checkLatest('0.5.3', metadata({ ...info, [flag]: true })), null);
  }
  for (const changes of [{ digest: null }, { size: 0 }, { state: 'open' },
    { browser_download_url: 'https://github.com/other-owner/repo/update.zip' }]) {
    await assert.rejects(checkLatest('0.5.3', metadata({ ...info, assets: [{ ...asset, ...changes }] })), /verifiable/);
  }
  await assert.rejects(checkLatest('0.5.3', async () => new Response(null, { status: 403 })), /limited/);
});

test('streams the official asset through its CDN redirect into a new file', async t => {
  const file = await temporaryZip(t);
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/test?signed=token';
  const requested = [];
  const get = async (target, options) => {
    requested.push(target);
    assert.equal(options.redirect, 'manual');
    if (target === url) return Response.redirect(cdn, 302);
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(bytes.subarray(0, 5));
      stream.enqueue(bytes.subarray(5));
      stream.close();
    } }));
  };
  await downloadRelease(release, file, get);
  assert.deepEqual(requested, [url, cdn]);
  assert.deepEqual(await fs.readFile(file), bytes);
  await assert.rejects(downloadRelease(release, file, get), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('redirects, verification failures and interrupted transfers leave no ZIP to install', async t => {
  const file = await temporaryZip(t);
  for (const location of ['https://example.com/test', 'http://release-assets.githubusercontent.com/test',
    'https://user@release-assets.githubusercontent.com/test']) {
    await assert.rejects(downloadRelease(release, file, async () => Response.redirect(location)), /location/);
  }
  for (const contents of [Buffer.alloc(bytes.length), bytes.subarray(1), Buffer.concat([bytes, bytes])]) {
    await assert.rejects(downloadRelease(release, file, async () => new Response(contents)), /size|did not match/);
  }
  const interrupted = () => new Response(new ReadableStream({ pull(stream) { stream.error(new TypeError('terminated')); } }));
  await assert.rejects(downloadRelease(release, file, interrupted), /connection/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
