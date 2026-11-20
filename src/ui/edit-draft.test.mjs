import test from 'node:test';
import assert from 'node:assert/strict';
import { actionKey, applyDraft, draftDevices, previewEdit, resolveTarget, saveEdits, stageEdit } from './edit-draft.mjs';
import { physicalInput } from './bindings.mjs';

const devices = [
  { device: 'right', slot: 1, product: 'VKBsim Gladiator EVO R' },
  { device: 'left', slot: 2, product: 'VKBsim Gladiator EVO OT L SEM' },
];
const hardware = [
  { id: 'B', name: 'VKBsim Gladiator EVO R SEM' },
  { id: 'A', name: 'VKBsim Gladiator EVO OT L' },
];
const action = { context: 'flight', action: 'landing', label: 'Landing system', contextLabel: 'Flight', activationMode: 'press' };
const profile = (bindings = [], assigned = devices) => ({ source: { kind: 'export' }, devices: assigned, bindings });
const binding = (input, attrs = {}) => ({ ...action, device: 'left', slot: 2, input, origin: 'profile', multiTap: 1, ...attrs });
const ctrl = (device, key, detail = {}) => ({ device, key, id: device + ':' + key, group: 'a2', kind: 'button', ...detail });
const target = (control, attributes = {}) => resolveTarget({ profile: profile(), hardware, control, ...attributes });

test('each base wheel keeps its own Z route and neither slider takes its assignment', () => {
  for (const [id, hand, slot] of [['A', 'left', 2], ['B', 'right', 1]]) {
    const wheel = ctrl(hand, 'z', { kind: 'axis', group: 'throttle' });
    const report = axis => physicalInput({ type: 'axis', id, axis, value: 0.6 }, hardware, { sem: [] });
    const observed = report('Z');
    assert.deepEqual([observed.device, observed.raw, observed.key], [hand, 'z', 'z']);
    const route = target(wheel, { capture: { ...observed, controlId: wheel.id } });
    const [edit] = saveEdits(stageEdit([], previewEdit({ profile: profile(), action, target: route })));
    assert.deepEqual([edit.device, edit.slot, edit.input], [hand, slot, 'z']);
    for (const channel of ['SLIDER1', 'SLIDER2']) {
      const slider = report(channel);
      assert.equal(slider.raw, channel.toLowerCase());
      assert.equal(target(wheel, { capture: { ...slider, controlId: wheel.id } }).ok, false);
    }
  }
});

test('current right-hand SEM routes to the saved right game slot, independent of USB and export order', () => {
  const button = ctrl('sem', 'button42');
  const route = target(button, { hardware: [...hardware].reverse() });
  assert.deepEqual([route.ok, route.slot, route.host, route.input], [true, 1, 'right', 'button42']);
  assert.match(route.reason, /saved SEM was on the left/i);
  const swapped = profile([], devices.map(d => ({ ...d, slot: 3 - d.slot })));
  assert.equal(target(button, { profile: swapped }).slot, 2);
  const offline = target(button, { hardware: [] });
  assert.ok(offline.needsSlot);
  assert.equal(offline.host, 'sem');
  assert.equal(target(button, { hardware: [], slots: { sem: 2 } }).host, 'left');
});

test('blank and ambiguous layouts offer explicit slots without inferring Windows enumeration order', () => {
  const left = ctrl('left', 'button3');
  const blank = profile([], []);
  const unknown = target(left, { profile: blank });
  assert.ok(unknown.needsSlot);
  assert.deepEqual(unknown.slotOptions.map(o => o.slot), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(target(left, { profile: profile([], [...devices, { ...devices[1], slot: 5 }]) }).needsSlot);
  assert.equal(target(left, { profile: blank, slots: { left: 2, right: 2 } }).ok, false);
  const manual = target(left, { profile: blank, hardware: [], slots: { left: 2 } });
  assert.deepEqual(manual.deviceRecord, { slot: 2, device: 'left', product: '' });
  const edits = stageEdit([], previewEdit({ profile: blank, action, target: manual }));
  assert.deepEqual(draftDevices(blank, edits), [manual.deviceRecord]);
  assert.equal(applyDraft(blank, edits).bindings[0].slot, 2);
  assert.deepEqual(blank.bindings, []);
});

test('slot validation agrees with the exporter and keeps unrelated unknown devices out of its declarations', () => {
  const input = ctrl('right', 'button3');
  const opaque = { slot: 4, device: 'unknown', product: 'Other controller' };
  const outside = { slot: 10, device: 'unknown', product: '' };
  const base = profile([], [...devices, opaque, outside]);
  for (const bad of [0, -1, 1.5, 9, 'invalid']) {
    assert.equal(target(input, { profile: base, slots: { right: bad } }).ok, false);
  }
  const wrong = target(input, { profile: base, slots: { right: 2 } });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.needsSlot, true);
  assert.match(wrong.reason, /belongs to the left stick/);
  assert.equal(target(ctrl('sem', 'button42'), { profile: base, slots: { right: 2 } }).ok, false);
  const staged = stageEdit([], previewEdit({ profile: base, action, target: target(input) }));
  assert.deepEqual(draftDevices(base, staged), [devices[0]]);
  assert.deepEqual(applyDraft(base, staged).devices, base.devices);
});

test('previous uses both tap count and activation mode for coincident action alternatives', () => {
  const press = binding('button1');
  const hold = { ...press, activationMode: 'hold' };
  const double = { ...press, multiTap: 2 };
  const base = profile([press, hold, double]);
  const to = target(ctrl('right', 'button3'));
  const ambiguous = { slot: 2, input: 'button1' };
  assert.equal(previewEdit({ profile: base, action, target: to, previous: ambiguous }).ok, false);
  for (const selected of base.bindings) {
    const p = previewEdit({ profile: base, action, target: to, previous: selected });
    assert.ok(p.ok);
    assert.deepEqual(p.edit.previous, { ...ambiguous, multiTap: selected.multiTap, activationMode: selected.activationMode });
    const working = applyDraft(base, stageEdit([], p));
    for (const other of base.bindings.filter(row => row !== selected)) assert.ok(working.bindings.includes(other));
  }
});

test('a synthetic SEM lever uses an intentional capture or its exact saved physical key on the current slot', () => {
  const lever = ctrl('sem', 'flaps-axis', { group: 'flaps', kind: 'axis', needsCapture: true });
  const capture = { host: 'right', device: 'sem', raw: 'slider1', controlId: lever.id };
  assert.ok(target(lever).needsCapture);
  assert.ok(target(lever, { capture: { ...capture, controlId: 'sem:gear-axis' } }).needsCapture);
  assert.ok(target(lever, { capture: { ...capture, host: 'left' } }).needsCapture);
  assert.ok(target(lever, { capture: { ...capture, raw: 'button42' } }).needsCapture);
  const route = target(lever, { capture });
  assert.equal(route.input, 'slider1');
  const edits = stageEdit([], previewEdit({ profile: profile(), action, target: route }));
  assert.deepEqual(saveEdits(edits), [{ context: 'flight', action: 'landing', slot: 1, input: 'slider1',
    device: 'right', physicalDevice: 'sem', physicalKey: 'flaps-axis' }]);
  const after = applyDraft(profile(), edits);
  assert.equal(after.bindings[0].physicalKey, 'flaps-axis');
  assert.equal(target(lever, { profile: after }).input, 'slider1');
  assert.ok(target(lever, { profile: profile(after.bindings.map(b => ({ ...b, slot: 2 }))) }).needsCapture);
  assert.ok(target(lever, { profile: profile([...after.bindings, { ...after.bindings[0], input: 'rotz' }]) }).needsCapture);
});

test('an action with multiple alternatives requires a choice and preserves gestures and sibling inputs', () => {
  const old = binding('button4', { multiTap: 2, gesture: 'Double tap' });
  const other = binding('rctrl+button7');
  const source = profile([old, other]);
  const to = target(ctrl('sem', 'button42'));
  assert.equal(previewEdit({ profile: source, action, target: to }).needsPrevious, true);
  const preview = previewEdit({ profile: source, action, target: to, previous: old });
  assert.ok(preview.ok);
  assert.equal(preview.after[0].gesture, 'Double tap');
  const edits = stageEdit([], preview);
  const working = applyDraft(source, edits);
  assert.equal(working.bindings[1], other);
  assert.deepEqual(working.devices, devices);
  assert.equal(working.bindings[0].physicalDevice, 'sem');
  assert.equal(working.bindings[0].device, 'right');
  assert.equal(source.bindings[0], old);
  assert.equal(saveEdits(edits)[0].previous.multiTap, 2);
  assert.equal(saveEdits(edits)[0].multiTap, undefined);
  const added = previewEdit({ profile: source, action, target: to, mode: 'add' });
  assert.deepEqual(added.after.slice(0, 2), [old, other]);
  assert.equal(saveEdits(stageEdit([], added))[0].mode, 'add');
  const duplicated = profile([old, { ...old }]);
  assert.equal(previewEdit({ profile: duplicated, action, target: to, previous: old }).ok, false);
});

test('conflict replacement clears just the matching alternative; distinct gestures and contexts survive', () => {
  const old = binding('button27', { origin: 'default' });
  const collision = binding('button3', { slot: 1, device: 'right', action: 'modes', label: 'Cycle mode' });
  const itsAlternate = { ...collision, input: 'button7' };
  const held = { ...collision, action: 'menu', label: 'Open menu', activationMode: 'hold' };
  const double = { ...collision, multiTap: 2 };
  const distant = { ...collision, context: 'mining' };
  const source = profile([old, collision, itsAlternate, held, double, distant]);
  const to = target(ctrl('right', 'button3'));
  const inspect = policy => previewEdit({ profile: source, action, target: to, conflictPolicy: policy });
  assert.ok(inspect().needsConflictChoice);
  assert.deepEqual(inspect().conflicts, [collision]);
  assert.deepEqual(inspect().shared, [held, double]);
  assert.deepEqual(inspect().otherContexts, [distant]);
  assert.equal(inspect('keep').edits.length, 1);
  const staged = stageEdit([], inspect('replace'));
  assert.equal(staged.length, 2);
  assert.equal(staged[0].input, null);
  assert.ok(!Object.hasOwn(saveEdits(staged)[1], 'ui'));
  const next = applyDraft(source, staged);
  assert.ok(!next.bindings.includes(collision));
  for (const survivor of [itsAlternate, held, double, distant]) assert.ok(next.bindings.includes(survivor));
  assert.equal(source.bindings.length, 6);
});

test('staged edits target the effective row, can clear the final alternative, and leave homonymous actions alone', () => {
  const first = binding('button1');
  const homonym = { ...first, context: 'turret' };
  const base = profile([first, homonym]);
  const edits = stageEdit([], previewEdit({ profile: base, action, target: target(ctrl('sem', 'button52')) }));
  const working = applyDraft(base, edits);
  const again = stageEdit(edits, previewEdit({ profile: working, action, target: target(ctrl('right', 'button2')), gesture: { multiTap: 2 } }));
  const continued = applyDraft(base, again);
  assert.equal(continued.bindings[0].physicalDevice, undefined);
  assert.equal(continued.bindings[0].gesture, 'Double tap');
  assert.equal(continued.bindings[1], homonym);
  const cleared = stageEdit(again, previewEdit({ profile: continued, action, mode: 'remove' }));
  assert.deepEqual(applyDraft(base, cleared).bindings, [homonym]);
  assert.throws(() => applyDraft(profile([homonym]), cleared), /source binding changed/i);
  assert.notEqual(actionKey(action), actionKey(homonym));
});
