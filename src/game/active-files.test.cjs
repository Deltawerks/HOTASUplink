'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { getActiveFileState, applyActiveFile, restoreActiveFile } = require('./active-files.cjs');

const closed = async () => {};
const running = async () => { throw new Error('Game is running'); };
const xml = key => Buffer.from('\uFEFF<ActionMaps>\r\n <ActionProfiles profileName="default"><actionmap name="flight"><action name="foo"><rebind input="js1_button' + key + '"/></action></actionmap></ActionProfiles>\r\n</ActionMaps>\r\n');

async function fixture(t) {
  const livePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vkb-active-files-'));
  t.after(() => fs.rm(livePath, { recursive: true, force: true }));
  const directory = path.join(livePath, 'user/client/0/Profiles/default');
  const active = path.join(directory, 'actionmaps.xml');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(active, xml(1));
  const status = () => getActiveFileState(livePath, closed);
  const apply = async (content, guard = closed, extra = {}) => applyActiveFile({
    livePath, expectedActiveRevision: (await status()).activeRevision, transform: () => content, ...extra
  }, guard);
  const restore = async (backupId, guard = closed) => {
    const current = await status();
    return restoreActiveFile({ livePath, expectedActiveRevision: current.activeRevision, backupId: backupId || current.backup.id }, guard);
  };
  return { livePath, active, directory, status, apply, restore };
}

test('each changed apply protects its immediate predecessor; repeat apply/restore are idempotent', async t => {
  const f = await fixture(t);
  assert.equal((await f.status()).canRestore, false);
  const first = await f.apply(xml(2));
  assert.deepEqual(await fs.readFile(first.backup.path), xml(1));
  assert.deepEqual(await fs.readFile(f.active), xml(2));
  assert.equal((await f.apply(xml(2))).changed, false);
  assert.equal((await f.status()).backup.id, first.backup.id);
  const second = await f.apply(xml(3));
  assert.notEqual(second.backup.id, first.backup.id);
  assert.deepEqual(await fs.readFile(second.backup.path), xml(2));
  assert.deepEqual(await fs.readFile(first.backup.path), xml(1));
  assert.deepEqual((await f.status()).backups.map(entry => entry.id), [second.backup.id, first.backup.id]);
  await assert.rejects(f.restore('../actionmaps.xml'), /selected backup is unavailable/);
  assert.equal((await f.restore(first.backup.id)).changed, true);
  assert.deepEqual(await fs.readFile(f.active), xml(1));
  assert.equal((await f.restore(first.backup.id)).changed, false);
  assert.equal((await f.restore()).changed, true);
  assert.deepEqual(await fs.readFile(f.active), xml(2));
  assert.equal((await f.restore()).changed, false);
});

test('restores older backups beside new snapshots, including an interrupted legacy apply', async t => {
  const f = await fixture(t);
  const first = await f.apply(xml(2));
  assert.equal(path.basename(path.dirname(first.backup.path)), 'HOTAS-Uplink-backups');
  const previous = path.join(f.directory, 'VKBTool-backups');
  await fs.rename(path.dirname(first.backup.path), previous);
  const legacyBackup = path.join(previous, first.backup.id);
  await fs.rename(legacyBackup, legacyBackup + '.pending');
  assert.equal((await f.status()).backup.path, legacyBackup + '.pending');
  await f.restore(first.backup.id);
  assert.deepEqual(await fs.readFile(f.active), xml(1));
  assert.deepEqual(await fs.readFile(legacyBackup), xml(1));
  const second = await f.apply(xml(3));
  assert.equal(path.dirname(second.backup.path), path.join(f.directory, 'HOTAS-Uplink-backups'));
  assert.deepEqual((await f.status()).backups.map(backup => backup.id), [second.backup.id, first.backup.id]);
});

test('game launch, process-check failure and stale source or active XML abort without dropping a good backup', async t => {
  const f = await fixture(t);
  const old = (await f.status()).activeRevision;
  const previous = await f.apply(xml(2));
  const blocked = await getActiveFileState(f.livePath, running);
  assert.equal(blocked.canApply, false);
  assert.equal(blocked.canRestore, false);
  assert.match(blocked.reason, /running/);
  const nowRunning = () => {
    let checks = 0;
    return async () => { if (++checks === 2) throw new Error('Game is running'); };
  };
  await assert.rejects(f.apply(xml(3), nowRunning()), /running/);
  await assert.rejects(f.restore(previous.backup.id, nowRunning()), /running/);
  await assert.rejects(f.apply(xml(3), async () => { throw new Error('Process check failed'); }), /Process check failed/);
  await assert.rejects(f.apply(xml(3), closed, { expectedActiveRevision: old }), /active game settings changed/);
  await assert.rejects(f.apply(xml(3), closed, { validateSource: async () => { throw new Error('Preset changed'); } }), /Preset changed/);
  assert.deepEqual(await fs.readFile(f.active), xml(2));
  await assert.rejects(f.apply(xml(3), closed, { validateSource: () => fs.writeFile(f.active, xml(4)) }), /active game settings changed/);
  assert.deepEqual(await fs.readFile(f.active), xml(4));
  assert.deepEqual(await fs.readdir(path.dirname(previous.backup.path)), [previous.backup.id]);
});

test('missing profiles and malformed replacements are rejected; validated backups recover malformed active data', async t => {
  const f = await fixture(t);
  await assert.rejects(f.apply('<ActionMaps>'), /XML/);
  assert.deepEqual(await fs.readdir(f.directory), ['actionmaps.xml']);
  const first = await f.apply(xml(2));
  await fs.writeFile(f.active, '<broken>');
  const damaged = await f.status();
  assert.equal(damaged.canApply, false);
  assert.equal(damaged.canRestore, true);
  await assert.rejects(f.apply(xml(3)), /XML/);
  await f.restore();
  assert.deepEqual(await fs.readFile(f.active), xml(1));
  await fs.writeFile(first.backup.path, xml(9));
  await assert.rejects(f.restore(), /backup changed/);
  assert.deepEqual(await fs.readFile(f.active), xml(1));
  await fs.unlink(f.active);
  const missing = await f.status();
  assert.equal(missing.canApply, false);
  assert.equal(missing.canRestore, true);
  await assert.rejects(f.restore(), /backup changed/);
  await fs.unlink(first.backup.path);
  const empty = await f.status();
  assert.equal(empty.canApply, false);
  assert.equal(empty.canRestore, false);
  assert.match(empty.reason, /No active game profile/);
  await assert.rejects(f.apply(xml(2)), /No active game profile/);
});

test('restore recreates a missing active file only if the reviewed empty destination is still free', async t => {
  const f = await fixture(t);
  const first = await f.apply(xml(2));
  const lastRevision = (await f.status()).activeRevision;
  await fs.unlink(f.active);
  const missing = await f.status();
  assert.equal(missing.activeRevision, null);
  assert.equal(missing.canApply, false);
  assert.equal(missing.canRestore, true);
  assert.deepEqual(missing.backups.map(b => b.id), [first.backup.id]);
  await assert.rejects(restoreActiveFile({ livePath: f.livePath, expectedActiveRevision: lastRevision, backupId: first.backup.id }, closed), /settings changed/);
  await assert.rejects(f.restore('../actionmaps.xml'), /selected backup is unavailable/);
  await assert.rejects(f.restore(first.backup.id, running), /running/);
  // Simulate the game recreating the active file between our last revision
  // check and the actual publish syscall. Its new controls must survive.
  const link = fs.link;
  const race = t.mock.method(fs, 'link', async (from, to) => {
    await fs.writeFile(to, xml(3), { flag: 'wx' });
    return link(from, to);
  });
  try { await assert.rejects(f.restore(), /settings changed/); }
  finally { race.mock.restore(); }
  assert.deepEqual(await fs.readFile(f.active), xml(3));
  await fs.unlink(f.active);
  assert.equal((await f.restore()).changed, true);
  assert.deepEqual(await fs.readFile(f.active), xml(1));
  assert.equal((await f.status()).canApply, true);
  assert.equal((await f.restore()).changed, false);
});

test('a pending transaction survives interruption on either side of the active-file rename', async t => {
  const f = await fixture(t);
  const first = await f.apply(xml(2));
  const second = await f.apply(xml(3));
  await fs.rename(second.backup.path, second.backup.path + '.pending');
  // A pending write that never reached its active rename must not hide the
  // earlier backup while the old contents remain active.
  await fs.writeFile(f.active, xml(2));
  assert.equal((await f.status()).backup.id, first.backup.id);
  // After the active rename, that same pending file is a recoverable snapshot.
  await fs.writeFile(f.active, xml(3));
  assert.equal((await f.status()).backup.id, second.backup.id);
  assert.equal((await f.restore()).changed, true);
  assert.deepEqual(await fs.readFile(f.active), xml(2));
  assert.equal((await f.status()).backup.id, second.backup.id);
  assert.equal((await f.restore()).changed, false);
});

test('competing writes to a single installation cannot both pass the initial revision check', async t => {
  const f = await fixture(t);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  const first = f.apply(xml(2), closed, { transform: async () => { entered(); await pause; return xml(2); } });
  await ready;
  try { await assert.rejects(f.apply(xml(3)), /already in progress/); }
  finally { release(); await first; }
  assert.deepEqual(await fs.readFile(f.active), xml(2));
});

test('Windows process probe recognizes the game executable name without opening a game or device', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vkb-probe-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework/v4.0.30319/csc.exe');
  const probe = path.join(directory, 'GameStatus.exe');
  const run = promisify(execFile);
  const options = { windowsHide: true, timeout: 15000 };
  await run(compiler, ['/nologo', '/target:exe', '/out:' + probe, path.join(__dirname, 'GameStatus.cs')], options);
  assert.match((await run(probe, [], options)).stdout.trim(), /^(closed|running)$/);
  // A second copy of just the probe can see its own name in the snapshot.
  const gameNamedProbe = path.join(directory, 'StarCitizen.exe');
  await fs.copyFile(probe, gameNamedProbe);
  assert.equal((await run(gameNamedProbe, [], options)).stdout.trim(), 'running');
});
