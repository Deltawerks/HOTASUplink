'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { listSources, loadProfile, listActions, saveLayout, applyNextLaunch, verifyLayout } = require('./profile.cjs');
const { stickFamily } = require('../rig/device-identity.mjs');
const { starterDefinitions, definitionsForStarter } = require('./starter-layouts.cjs');
const { falconStarterId } = require('../rig/falcon-starter.mjs');

async function setup(t, installed = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uplink-starter-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const livePath = path.join(directory, 'LIVE');
  if (installed) {
    const config = path.join(livePath, 'Data/Libs/Config');
    await fs.mkdir(config, { recursive: true });
    const byContext = Map.groupBy([...definitionsForStarter(falconStarterId).values()], d => d.context);
    const groups = [...byContext].map(([context, actions]) => '<actionmap name="' + context + '">' +
      actions.map(d => '<action name="' + d.action + '" joystick="" activationMode="' + d.activationMode + '"/>').join('') + '</actionmap>');
    groups.push('<actionmap name="extras"><action name="unrelated" joystick="js3_button10"/></actionmap>');
    await fs.writeFile(path.join(config, 'defaultProfile.xml'), '<profile>' + groups.join('') + '</profile>');
  }
  return livePath;
}

test('both bundled layouts identify each hand and offer editable flight actions without a game installation', async t => {
  const livePath = await setup(t);
  const sources = await listSources(livePath);
  assert.deepEqual(sources.map(s => s.path), ['starter:vkb', 'starter:virpil']);
  for (const source of sources) {
    const options = { livePath, profilePath: source.path };
    const preview = await loadProfile(options);
    assert.equal(preview.source.kind, 'starter');
    assert.equal(preview.source.canSave, false);
    assert.ok(preview.source.name.includes(source.manufacturer));
    const controls = new Set(preview.bindings.map(b => b.slot + ':' + b.input));
    assert.equal(controls.size, starterDefinitions.size);
    assert.equal(preview.bindings.length, controls.size);
    assert.deepEqual(preview.devices.map(d => d.device).sort(), ['left', 'right']);
    assert.ok(preview.devices.every(d => stickFamily(d) === source.manufacturer.toLowerCase()));
    const boost = preview.bindings.find(row => row.action === 'v_afterburner');
    assert.equal(boost.device, 'left');
    assert.equal(boost.input, source.path === 'starter:vkb' ? 'button1' : 'button4');
    assert.equal(boost.label, 'Boost');
    assert.equal((await listActions(options)).length, starterDefinitions.size);
    await assert.rejects(saveLayout({ ...options, name: 'Flight', expectedRevision: preview.source.revision }), /Choose.*LIVE/);
    await assert.rejects(applyNextLaunch(options, () => true), /Choose a saved layout/);
  }
  await assert.rejects(fs.stat(livePath), { code: 'ENOENT' });
});

test('an edited named starter copy reopens with the selected hands and no unrelated inherited joystick actions', async t => {
  const livePath = await setup(t, true);

  for (const family of ['vkb', 'virpil']) {
    const options = { livePath, profilePath: 'starter:' + family };
    const starter = await loadProfile(options);
    assert.equal(starter.source.canSave, true);
    assert.equal(starter.bindings.length, starterDefinitions.size);
    assert.ok(starter.bindings.every(row => row.origin === 'profile'));
    const boost = starter.bindings.find(row => row.action === 'v_afterburner');
    const saved = await saveLayout({ ...options, expectedRevision: starter.source.revision, devices: starter.devices,
      name: 'My ' + family, edits: [{ context: boost.context, action: boost.action, device: 'left', slot: boost.slot,
        input: 'button31', previous: boost }] });
    const reopened = await loadProfile({ livePath, profilePath: saved.path });
    assert.deepEqual(reopened.devices, starter.devices);
    assert.deepEqual(reopened.bindings, starter.bindings.map(row => row === boost ? { ...boost, input: 'button31' } : row));
    const untouched = await loadProfile(options);
    assert.deepEqual(untouched.bindings, starter.bindings);
    assert.equal(untouched.source.revision, starter.source.revision);
  }
});

test('untouched named starter copies apply to reordered hands while preserving keyboard and other joystick bindings', async t => {
  const livePath = await setup(t, true);
  const file = path.join(livePath, 'USER/Client/0/Profiles/default/actionmaps.xml');
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const family of ['vkb', 'virpil']) {
    const model = family === 'vkb' ? 'VKB Gladiator EVO' : 'VPC MT-50CM3';
    const original = `<ActionMaps><ActionProfiles profileName="Pilot">
      <options type="joystick" instance="1" Product="${model} L"/>
      <options type="joystick" instance="2" Product="${model} R"/>
      <options type="joystick" instance="3" Product="Independent throttle"/>
      <actionmap name="spaceship_movement"><action name="v_afterburner">
        <rebind input="kb1_lshift"/><rebind input="js3_button9"/>
      </action></actionmap></ActionProfiles></ActionMaps>`;
    await fs.writeFile(file, original);
    const options = { livePath, profilePath: 'starter:' + family };
    const preview = await loadProfile(options);
    const saved = await saveLayout({ ...options, expectedRevision: preview.source.revision, name: 'Base ' + family });
    const named = await loadProfile({ livePath, profilePath: saved.path });
    assert.deepEqual(named.bindings, preview.bindings);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    const request = { livePath, profilePath: saved.path, expectedRevision: named.source.revision, scope: { family, pedals: false } };
    const active = await loadProfile({ livePath });
    const applied = await applyNextLaunch({ ...request, expectedActiveRevision: active.source.revision }, async () => {});
    assert.equal(await fs.readFile(applied.backup.path, 'utf8'), original);
    const result = await loadProfile({ livePath });
    for (const row of named.bindings) {
      assert.ok(result.bindings.some(actual => actual.action === row.action && actual.context === row.context &&
        actual.input === row.input && actual.slot === (row.slot === 1 ? 2 : 1) && actual.device === row.device));
    }
    assert.ok(result.bindings.some(row => row.slot === 3 && row.input === 'button9' && row.action === 'v_afterburner'));
    assert.ok(result.bindings.some(row => row.slot === 3 && row.input === 'button10' && row.action === 'unrelated'));
    assert.match(await fs.readFile(file, 'utf8'), /<rebind input="kb1_lshift"\/>/);
    assert.equal((await verifyLayout(request)).status, 'match');
  }
});

test('pedal starter includes rudder and only identified toe axes, isolated from the two-stick starter', async t => {
  const livePath = await setup(t);
  const options = { livePath, profilePath: falconStarterId };
  const none = await loadProfile(options);
  assert.deepEqual(none.source.pedalAxes, {});
  assert.deepEqual(none.bindings.filter(b => b.device === 'pedals').map(b => [b.action, b.input]), [['v_roll', 'z']]);
  assert.deepEqual(none.bindings.filter(b => b.action === 'v_roll').map(b => b.device), ['right', 'pedals']);
  const pedalAxes = { 'right-toe': ' RY ' };
  const one = await loadProfile({ ...options, pedalAxes });
  assert.deepEqual(one.source.pedalAxes, { 'right-toe': 'roty' });
  const toe = one.bindings.find(b => b.physicalKey === 'right-toe');
  assert.deepEqual([toe.context, toe.action, toe.device, toe.input], ['vehicle_driver', 'v_move_forward', 'pedals', 'roty']);
  assert.ok(!one.bindings.some(b => b.physicalKey === 'left-toe'));
  assert.notEqual(none.source.revision, one.source.revision);
  for (const invalid of [{ 'left-toe': 'z' }, { 'left-toe': 'button1' }, { 'left-toe': 'rx', 'right-toe': 'rotx' }]) {
    await assert.rejects(loadProfile({ ...options, pedalAxes: invalid }), /distinct pedal axis/);
  }
  const standard = await loadProfile({ livePath, profilePath: 'starter:virpil', pedalAxes });
  assert.equal(standard.devices.length, 2);
  assert.equal(standard.bindings.length, 34);
});

test('calibrated starter pedals save, verify and apply by physical role with reordered game slots', async t => {
  const livePath = await setup(t, true);
  const options = { livePath, profilePath: falconStarterId, pedalAxes: { 'left-toe': 'slider2', 'right-toe': 'x' } };
  const preview = await loadProfile(options);
  const name = 'With pedals';
  await assert.rejects(saveLayout({ ...options, name, pedalAxes: {}, expectedRevision: preview.source.revision }), /changed/);
  const saved = await saveLayout({ ...options, name, expectedRevision: preview.source.revision });
  const reopened = await loadProfile({ livePath, profilePath: saved.path });
  assert.deepEqual(reopened.devices, preview.devices);
  assert.deepEqual(reopened.bindings, preview.bindings);
  const file = path.join(livePath, 'USER/Client/0/Profiles/default/actionmaps.xml');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const active = '<ActionMaps profileName="Pilot"><options type="joystick" instance="1" Product="VPC R1-FALCON Pedals"/>' +
    '<options type="joystick" instance="2" Product="LEFT VPC Stick MT-50CM3"/><options type="joystick" instance="3" Product="RIGHT VPC Stick MT-50CM3"/>' +
    '<actionmap name="vehicle_driver"><action name="v_move_back"><rebind input="kb1_s"/><rebind input="js1_y"/></action></actionmap></ActionMaps>';
  await fs.writeFile(file, active);
  const request = { livePath, profilePath: saved.path, expectedRevision: reopened.source.revision, scope: { family: 'virpil', pedals: false } };
  const before = await loadProfile({ livePath });
  await applyNextLaunch({ ...request, expectedActiveRevision: before.source.revision }, async () => {});
  const off = await loadProfile({ livePath });
  assert.deepEqual(off.bindings.filter(b => b.device === 'pedals').map(b => b.input), ['y']);
  request.scope.pedals = true;
  await applyNextLaunch({ ...request, expectedActiveRevision: off.source.revision }, async () => {});
  const on = await loadProfile({ livePath });
  const byInput = new Map(on.bindings.filter(b => b.device === 'pedals').map(b => [b.input, b]));
  assert.equal(byInput.size, 3);
  assert.equal(byInput.get('z').action, 'v_roll');
  assert.deepEqual([byInput.get('slider2').action, byInput.get('slider2').physicalKey], ['v_move_back', 'left-toe']);
  assert.deepEqual([byInput.get('x').action, byInput.get('x').physicalKey], ['v_move_forward', 'right-toe']);
  assert.ok(on.bindings.some(b => b.slot === 3 && b.input === 'z' && b.action === 'v_roll'));
  assert.match(await fs.readFile(file, 'utf8'), /kb1_s/);
  assert.equal((await verifyLayout(request)).status, 'match');
});
