import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSheet } from './bindings.mjs';
import { actionNames, orderedActions, rigLabels } from './rig-labels.mjs';
import { controlsByDevice as factoryControls } from '../rig/controls.js';
import { Vector3 } from 'three';
import { anchors } from '../rig/anchors.js';
import { createSchematic } from '../rig/schematic.js';
import { defaultRig, rigForId, rigProfiles } from '../rig/profiles.mjs';
import { modelAssetsByRig, virpilAlphaId } from '../rig/model-assets.mjs';

test('the setup picker resolves old preferences and every registered control has a model anchor', () => {
  assert.equal(rigForId(undefined), defaultRig);
  assert.equal(rigForId('removed-setup'), defaultRig);
  assert.deepEqual(rigProfiles.map(profile => profile.id).sort(), Object.keys(modelAssetsByRig).sort());
  for (const profile of rigProfiles) {
    assert.equal(rigForId(profile.id), profile);
    assert.deepEqual(Object.keys(profile.devices).sort(), Object.keys(modelAssetsByRig[profile.id]).sort());
    for (const [id, device] of Object.entries(profile.devices)) {
      assert.equal(device.model, modelAssetsByRig[profile.id][id]);
      for (const control of profile.controlsByDevice[id]) {
        assert.ok(profile.anchors[id][control.group], id + '/' + control.group);
        assert.ok(profile.surfaceNormals[id][control.group], id + '/' + control.group);
      }
    }
  }
  assert.deepEqual(Object.keys(defaultRig.deskPositions('off')), ['left', 'right']);
  for (const side of ['left', 'right']) assert.ok(defaultRig.deskPositions(side).sem);
});

test('Alpha Prime uses the factory chart for each hand, including mirrored hats and analog inputs', () => {
  const profile = rigForId(virpilAlphaId);
  for (const side of ['left', 'right']) {
    const controls = profile.controlsByDevice[side];
    assert.deepEqual(controls.filter(c => c.kind === 'button').map(c => c.key),
      Array.from({ length: 32 }, (_, i) => 'button' + (i + 1)));
    assert.deepEqual(controls.filter(c => c.kind === 'axis').map(c => c.key).sort(),
      ['rotx','roty','slider1','x','y','z']);
    const sheet = buildSheet(null, profile.controlsByDevice, {}, profile.family);
    const labels = rigLabels(sheet, side, null, { compact: true });
    for (const start of [8,14,23]) {
      const label = labels.find(item => item.key === 'button' + start);
      const left = label.hatSlots.find(slot => slot.direction === 'left');
      const right = label.hatSlots.find(slot => slot.direction === 'right');
      assert.equal(left.key, 'button' + (start + (side === 'left' ? 4 : 2)));
      assert.equal(right.key, 'button' + (start + (side === 'left' ? 2 : 4)));
    }
    const mini = labels.find(item => item.group === 'ministick');
    assert.deepEqual(mini.hatSlots.map(entry => entry.direction), ['press','horizontal','vertical']);
    assert.equal(controls.find(c => c.key === 'button32').group, controls.find(c => c.key === 'slider1').group);
  }
});

test('unassigned VIRPIL flyouts preserve every editable slot and the separate press stages', () => {
  const profile = rigForId(virpilAlphaId);
  const sheet = buildSheet(null, profile.controlsByDevice, {}, profile.family);
  const labels = rigLabels(sheet, 'all', null, { compact: true, editing: true });
  for (const side of ['left', 'right']) {
    const groups = labels.filter(item => item.device === side);
    assert.deepEqual(groups.map(item => item.group).sort(),
      ['lower-hat', 'ministick', 'rocker', 'scroll', 'thumb-hat', 'upper-hat']);
    for (const item of groups) {
      assert.equal(item.editSlots, true);
      assert.equal(item.compactName, item.groupTitle);
      assert.deepEqual(item.hatSlots.map(entry => entry.key), item.groupEntries.map(entry => entry.key));
      assert.ok(item.hatSlots.every(entry => !entry.actions.length && entry.text === 'Unassigned'));
    }
    const slots = group => Object.fromEntries(groups.find(item => item.group === group).hatSlots.map(s => [s.key, s.direction]));
    assert.deepEqual(slots('scroll'), { button19: 'press', button20: 'second-press', button21: 'up', button22: 'down' });
    assert.deepEqual(slots('rocker'), { button28: 'press', button29: 'up', button30: 'down' });
    for (const n of [7,13]) {
      const item = rigLabels(sheet, side, side + ':button' + n, { compact: true }).find(item => item.active);
      assert.equal(item.hatSlots, undefined);
      assert.equal(item.groupEntries.length, 1);
    }
  }
});

test('the SEM dial exposes its four positions before selection and keeps assignments on the correct tile', () => {
  const bindings = [{ physicalDevice: 'sem', slot: 1, input: 'button55', label: 'Request Landing' }];
  for (const placement of ['left', 'right']) {
    const options = { compact: true, editing: true, placement };
    const blank = buildSheet(null, factoryControls, { placement });
    const dial = rigLabels(blank, 'all', null, options).find(item => item.group === 'mode');
    assert.equal(dial.compactName, 'Mode dial');
    assert.equal(dial.editSlots, true);
    assert.deepEqual(dial.hatSlots.map(slot => [slot.direction, slot.key, slot.text]), [
      ['1', 'button53', 'Unassigned'], ['2', 'button54', 'Unassigned'],
      ['3', 'button55', 'Unassigned'], ['4', 'button56', 'Unassigned'],
    ]);
    const sheet = buildSheet({ bindings }, factoryControls, { placement });
    const focused = rigLabels(sheet, 'sem', 'sem:button56', options).find(item => item.group === 'mode');
    assert.deepEqual(focused.hatSlots.map(slot => slot.text), ['Unassigned', 'Unassigned', 'Request Landing', 'Unassigned']);
    assert.ok(focused.hatSlots[3].active);
    assert.ok(rigLabels(sheet, 'all', null, { ...options, placement: 'off' }).every(item => item.device !== 'sem'));
  }
});

test('R1-FALCON fits in front of both sticks and has separate reference markers for each axis', () => {
  const profile = rigForId(virpilAlphaId);
  assert.equal(profile.deskPositions('off', false).pedals, undefined);
  const desk = profile.deskPositions('off', true);
  assert.equal(desk.pedals[0], 0);
  assert.ok(desk.pedals[1] > Math.max(desk.left[1], desk.right[1]));
  const controls = profile.controlsByDevice.pedals;
  assert.deepEqual(controls.map(c => [c.group, c.key, Boolean(c.needsCapture)]), [
    ['rudder', 'z', false], ['left-toe', 'left-toe', true], ['right-toe', 'right-toe', true],
  ]);
  const sheet = controls.map(c => ({ ...c, id: c.device + ':' + c.key, rows: [] }));
  const labels = rigLabels(sheet, 'all', null, { reference: true });
  assert.deepEqual(labels.map(l => [l.deviceTitle, l.referenceSide]), [
    ['Pedals', 'right'], ['Pedals', 'left'], ['Pedals', 'right'],
  ]);
  assert.ok(profile.anchors.pedals['left-toe'][0] < 0 && profile.anchors.pedals['right-toe'][0] > 0);
});

test('each bundled schematic covers the same control locations as the optional rig models', () => {
  for (const [device, positions] of Object.entries(anchors)) {
    const mesh = createSchematic(device);
    try {
      const geometry = mesh.geometry;
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox.clone().expandByScalar(.002);
      for (const [group, position] of Object.entries(positions)) {
        assert.ok(bounds.containsPoint(new Vector3(...position)), device + '/' + group);
      }
      assert.equal(geometry.attributes.position.count, geometry.attributes.normal.count);
      assert.equal(geometry.attributes.position.count, geometry.attributes.color.count);
      assert.ok(geometry.attributes.position.array.every(Number.isFinite));
    } finally { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
});

function thumb(device) {
  return ['up', 'right', 'down', 'left', 'press'].map((direction, i) => ({
    device, key: 'button' + (16 + i), group: 'c1', direction, kind: 'button', label: 'C1 thumb hat · ' + direction,
  }));
}
const controlsByDevice = {
  left: thumb('left'),
  right: [...thumb('right'), { device: 'right', key: 'button1', group: 'trigger', kind: 'button', label: 'Trigger · first stage' }],
  sem: [{ device: 'sem', key: 'button57', group: 'c1', kind: 'button', label: 'C1 · front button' }],
};

const bindings = [
  { label: 'Spectator next', context: 'spectator', contextLabel: 'Spectator' },
  { action: 'flashui_kp_7', label: 'Flashui kp 7', context: 'default', contextLabel: 'General' },
  { label: 'Interact', context: 'seat_general', contextLabel: 'Seats' },
  { label: 'Fire guns', context: 'spaceship_weapons', contextLabel: 'Weapons', gesture: 'Double tap' },
  { label: 'Interact', context: 'spaceship_general', contextLabel: 'Flight' },
].map(row => ({ ...row, input: 'button16', device: 'right', slot: 1 }));
const sheet = buildSheet({ bindings }, controlsByDevice, { placement: 'right' });
const up = sheet.find(control => control.id === 'right:button16');
const editedIds = new Set([up.id, 'sem:button57']);

test('Flying promotes cockpit actions, preserves gestures and keeps all original contexts available', () => {
  assert.deepEqual(actionNames(up, 'flying'), ['Fire guns · Double tap', 'Interact', 'Spectator next', 'Flashui kp 7']);
  assert.deepEqual(orderedActions(up, 'all'), bindings);
  assert.deepEqual(orderedActions(up, 'flying').map(row => row.context), ['spaceship_weapons', 'spaceship_general', 'seat_general', 'spectator', 'default']);
  const items = rigLabels(sheet, 'all', up.id, { reference: true, context: 'flying', editedIds });
  const thumb = items.find(item => item.device === 'right' && item.group === 'c1');
  assert.equal(thumb.deviceTitle, 'Right');
  assert.equal(thumb.groupEntries.length, 5);
  assert.equal(thumb.groupEntries[1].text, 'Unassigned');
  assert.deepEqual(thumb.actions.map(row => row.context), ['Weapons', 'Flight', 'Seats', 'Spectator', 'General']);
  assert.deepEqual(new Set(items.filter(item => item.group === 'c1').map(item => item.device)), new Set(['left', 'right', 'sem']));
  assert.deepEqual(items.flatMap(item => item.groupEntries).filter(entry => entry.edited).length, 2);
  assert.ok(items.every(item => item.reference && !item.dimmed));
  for (const placement of ['left', 'right']) {
    const overview = rigLabels(sheet, 'all', up.id, { reference: true, placement });
    assert.ok(overview.every(item => item.referenceSide === (item.device === 'sem' ? placement : item.device)));
    assert.deepEqual([...new Set(overview.filter(item => item.referenceSide === placement).map(item => item.device))], [placement, 'sem']);
  }
});

test('Edited follows each changed direction, including clears, while another direction is selected', () => {
  const selected = 'right:button17';
  const items = rigLabels(sheet, 'right', selected, { editing: true, editedIds });
  const thumb = items.find(item => item.group === 'c1');
  assert.equal(thumb.key, 'button17');
  assert.equal(thumb.edited, false);
  assert.deepEqual(thumb.groupEntries.filter(input => input.edited).map(input => input.key), ['button16']);
  assert.ok(items.every(item => item.dimmed === !item.active));
  const [sem] = rigLabels(sheet, 'all', 'sem:button57', { editedIds });
  assert.equal(sem.edited, true);
  assert.equal(sem.text, 'Unassigned');
});

test('unavailable controls remain outside the physical reference and edit view', () => {
  const off = buildSheet(null, controlsByDevice, { placement: 'off' });
  off.push({ id: 'right:button106', device: 'right', key: 'button106', group: 'unmapped', label: 'B106', rows: [] });
  assert.ok(rigLabels(off, 'all', null, { reference: true }).every(item => item.device !== 'sem' && item.group !== 'unmapped'));
  assert.deepEqual(rigLabels(off, 'all', null), []);
});

test('compact chips follow every bound group in scope and retain all hat directions, contexts and gestures', () => {
  const gear = {
    action: 'v_deploy_landing_system', label: 'Landing System (Deploy)', context: 'spaceship_general',
    contextLabel: 'Flight', gesture: 'Press',
  };
  const rows = [
    ...bindings,
    { ...gear, device: 'left', slot: 2, input: 'button17' },
    { ...gear, physicalDevice: 'sem', slot: 1, input: 'button57' },
  ];
  const populated = buildSheet({ bindings: rows }, controlsByDevice);
  const opts = { compact: true, context: 'flying', placement: 'left' };
  const items = rigLabels(populated, 'all', up.id, opts);
  assert.deepEqual(items.map(item => [item.device, item.group]), [
    ['left', 'c1'], ['right', 'c1'], ['sem', 'c1'],
  ]);
  assert.ok(items.every(item => item.compact && !item.reference));
  assert.equal(items[0].compactName, 'C1 thumb hat');
  assert.equal(items[0].hatSlots[1].compactName, 'Gear down');
  assert.equal(items[2].compactName, 'Gear down');
  assert.equal(items[2].hatSlots, undefined);
  const right = items[1];
  assert.equal(right.compactName, 'C1 thumb hat');
  assert.deepEqual(right.hatSlots.map(entry => entry.direction), ['up', 'right', 'down', 'left', 'press']);
  assert.equal(right.groupEntries.length, 5);
  const [primary, unused] = right.groupEntries;
  assert.equal(primary.label, 'Up · B16');
  assert.equal(primary.compactName, 'Fire guns');
  assert.equal(primary.active, true);
  assert.deepEqual(primary.actions.map(({ label, context, gesture }) => [label, context, gesture]), [
    ['Fire guns', 'Weapons', 'Double tap'], ['Interact', 'Flight', ''], ['Interact', 'Seats', ''],
    ['Spectator next', 'Spectator', ''], ['Flashui kp 7', 'General', ''],
  ]);
  assert.equal(unused.compactName, '');
  assert.equal(unused.text, 'Unassigned');
  assert.ok(rigLabels(populated, 'all', null, { ...opts, placement: 'off' }).every(item => item.device !== 'sem'));
  assert.deepEqual(rigLabels(populated, 'left', null, opts).map(item => item.device), ['left']);
  const [allContexts] = rigLabels(populated, 'right', null, { ...opts, context: 'all' });
  assert.equal(allContexts.compactName, 'C1 thumb hat');
  assert.equal(allContexts.hatSlots[0].compactName, 'Spectator next');
  const reference = rigLabels(populated, 'right', null, { ...opts, reference: true });
  assert.ok(reference.some(item => item.group === 'trigger'));
  assert.ok(reference.every(item => !item.compact && item.reference));
});

test('Quick view names the physical hat through selection and uses its actual input keys for close tiles', () => {
  const bindings = [
    ['button11', 'Lock under reticle'], ['button11', 'Look up'], ['button15', 'Pin selected target'],
    ['hat1_rightup', 'Look up-right'], ['rotx', 'Aim horizontal'],
  ].map(([input, label]) => ({ input, label, device: 'right', slot: 1 }));
  const sheet = buildSheet({ bindings }, factoryControls);
  for (const selected of [null, 'right:button12', 'right:button15']) {
    const items = rigLabels(sheet, 'right', selected, { compact: true, editedIds: new Set(['right:button15']) });
    const hat = items.find(item => item.group === 'a4');
    assert.equal(hat.compactName, 'A4 upper hat');
    assert.deepEqual(hat.hatSlots.map(slot => [slot.direction, slot.key, slot.compactName || slot.text]), [
      ['up', 'button11', 'Lock under reticle'], ['right', 'button12', 'Unassigned'],
      ['down', 'button13', 'Unassigned'], ['left', 'button14', 'Unassigned'], ['press', 'button15', 'Pin selected target'],
    ]);
    assert.equal(hat.hatSlots[0].actions.length, 2);
    assert.ok(hat.hatSlots[4].edited);
    const pov = items.find(item => item.group === 'pov');
    assert.equal(pov.compactName, 'A1 POV / ministick');
    assert.deepEqual(pov.hatSlots.map(entry => entry.direction),
      ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'horizontal']);
    assert.equal(pov.hatSlots.find(entry => entry.direction === 'up-right').compactName, 'Look up-right');
    assert.equal(pov.hatSlots.at(-1).key, 'rotx');
    assert.equal(pov.groupEntries.find(entry => entry.key === 'roty').text, 'Unassigned');
  }
});

test('compact chips follow staged moves and keep unknown action names readable', () => {
  const row = { context: 'custom', action: 'v_calibrate_aux_bay_2', gesture: 'Delayed press', device: 'right', slot: 1 };
  const before = buildSheet({ bindings: [{ ...row, input: 'button16' }] }, controlsByDevice);
  const after = buildSheet({ bindings: [{ ...row, input: 'button1', origin: 'draft' }] }, controlsByDevice);
  const editedIds = new Set(['right:button1', 'right:button16']);
  const options = { compact: true, editing: true, editedIds };
  const [old] = rigLabels(before, 'right', null, options);
  assert.equal(old.group, 'c1');
  const items = rigLabels(after, 'right', 'right:button1', options);
  assert.deepEqual(items.map(item => item.group), ['trigger']);
  const [target] = items;
  assert.ok(target.compact && target.active && target.edited);
  assert.equal(target.compactName, 'Calibrate aux bay 2');
  assert.equal(target.actions[0].action, row.action);
  assert.equal(target.actions[0].gesture, 'Delayed press');
  assert.equal(target.actions[0].contextId, row.context);
  assert.deepEqual(rigLabels(buildSheet(null, controlsByDevice), 'all', null, options), []);
});

test('moving an unassigned base wheel shows its group while other unassigned groups stay hidden', () => {
  const throttle = Object.fromEntries(['left', 'right'].map(device => [device, [
    ...controlsByDevice[device], { device, key: 'z', group: 'throttle', kind: 'axis', label: 'Base throttle · axis' },
  ]]));
  const blank = buildSheet(null, throttle);
  for (const hand of ['left', 'right']) {
    const [shown, ...others] = rigLabels(blank, 'all', hand + ':z', { compact: true });
    assert.deepEqual(others, []);
    assert.equal(shown.device, hand);
    assert.equal(shown.group, 'throttle');
    assert.equal(shown.compactName, 'Unassigned');
    assert.equal(shown.text, 'Unassigned');
    assert.equal(shown.active, true);
    assert.equal(shown.groupEntries[0].actions.length, 0);
  }
});
