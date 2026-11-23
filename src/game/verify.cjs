'use strict';

const { stickHand, isFalconPedals } = require('../rig/device-identity.mjs');

// A game slot is an ordinal. Only a nonempty product record unique in both files
// identifies a joystick across a reorder; a hand label or the same slot alone cannot.
function productIndex(profile) {
  const bySlot = new Map();
  const counts = new Map();
  const seenSlots = new Set();
  for (const { tag, attrs } of profile.children) {
    if (tag !== 'options' || attrs.type !== 'joystick') continue;
    const slot = Number(attrs.instance);
    if (!Number.isInteger(slot) || slot < 1) continue;
    const product = (attrs.Product || '').trim().replace(/\s+/g, ' ').toLowerCase();
    // A manually created pedal layout knows the model but may lack its Windows GUID.
    const falcon = isFalconPedals(product);
    const key = falcon ? 'virpil:r1-falcon' : product;
    counts.set(key, (counts.get(key) || 0) + 1);
    const hasGuid = /\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}/.test(key);
    if (seenSlots.has(slot)) bySlot.delete(slot);
    else if (hasGuid || falcon || stickHand(key) !== 'unknown') bySlot.set(slot, key);
    seenSlots.add(slot);
  }
  return { bySlot, counts };
}

function deviceKey(slot, own, other) {
  const key = own.bySlot.get(slot);
  return key && own.counts.get(key) === 1 && other.counts.get(key) === 1 ? key : null;
}

// Preserve chords that themselves contain explicit joystick-slot references.
function comparableValue(raw, own, other, identified) {
  let resolved = true;
  const value = String(raw).replace(/js(\d+)_/gi, (_, slot) => {
    if (!identified) return 'js*_';
    const identity = deviceKey(Number(slot), own, other);
    if (!identity) resolved = false;
    return 'js[' + identity + ']_';
  });
  return resolved ? value : null;
}

function signature(row, own, other, identified) {
  const host = identified ? deviceKey(row.slot, own, other) : '*';
  if (!host) return null;
  const input = comparableValue(row.input, own, other, identified);
  if (input === null) return null;
  const extra = [];
  for (const [key, raw] of Object.entries(row.inputAttributes || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const value = comparableValue(raw, own, other, identified);
    if (value === null) return null;
    extra.push([key, value]);
  }
  return JSON.stringify([host, input, row.activationMode, row.multiTap, extra]);
}

function groupsFor(rig, own, other) {
  const groups = new Map();
  for (const row of rig.bindings) {
    const key = JSON.stringify([row.context, row.action]);
    if (!groups.has(key)) groups.set(key, { label: row.label, context: row.context, action: row.action, raw: [], exact: [] });
    const group = groups.get(key);
    group.raw.push(signature(row, own, other, false));
    group.exact.push(signature(row, own, other, true));
  }
  return groups;
}

function intersection(left, right) {
  const available = new Map();
  for (const key of right) if (key !== null) available.set(key, (available.get(key) || 0) + 1);
  let matches = 0;
  for (const key of left) {
    if (available.get(key) > 0) {
      matches++;
      available.set(key, available.get(key) - 1);
    }
  }
  return matches;
}

function modifierState(profile, own, other, slots, bindings) {
  let resolved = true;
  const referenced = new Set();
  if (slots) {
    for (const row of bindings) {
      for (const value of [row.input, ...Object.values(row.inputAttributes || {})]) {
        for (const token of value.toLowerCase().split(/[^\w]+/)) referenced.add(token);
      }
    }
  }
  function normalize(node) {
    const attrs = Object.keys(node.attrs).sort().map(key => {
      const value = comparableValue(node.attrs[key], own, other, true);
      if (value === null) resolved = false;
      return [key, value];
    });
    return [node.tag, attrs, node.children.map(normalize)];
  }
  const declarations = profile.children.filter(n => n.tag === 'modifiers').map(n => {
    if (!slots) return n;
    const children = n.children.filter(row => {
      const input = row.attrs.input?.toLowerCase();
      if (!input) return true;
      const match = /^js(\d+)_/.exec(input);
      if (match && slots.has(Number(match[1]))) return true;
      const shared = /^(?:kb|mo|gp)\d+_(.+)/.exec(input)?.[1];
      return referenced.has(input) || (shared && referenced.has(shared));
    });
    return { ...n, children };
  }).filter(n => n.children.length || Object.keys(n.attrs).length);
  const shape = JSON.stringify(declarations.map(normalize));
  return resolved ? shape : null;
}

function compareJoysticks(expected, active, expectedProfile, activeProfile, selected) {
  const expectIds = productIndex(expectedProfile), activeIds = productIndex(activeProfile);
  // Portable layouts identify a logical hand and family without inventing a
  // hardware ID. Scoped Apply resolves these to the recipient's actual sticks.
  // Use that same verified route when the active product record is unique.
  for (const [savedSlot, activeSlot] of selected?.routes || []) {
    const saved = expected.devices.get(savedSlot);
    const key = activeIds.bySlot.get(activeSlot);
    if (saved && !saved.product && key && activeIds.counts.get(key) === 1) {
      expectIds.bySlot.set(savedSlot, key);
      expectIds.counts.set(key, (expectIds.counts.get(key) || 0) + 1);
    }
  }
  const left = groupsFor(expected, expectIds, activeIds), right = groupsFor(active, activeIds, expectIds);
  let matchedCount = 0, differenceCount = 0, uncertain = false;
  const differences = [];
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(id), b = right.get(id);
    const rawA = a?.raw || [], rawB = b?.raw || [];
    const exactA = a?.exact || [], exactB = b?.exact || [];
    const same = intersection(exactA, exactB);
    matchedCount += same;
    if (same === exactA.length && same === exactB.length) continue;
    const abstract = intersection(rawA, rawB);
    if (rawA.length === rawB.length && abstract === rawA.length && (exactA.includes(null) || exactB.includes(null))) {
      uncertain = true;
      continue;
    }
    differenceCount++;
    if (differences.length < 8) {
      const { label, action, context } = a || b;
      differences.push({ label, action, context });
    }
  }
  const result = { exportedCount: expected.bindings.length, activeCount: active.bindings.length, matchedCount, differenceCount, differences };
  if (differenceCount) {
    const description = differenceCount === 1 ? 'One action has a different joystick assignment' :
      differenceCount + ' actions have different joystick assignments';
    return { ...result, status: 'different', message: description + ' in the active profile on disk.' };
  }
  if (uncertain) return { ...result, status: 'inconclusive', message: 'The two files do not identify every assigned joystick uniquely. A physical device match is still unconfirmed.' };
  const exportModifiers = modifierState(expectedProfile, expectIds, activeIds, selected?.saved, expected.bindings);
  const activeModifiers = modifierState(activeProfile, activeIds, expectIds, selected?.active, active.bindings);
  if (exportModifiers === null || activeModifiers === null || exportModifiers !== activeModifiers) {
    return { ...result, status: 'inconclusive', message: 'The joystick inputs agree. The modifier definitions could not be matched.' };
  }
  return { ...result, status: 'match', message: expected.bindings.length ?
    'All ' + expected.bindings.length + ' joystick assignments match the active profile on disk.' :
    'Both files resolve to zero joystick assignments.' };
}

module.exports = { compareJoysticks };
