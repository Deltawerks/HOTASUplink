'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { compareVersions, isStableVersion } = require('./github-release.cjs');

const run = promisify(execFile);
const executable = 'HOTAS Uplink.exe';
const receiptName = '.hotas-uplink-update.json';
const helper = path.join(__dirname, 'update-store-extract.exe');
const requiredFiles = [executable, 'resources.pak', 'resources/app/src/desktop/main.cjs',
  'resources/app/src/desktop/update-store-extract.exe', 'resources/app/package.json'];

async function storeRoot(storeDir) {
  if (!path.isAbsolute(storeDir)) throw new Error('Expected an absolute update folder.');
  const stat = await fs.lstat(storeDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid update folder.');
  return fs.realpath(storeDir);
}

async function regularFile(file) {
  const stat = await fs.lstat(file);
  return stat.isFile() && stat.size > 0 && path.relative(file, await fs.realpath(file)) === '';
}

async function matchesPackage(dir, version) {
  for (const file of requiredFiles) {
    if (!await regularFile(path.join(dir, file))) return false;
  }
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'resources/app/package.json'), 'utf8'));
  return manifest.name === 'deltawerks-hotas-uplink' && manifest.version === version;
}

async function installed(root, version, digest) {
  if (!isStableVersion(version)) return null;
  const dir = path.join(root, version);
  try {
    const receiptPath = path.join(dir, receiptName);
    if (!await regularFile(receiptPath)) return null;
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    if (receipt.version !== version || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
        (digest && digest !== receipt.sha256) || !await matchesPackage(dir, version)) return null;
    return path.join(dir, executable);
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

async function versions(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && isStableVersion(entry.name))
    .map(entry => entry.name).sort((a, b) => compareVersions(b, a));
}

async function newestInstalled(storeDir, currentVersion) {
  let root;
  try { root = await storeRoot(storeDir); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const version of await versions(root)) {
    if (compareVersions(version, currentVersion) <= 0) break;
    const exe = await installed(root, version);
    if (exe) return exe;
  }
  return null;
}

// Both new staging folders and retired installs must resolve to an immediate,
// updater-owned child before cleanup. Never traverse a user-added junction.
async function removePrivateDir(root, dir, prefix) {
  if (path.dirname(dir) !== root || !path.basename(dir).startsWith(prefix) ||
      path.relative(dir, await fs.realpath(dir)) !== '' || !(await fs.lstat(dir)).isDirectory()) return;
  const pending = [dir];
  while (pending.length) {
    const parent = pending.pop();
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return;
      if (entry.isDirectory()) {
        const child = path.join(parent, entry.name);
        if (path.relative(child, await fs.realpath(child)) !== '') return;
        pending.push(child);
      }
    }
  }
  await fs.rm(dir, { recursive: true, maxRetries: 2 });
}

async function installRelease(storeDir, release, zipPath, extractor = helper) {
  const { version, sha256 } = release;
  if (!isStableVersion(version) || !/^[a-f0-9]{64}$/.test(sha256) ||
      !path.isAbsolute(storeDir) || !path.isAbsolute(zipPath)) throw new Error('Invalid update package details.');
  await fs.mkdir(storeDir, { recursive: true });
  const root = await storeRoot(storeDir);
  const previous = await installed(root, version, sha256);
  if (previous) return previous;
  const dir = path.join(root, version);
  const stage = await fs.mkdtemp(path.join(root, '.install-'));
  let promoted = false;
  try {
    try { await run(extractor, [zipPath, stage, version, sha256], { windowsHide: true }); }
    catch (error) { throw new Error('Could not unpack the Windows update. ' + (error.stderr?.trim() || error.code || 'Try again.')); }
    if (!await matchesPackage(stage, version)) throw new Error('The Windows update has an unexpected package or version.');
    await fs.writeFile(path.join(stage, receiptName), JSON.stringify({version, sha256}), { flag: 'wx' });
    try { await fs.rename(stage, dir); promoted = true; }
    catch (error) {
      const concurrent = await installed(root, version, sha256);
      if (concurrent) return concurrent;
      throw error;
    }
    return path.join(dir, executable);
  } finally {
    if (!promoted) await removePrivateDir(root, stage, '.install-');
  }
}

async function pruneInstalled(storeDir, currentVersion) {
  try {
    const root = await storeRoot(storeDir);
    if (!await installed(root, currentVersion)) return;
    let keptPrevious = false;
    for (const version of await versions(root)) {
      if (compareVersions(version, currentVersion) >= 0 || !await installed(root, version)) continue;
      if (!keptPrevious) { keptPrevious = true; continue; }
      const retired = path.join(root, '.retired-' + randomUUID());
      await fs.rename(path.join(root, version), retired);
      await removePrivateDir(root, retired, '.retired-');
    }
  } catch { /* A busy install or a locked file can be left in place. */ }
}

module.exports = { installRelease, newestInstalled, pruneInstalled };
