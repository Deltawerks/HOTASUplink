import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSheet, physicalInput } from './bindings.mjs';
import { rigLabels } from './rig-labels.mjs';

const control = (device, key, group, detail = {}) => ({ device, key, group, label: group, kind: 'button', ...detail });
const inventory = {
  left: [control('left', 'button4', 'b1'), control('left', 'y', 'motion', { kind: 'axis' })],
  right: [control('right', 'button4', 'b1')],
  sem: [control('sem', 'button42', 'a2'), control('sem', 'button58', 'flaps'),
    control('sem', 'button59', 'flaps', { optionalPosition: true }), control('sem', 'button61', 'flaps'),
    control('sem', 'button62', 'gear'), control('sem', 'button64', 'gear')],
};
const profile = {
  devices: [{ device: 'right', slot: 1, product: 'VKBsim Gladiator EVO R' },
    { device: 'left', slot: 2, product: 'VKBsim Gladiator EVO OT L SEM' }],
  bindings: [
    { action: 'request_landing', input: 'button42', device: 'left', slot: 2, origin: 'profile', gesture: 'Tap' },
    { action: 'right_extra', input: 'button42', device: 'right', slot: 1, origin: 'profile' },
    { action: 'pitch', input: 'y', device: 'left', slot: 2, origin: 'default' },
    { action: 'old_center', input: 'button59', device: 'left', slot: 2 },
  ],
};
const hardware = [{ id: 'right-id', name: 'VKBsim Gladiator EVO R SEM' }, { id: 'left-id', name: 'VKBsim Gladiator EVO OT L' }];

test('side selection leaves the saved SEM route intact, while new input uses the reporting host', () => {
  for (const placement of ['left', 'right']) {
    const sheet = buildSheet(profile, inventory, { placement, flaps: '2' });
    assert.equal(sheet.find(c => c.id === 'sem:button42').rows[0], profile.bindings[0]);
    assert.equal(sheet.find(c => c.id === 'right:button42').rows[0], profile.bindings[1]);
    assert.equal(sheet.find(c => c.id === 'left:y').rows[0].origin, 'default');
    assert.equal(sheet.find(c => c.id === 'sem:button59').group, 'inactive');
    assert.equal(sheet.find(c => c.id === 'left:button4').rows.length, 0);
  }
  assert.deepEqual(physicalInput({ type: 'button', id: 'right-id', button: 42 }, hardware, inventory),
    { device: 'sem', key: 'button42', host: 'right', raw: 'button42' });
  assert.equal(physicalInput({ type: 'button', id: 'left-id', button: 42 }, hardware, inventory).device, 'left');
});

test('turning off the SEM retains unrelated stick inputs and leaves the original profile intact', () => {
  const sheet = buildSheet(profile, inventory, { placement: 'off' });
  assert.equal(sheet.some(c => c.device === 'sem'), false);
  assert.equal(sheet.find(c => c.id === 'right:button42').rows[0].action, 'right_extra');
  assert.equal(sheet.find(c => c.id === 'left:y').rows[0].action, 'pitch');
  assert.equal(profile.bindings.length, 4);
});

test('lever axis/four-position rows await evidence and retain saved detent assignments', () => {
  const sheet = buildSheet(profile, inventory, { placement: 'right', flaps: '4', gear: 'axis' });
  assert.equal(sheet.find(c => c.id === 'sem:flaps-position-3').needsCapture, true);
  assert.equal(sheet.find(c => c.id === 'sem:gear-axis').needsCapture, true);
  assert.equal(sheet.find(c => c.id === 'sem:button59').rows[0].action, 'old_center');
  assert.equal(sheet.some(c => c.id === 'sem:button62'), false);
  const blank = buildSheet(null, inventory, { placement: 'right' });
  assert.ok(blank.length > 0 && blank.every(c => c.rows.length === 0));
});

test('hat diagonals, axes, neutral and unknown inputs preserve their meaning', () => {
  const event = (type, details) => physicalInput({ id: 'right-id', type, ...details }, hardware, inventory);
  assert.equal(event('hat', { hat: 1, direction: 'NE' }).key, 'hat1_rightup');
  assert.equal(event('hat', { hat: 1, direction: 'W' }).key, 'hat1_left');
  assert.equal(event('hat', { hat: 1, direction: null }), null);
  assert.equal(event('axis', { axis: 'RZ', value: 0.45 }).key, 'rotz');
  assert.equal(event('axis', { axis: 'SLIDER2' }).device, 'right');
  assert.equal(event('button', { button: 114 }).key, 'button114');
  assert.equal(physicalInput({ id: 'other', type: 'button', button: 1 }, hardware, inventory).device, 'unknown');
});

test('overview shows only the selected input and includes each full action', () => {
  const trigger = { ...control('right', 'button1', 'trigger'), id: 'right:button1', rows: [
    { label: 'Spectator Camera Target (Next)' },
    { label: 'Weapon Presets - Fire Guns Group 1', gesture: 'Double tap' },
  ] };
  const input = { ...trigger, id: 'right:extra', group: 'unmapped' };
  assert.deepEqual(rigLabels([trigger], 'all', null), []);
  assert.deepEqual(rigLabels([input], 'all', input.id), []);
  const [label] = rigLabels([trigger], 'all', trigger.id);
  assert.equal(label.text, 'Spectator Camera Target (Next)\nWeapon Presets - Fire Guns Group 1 · Double tap');
});

test('focused diagram includes each configured direction and preserves unassigned controls', () => {
  const sheet = buildSheet(null, inventory, { placement: 'left', flaps: '4', gear: '2' });
  const labels = rigLabels(sheet, 'sem', 'sem:flaps-position-3');
  assert.ok(labels.every(item => item.device === 'sem'));
  assert.deepEqual(labels.map(item => item.group), ['a2', 'flaps', 'gear']);
  const lever = labels.find(item => item.active);
  assert.equal(lever.key, 'flaps-position-3');
  assert.equal(lever.groupEntries.length, 4);
  assert.equal(lever.groupEntries.find(entry => entry.active).text, 'Input number unverified');
  assert.equal(labels[0].text, 'Unassigned');
});
