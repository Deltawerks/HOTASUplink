'use strict';

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

const repo = 'Deltawerks/HOTASUplink';
const latestUrl = 'https://api.github.com/repos/' + repo + '/releases/latest';
const assetOrigins = new Set(['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com',
  'https://github-releases.githubusercontent.com']);

function isStableVersion(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split('.').every(part => Number.isSafeInteger(Number(part)));
}

function compareVersions(a, b) {
  if (!isStableVersion(a) || !isStableVersion(b)) throw new Error('Unrecognized HOTAS Uplink version.');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  }
  return 0;
}

function archiveName(version) {
  return 'HOTAS-Uplink-' + version + '-win32-' + process.arch + '.zip';
}

function archiveUrl(version) {
  return 'https://github.com/' + repo + '/releases/download/v' + version + '/' + archiveName(version);
}

function validateRelease(release) {
  if (!isStableVersion(release?.version) || release.url !== archiveUrl(release.version) ||
      !Number.isSafeInteger(release.size) || release.size <= 0 || release.size > 2 * 1024 ** 3 ||
      typeof release.sha256 !== 'string' || !/^[\da-f]{64}$/.test(release.sha256)) {
    throw new Error('GitHub has no verifiable Windows download for this release.');
  }
}

function readableError(error, signal) {
  if (signal.aborted) return new Error('The GitHub request timed out. Try again.');
  if (error instanceof TypeError) return new Error('Could not reach GitHub. Check your connection and try again.');
  return error;
}

async function checkLatest(currentVersion, fetchImpl = fetch) {
  const signal = AbortSignal.timeout(20_000);
  try {
    const response = await fetchImpl(latestUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HOTAS-Uplink' }, redirect: 'error', signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 403 || response.status === 429) throw new Error('GitHub limited update checks. Try again later.');
      throw new Error('GitHub update check failed (HTTP ' + response.status + ').');
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 1024 ** 2) throw new Error('GitHub returned an oversized release description.');
      chunks.push(chunk);
    }
    let info;
    try { info = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('GitHub returned an unreadable release description.'); }
    if (info?.prerelease === true || info?.draft === true) return null;
    if (info?.draft !== false || info?.prerelease !== false || typeof info.tag_name !== 'string' || !info.tag_name.startsWith('v')) {
      throw new Error('GitHub returned an unrecognized release.');
    }
    const version = info.tag_name.slice(1);
    if (compareVersions(version, currentVersion) <= 0) return null;
    const asset = info.assets?.find(entry => entry.name === archiveName(version) && entry.state === 'uploaded');
    const release = { version, url: asset?.browser_download_url, size: asset?.size,
      sha256: /^sha256:([\da-f]{64})$/i.exec(asset?.digest)?.[1].toLowerCase() };
    validateRelease(release);
    return release;
  } catch (error) { throw readableError(error, signal); }
}

async function assetResponse(url, signal, fetchImpl) {
  for (let hops = 0; hops < 5; hops++) {
    const response = await fetchImpl(url, { headers: { 'User-Agent': 'HOTAS-Uplink' }, redirect: 'manual', signal });
    if (response.status === 200 && response.body) return response;
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status)) throw new Error('GitHub download failed (HTTP ' + response.status + ').');
    const location = response.headers.get('location');
    const next = location && URL.parse(location, url);
    if (!next || !assetOrigins.has(next.origin) || next.username || next.password) {
      throw new Error('GitHub returned an unexpected download location.');
    }
    url = next.href;
  }
  throw new Error('GitHub redirected the download too many times.');
}

async function downloadRelease(release, filePath, fetchImpl = fetch) {
  validateRelease(release);
  const signal = AbortSignal.timeout(30 * 60_000);
  const file = await fs.open(filePath, 'wx');
  try {
    try {
      const response = await assetResponse(release.url, signal, fetchImpl);
      const hash = createHash('sha256');
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > release.size) throw new Error('The download exceeded the release size. Try again.');
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (received !== release.size || hash.digest('hex') !== release.sha256) {
        throw new Error('The downloaded ZIP did not match the GitHub release. Try again.');
      }
    } finally { await file.close(); }
  } catch (error) {
    await fs.unlink(filePath);
    throw readableError(error, signal);
  }
}

module.exports = { isStableVersion, compareVersions, checkLatest, downloadRelease };
