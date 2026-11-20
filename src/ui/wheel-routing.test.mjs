import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import profiles from '../game/profile.cjs';
import { buildSheet, isWheelAxis, physicalInput } from './bindings.mjs';
import { draftDevices, previewEdit, resolveTarget, saveEdits, stageEdit } from './edit-draft.mjs';

const inventory = Object.fromEntries(['left', 'right'].map(device => [device, [
  { device, key: 'z', group: 'throttle', kind: 'axis', label: 'Base throttle · axis' },
  { device, key: 'x', group: 'motion', kind: 'axis', label: 'Grip · X axis' },
]]));
const hardware = [
  { id: 'R', name: 'VKBsim Gladiator EVO R SEM' },
  { id: 'L', name: 'VKBsim Gladiator EVO OT L' },
];

test('each wheel defaults to Z and accepts only its explicitly identified channel', () => {
  for (const key of ['z', 'slider1', 'slider2']) assert.ok(isWheelAxis(key));
  for (const key of ['x', 'Z', 'slider3', null, {}]) assert.equal(isWheelAxis(key), false);
  const wheels = setup => buildSheet(null, inventory, setup).filter(c => c.group === 'throttle').map(c => c.id);
  assert.deepEqual(wheels({ leftWheel: 'x', rightWheel: 'button1' }), ['left:z', 'right:z']);
  assert.deepEqual(wheels({ rightWheel: 'slider1' }), ['left:z', 'right:slider1']);
  assert.deepEqual(wheels({ leftWheel: 'slider2', rightWheel: 'slider1' }), ['left:slider2', 'right:slider1']);
  assert.deepEqual(wheels({ leftWheel: 'z', rightWheel: 'z' }), ['left:z', 'right:z']);
});

test('assigning an identified wheel round-trips its real game axis and retains original Z and other sliders', async t => {
  const livePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vkb-wheel-'));
  t.after(() => fs.rm(livePath, { recursive: true, force: true }));
  const config = path.join(livePath, 'Data', 'Libs', 'Config');
  await fs.mkdir(config, { recursive: true });
  const actions = ['old_right', 'left_wheel', 'new_right', 'second_slider'];
  await fs.writeFile(path.join(config, 'defaultProfile.xml'),
    '<profile><actionmap name="flight">' + actions.map(action => '<action name="' + action + '" joystick=" "/>').join('') + '</actionmap></profile>');
  const file = path.join(livePath, 'source.xml');
  const source = `<ActionMaps profileName="test">
    <options type="joystick" instance="1" Product="VKBsim Gladiator EVO R SEM"/>
    <options type="joystick" instance="2" Product="VKBsim Gladiator EVO OT L"/>
    <actionmap name="flight">
      <action name="old_right"><rebind input="js1_z"/></action>
      <action name="left_wheel"><rebind input="js2_z"/></action>
      <action name="second_slider"><rebind input="js1_slider2"/></action>
    </actionmap></ActionMaps>`;
  await fs.writeFile(file, source);
  const profile = await profiles.loadProfile({ livePath, profilePath: file });
  const setup = { rightWheel: 'slider1' };
  const viewed = buildSheet(profile, inventory, setup);
  const motion = physicalInput({ id: 'R', type: 'axis', axis: 'SLIDER1' }, hardware, inventory);
  const wheel = viewed.find(c => c.device === motion.device && c.key === motion.key);
  assert.equal(wheel.group, 'throttle');
  const target = resolveTarget({ control: wheel, hardware, profile });
  const action = { context: 'flight', action: 'new_right' };
  const edits = stageEdit([], previewEdit({ profile, action, target }));
  const saved = await profiles.saveLayout({ livePath, profilePath: file, name: 'Wheel test',
    expectedRevision: profile.source.revision, devices: draftDevices(profile, edits), edits: saveEdits(edits) });
  assert.equal(await fs.readFile(file, 'utf8'), source);
  const reloaded = await profiles.loadProfile({ livePath, profilePath: saved.path });
  const sheet = buildSheet(reloaded, inventory, setup);
  const route = id => {
    const c = sheet.find(entry => entry.id === id);
    return [c.group, ...c.rows.map(row => [row.action, row.slot, row.input])];
  };
  assert.deepEqual(route('right:slider1'), ['throttle', ['new_right', 1, 'slider1']]);
  assert.deepEqual(route('right:z'), ['unmapped', ['old_right', 1, 'z']]);
  assert.deepEqual(route('right:slider2'), ['unmapped', ['second_slider', 1, 'slider2']]);
  assert.deepEqual(route('left:z'), ['throttle', ['left_wheel', 2, 'z']]);
  assert.equal(sheet.filter(entry => entry.group === 'throttle').length, 2);
});
