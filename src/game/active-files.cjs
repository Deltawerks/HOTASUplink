'use strict';

const fs = require('node:fs/promises');
const { unlinkSync, rmdirSync } = require('node:fs');
const { isUtf8 } = require('node:buffer');
const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { readXml } = require('./xml.cjs');

const execute = promisify(execFile);
const maxSize = 16 * 1024 * 1024;
const backupPattern = /^actionmaps-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z)-([0-9a-f]{64})\.xml(\.pending)?$/;
const staleMessage = 'The active game settings changed. Review the current settings and try again.';
const missingMessage = 'No active game profile was found. Start Star Citizen once and save your bindings first.';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let probePath;

async function findProbe() {
  const packaged = path.join(__dirname, 'GameStatus.exe');
  try { await fs.access(packaged); return packaged; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // A source checkout can run from npm start without a packaged helper.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'hotas-uplink-game-status-'));
  const exe = path.join(work, 'GameStatus.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
  try {
    await execute(compiler, ['/nologo', '/target:exe', '/optimize+', '/out:' + exe, path.join(__dirname, 'GameStatus.cs')], { windowsHide: true, timeout: 15000 });
  } catch (error) {
    await fs.rm(exe, { force: true });
    await fs.rmdir(work);
    throw error;
  }
  process.once('exit', () => {
    try { unlinkSync(exe); rmdirSync(work); } catch { /* Temp cleanup is best effort at shutdown. */ }
  });
  return exe;
}

async function checkGameClosed() {
  if (process.platform !== 'win32') throw new Error('Checking whether Star Citizen is closed requires Windows.');
  let status;
  try {
    probePath ||= findProbe().catch(error => { probePath = undefined; throw error; });
    const { stdout } = await execute(await probePath, [], { windowsHide: true, timeout: 5000, maxBuffer: 1024 });
    status = stdout.trim();
  } catch { /* Treat unavailable or interrupted process enumeration as unknown. */ }
  if (status === 'running') throw new Error('Close Star Citizen before applying or restoring bindings.');
  if (status !== 'closed') throw new Error('Could not confirm Star Citizen is closed. Check again before applying or restoring bindings.');
}

function paths(livePath) {
  const directory = path.resolve(livePath, 'user', 'client', '0', 'Profiles', 'default');
  return { directory, active: path.join(directory, 'actionmaps.xml'), backups: path.join(directory, 'HOTAS-Uplink-backups'),
    legacyBackups: path.join(directory, 'VKBTool-backups') };
}

async function readFile(filename) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.size > maxSize) throw new Error('Expected a regular profile file smaller than 16 MiB: ' + filename);
  const bytes = await fs.readFile(filename);
  if (bytes.length > maxSize) throw new Error('The profile file grew while it was being read.');
  return { bytes, revision: digest(bytes), mode: info.mode & 0o777 };
}

function checkProfile(bytes) {
  if (!bytes.length || bytes.length > maxSize || bytes.includes(0) || !isUtf8(bytes)) throw new Error('Expected a UTF-8 active game profile.');
  const root = readXml(bytes);
  if (!['ActionMaps', 'ActionProfiles'].includes(root.tag) ||
      (!root.attrs.version && !root.attrs.profileName && !root.children.some(n => ['ActionProfiles','actionmap','options'].includes(n.tag)))) {
    throw new Error('The file does not contain recognizable Star Citizen active settings.');
  }
}

async function readActive(files) {
  try { return await readFile(files.active); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function readBackupDirectory(directory, activeRevision) {
  let entries;
  try {
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('The binding backup location must be a regular directory.');
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; }
  const backups = [];
  for (const entry of entries) {
    const match = backupPattern.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const [, stamp, originalHash, pending] = match;
    // A pending file is already a complete backup. If the app was interrupted
    // before replacing actionmaps.xml the previous committed backup still applies.
    if (pending && activeRevision === originalHash) continue;
    const createdAt = stamp.slice(0, 11) + stamp.slice(11).replaceAll('-', ':');
    if (!Number.isFinite(Date.parse(createdAt))) continue;
    backups.push({
      id: entry.name.replace(/\.pending$/, ''), path: path.join(directory, entry.name), createdAt
    });
  }
  return backups;
}

async function listBackups(files, activeRevision) {
  const [current, legacy] = await Promise.all([files.backups, files.legacyBackups]
    .map(directory => readBackupDirectory(directory, activeRevision)));
  // An id includes both the timestamp and content hash. Prefer the current copy if both exist.
  const history = new Map();
  for (const entry of [...legacy, ...current]) history.set(entry.id, entry);
  return [...history.values()].sort((a, b) => b.id.localeCompare(a.id));
}

async function getActiveFileState(livePath, checkClosed = checkGameClosed) {
  const state = { canApply: false, canRestore: false, reason: '', activeRevision: null, backup: null, backups: [] };
  try {
    const files = paths(livePath);
    const active = await readActive(files);
    state.activeRevision = active?.revision ?? null;
    state.backups = await listBackups(files, state.activeRevision);
    state.backup = state.backups[0] || null;
    if (!active && !state.backup) throw new Error(missingMessage);
    await checkClosed();
    state.canRestore = Boolean(state.backup);
    if (!active) throw new Error('The active game profile is missing. Restore a binding backup to recreate it.');
    checkProfile(active.bytes);
    state.canApply = true;
  } catch (error) { state.reason = error.message; }
  return state;
}

async function lockProfile(directory) {
  // Windows releases a named pipe on process exit, including after a crash.
  // Retain the original lock namespace so earlier releases cannot race a write to this installation.
  let key;
  try { key = await fs.realpath(directory); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error(missingMessage);
    throw error;
  }
  if (process.platform === 'win32') key = key.toLowerCase();
  const name = 'vkbtool-bindings-' + digest(key).slice(0, 32);
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(os.tmpdir(), name + '.sock');
  const lock = net.createServer(peer => peer.destroy());
  try {
    await new Promise((resolve, reject) => {
      lock.once('error', reject);
      lock.listen(endpoint, resolve);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error('A change to these bindings is already in progress. Try again when it finishes.');
    throw error;
  }
  return () => new Promise(resolve => lock.close(resolve));
}

async function writeNew(filename, bytes, mode) {
  const handle = await fs.open(filename, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function stageBackup(directory, current, previous) {
  await fs.mkdir(directory, { recursive: true });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('The binding backup location must be a regular directory.');
  const time = Math.max(Date.now(), previous ? Date.parse(previous.createdAt) + 1 : 0);
  const createdAt = new Date(time).toISOString();
  const id = 'actionmaps-' + createdAt.replaceAll(':', '-') + '-' + current.revision + '.xml';
  const finalPath = path.join(directory, id);
  const stage = path.join(directory, randomUUID() + '.tmp');
  // Only a complete, flushed backup may enter the recovery list.
  try {
    await writeNew(stage, current.bytes, 0o600);
    await fs.rename(stage, finalPath + '.pending');
  } finally { await fs.rm(stage, { force: true }); }
  return { id, path: finalPath, createdAt };
}

async function publishProfile(temp, active, create) {
  if (!create) return fs.rename(temp, active);
  // Linking the complete, flushed staging file publishes it in one step, and
  // fails if the game has recreated actionmaps.xml since the final check.
  try { await fs.link(temp, active); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(staleMessage);
    throw error;
  }
}

async function updateActive(options, checkClosed, restoring) {
  const files = paths(options.livePath);
  const unlock = await lockProfile(files.directory);
  try {
    await checkClosed();
    const current = await readActive(files);
    if (!current && !restoring) throw new Error(missingMessage);
    const currentRevision = current?.revision ?? null;
    if (options.expectedActiveRevision !== currentRevision) throw new Error(staleMessage);
    const history = await listBackups(files, currentRevision);
    let backup = history[0] || null;
    let replacement;
    if (restoring) {
      backup = history.find(entry => entry.id === options.backupId);
      if (!backup) throw new Error('The selected backup is unavailable. Refresh and try again.');
      const saved = await readFile(backup.path);
      if (saved.revision !== backupPattern.exec(backup.id)[2]) throw new Error('The binding backup changed on disk. Restore was cancelled.');
      replacement = saved.bytes;
    } else {
      checkProfile(current.bytes);
      replacement = Buffer.from(await options.transform(current.bytes));
    }
    checkProfile(replacement);
    const changed = !current || !replacement.equals(current.bytes);
    const temp = path.join(files.directory, '.hotas-uplink-' + randomUUID() + '.tmp');
    let pending;
    try {
      if (changed) {
        await writeNew(temp, replacement, current?.mode ?? 0o600);
        if (!restoring) {
          backup = await stageBackup(files.backups, current, backup);
          pending = backup.path + '.pending';
        }
      }
      if (options.validateSource) await options.validateSource();
      await checkClosed();
      if (((await readActive(files))?.revision ?? null) !== currentRevision) throw new Error(staleMessage);
      if (changed) {
        if (restoring && backup.path.endsWith('.pending')) {
          // A committed apply may have been interrupted before publishing the
          // backup name. Keep it in history even after its bytes become active again.
          const published = path.join(path.dirname(backup.path), backup.id);
          await fs.rename(backup.path, published);
          backup.path = published;
        }
        await publishProfile(temp, files.active, !current);
        if (pending) {
          const recoverable = pending;
          pending = null; // The backup must survive after committing to the active file.
          try { await fs.rename(recoverable, backup.path); }
          catch { backup.path = recoverable; }
        }
      }
      return { changed, activeRevision: digest(replacement), backup };
    } finally {
      if (pending) await fs.rm(pending, { force: true });
      if (changed) await fs.rm(temp, { force: true });
    }
  } finally { await unlock(); }
}

const applyActiveFile = (options, checkClosed = checkGameClosed) => updateActive(options, checkClosed, false);
const restoreActiveFile = (options, checkClosed = checkGameClosed) => updateActive(options, checkClosed, true);

module.exports = { getActiveFileState, applyActiveFile, restoreActiveFile, checkGameClosed, lockProfile, readProfileFile: readFile };
