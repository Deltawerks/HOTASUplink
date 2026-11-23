'use strict';

const { readXml, serializeXml } = require('./xml.cjs');
const { readSemHint, readPhysicalHint, physicalHintComment } = require('./export.cjs');
const { stickFamily } = require('../rig/device-identity.mjs');
const { isJoystickBinding, occupied, defaultJoystickRows, effectiveJoystickRows, canonicalJoystickRows } = require('./joystick-bindings.cjs');

const element = (tag, attrs = {}) => ({ tag, attrs, children: [] });
const children = (node, tag) => node?.children.filter(child => child.tag === tag) || [];
const slotOf = input => Number(/^js(\d+)_/i.exec(input || '')?.[1]);
const hand = device => device === 'left' || device === 'right';
const productId = product => product.trim().replace(/\s+/g, ' ').toLowerCase();

function profileIn(root) {
  if (!root || !['ActionMaps', 'ActionProfiles'].includes(root.tag)) throw new Error('Expected a game control profile.');
  const wrapped = children(root, 'ActionProfiles');
  if (wrapped.length > 1 || (wrapped.length && (root.tag !== 'ActionMaps' ||
      root.children.some(node => ['options', 'actionmap', 'modifiers'].includes(node.tag))))) {
    throw new Error('Multiple control profiles were found in one file.');
  }
  return wrapped[0] || root;
}

function documentText(root) {
  if (!root.xml) throw new Error('The active controls must be a text XML document.');
  const original = root.xml.text;
  const encoding = /^\uFEFF?<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(original)?.[1];
  if (encoding && !/^utf-?8$/i.test(encoding)) throw new Error('The active profile uses an unsupported XML encoding.');
  if (root.tag === 'ActionMaps') return serializeXml(root);
  return original.slice(0, root.xml.start) + serializeXml(root).slice(0, -1) + original.slice(root.xml.end);
}

function indexProfile(profile) {
  const groups = new Map(), actions = new Map(), slots = new Set();
  for (const opt of children(profile, 'options').filter(opt => opt.attrs.type === 'joystick')) {
    const slot = Number(opt.attrs.instance);
    if (!Number.isInteger(slot) || slot < 1 || slots.has(slot)) throw new Error('Ambiguous joystick slot declarations in the profile.');
    slots.add(slot);
  }
  for (const group of children(profile, 'actionmap')) {
    const context = group.attrs.name;
    if (!context || groups.has(context)) throw new Error('Missing or duplicate action map name.');
    groups.set(context, group);
    for (const node of children(group, 'action')) {
      const action = node.attrs.name, id = context + '/' + action;
      if (!action || actions.has(id)) throw new Error('Missing or duplicate action name in ' + context + '.');
      if (Object.hasOwn(node.attrs, 'joystick') || node.children.some(child =>
        child.tag === 'joystick' || (!isJoystickBinding(child) && /^js\d+_/i.test(child.attrs.input || '')))) {
        throw new Error('Unsupported joystick binding format for ' + id + '.');
      }
      actions.set(id, { context, action, node });
    }
  }
  return { groups, actions };
}

function routesFor(source, active, scope, presetProfile) {
  if (scope != null && (!['vkb', 'virpil'].includes(scope.family) || typeof scope.pedals !== 'boolean')) {
    throw new Error('Choose a supported controller setup before applying or checking a layout.');
  }
  // An export may declare the connected pedals without assigning them. Applying
  // a sticks-only preset must leave those active axes alone even when visible.
  const assignedSlots = new Set();
  if (scope?.pedals) {
    for (const group of children(presetProfile, 'actionmap')) {
      for (const action of children(group, 'action')) {
        for (const row of action.children.filter(isJoystickBinding)) assignedSlots.add(slotOf(row.attrs.input));
      }
    }
  }
  const routes = new Map(), targetSlots = new Set();
  for (const saved of source.values()) {
    const pedals = saved.device === 'pedals';
    const family = stickFamily(saved);
    if (pedals) {
      if (!scope?.pedals || !assignedSlots.has(saved.slot)) continue;
    } else if (!hand(saved.device) || (scope && family !== scope.family)) continue;
    const sameRole = entry => entry.device === saved.device && (pedals || stickFamily(entry) === family);
    const candidates = [...active.values()].filter(sameRole);
    const exact = saved.product && candidates.filter(actual => productId(saved.product) === productId(actual.product));
    const matches = exact?.length ? exact : (family || pedals) ? candidates : [];
    if (matches.length !== 1 || (!exact?.length && [...source.values()].filter(sameRole).length !== 1) || targetSlots.has(matches[0].slot)) {
      const name = pedals ? 'R1-FALCON pedals' : saved.device + ' stick';
      throw new Error('Could not uniquely match the ' + name + ' to the active game profile.');
    }
    routes.set(saved.slot, matches[0].slot);
    targetSlots.add(matches[0].slot);
  }
  if (!routes.size) throw new Error('The layout must identify a controller in the selected setup.');
  return { routes, targetSlots };
}

function remapRow(node, route, context, action) {
  const attrs = Object.fromEntries(Object.entries(node.attrs).map(([key, value]) =>
    [key, value.replace(/js(\d+)_/gi, (prefix, n) => {
      const slot = route(Number(n));
      return slot === Number(n) ? prefix : 'js' + slot + '_';
    })]));
  const nested = node.children.map(child => remapRow(child, route, context, action));
  if (nested.every((child, i) => child === node.children[i]) &&
      Object.keys(attrs).every(key => attrs[key] === node.attrs[key])) return node;
  const result = { ...node, attrs, children: nested };
  const hint = readPhysicalHint(context, action, node);
  if (hint.physicalDevice) result.provenanceComment = physicalHintComment(context, action, attrs, hint.physicalDevice, hint.physicalKey);
  return result;
}

function shape(node) {
  return [node.tag, Object.keys(node.attrs).sort().map(key => [key, node.attrs[key]]), node.children.map(shape)];
}

function signatures(rows, context, action) {
  return JSON.stringify(rows.map(row => JSON.stringify([shape(row), readPhysicalHint(context, action, row)])).sort());
}

function putAction(profile, index, context, action) {
  let group = index.groups.get(context);
  if (!group) {
    group = element('actionmap', { name: context });
    index.groups.set(context, group);
    profile.children.push(group);
  }
  const result = element('action', { name: action });
  group.children.push(result);
  return result;
}

function collectInputs(node, inputs) {
  for (const value of Object.values(node.attrs)) {
    for (const token of value.toLowerCase().split(/[^\w]+/)) {
      if (!token) continue;
      inputs.add(token);
      // SC permits a modifier without its device prefix, e.g. js1_lshift+button5.
      const suffix = /^(?:js|kb|mo|gp)\d+_(.+)/.exec(token)?.[1];
      if (suffix) inputs.add(suffix);
    }
  }
  for (const child of node.children) collectInputs(child, inputs);
}

// Modifier declarations affect an entire device. Keep shared declarations intact and
// reject conflicting ones rather than unexpectedly changing chords on other devices.
function mergeModifiers(active, preset, routes, targetSlots, route, independentInputs, appliedInputs) {
  const liveNodes = children(active, 'modifiers'), savedNodes = children(preset, 'modifiers');
  if (liveNodes.length > 1 || savedNodes.length > 1) throw new Error('Multiple modifier tables are unsupported.');
  const live = liveNodes[0], saved = savedNodes[0];
  if (Object.keys(saved?.attrs || {}).some(key => live?.attrs[key] !== saved.attrs[key])) {
    throw new Error('The layout uses different global modifier settings.');
  }
  const additions = [];
  for (const declaration of saved?.children || []) {
    const slot = slotOf(declaration.attrs.input);
    if (routes.has(slot)) additions.push(remapRow(declaration, route));
    else if (!slot) {
      const input = declaration.attrs.input?.toLowerCase();
      const localName = /^(?:kb|mo|gp)\d+_(.+)/.exec(input)?.[1];
      const needed = !input || appliedInputs.has(input) || appliedInputs.has(localName);
      if (needed && !live?.children.some(row => JSON.stringify(shape(row)) === JSON.stringify(shape(declaration)))) {
        throw new Error('The layout requires a shared modifier that is missing from the active profile.');
      }
    }
  }
  const current = (live?.children || []).filter(row => targetSlots.has(slotOf(row.attrs.input)));
  if (signatures(current) === signatures(additions)) return;
  for (const row of current) {
    if (!additions.some(newRow => JSON.stringify(shape(newRow)) === JSON.stringify(shape(row))) &&
        independentInputs.has(row.attrs.input.toLowerCase())) {
      throw new Error('Another device uses a joystick modifier that this layout would change.');
    }
  }
  const container = live || element('modifiers');
  if (!live) active.children.push(container);
  container.children = container.children.filter(row => !current.includes(row)).concat(additions);
}

/** Build a replacement active document in memory. Only represented sticks' key bindings
 * and joystick modifiers move. The active game's hardware identities, inversion, curves,
 * calibration, keyboard/mouse/gamepad bindings and other peripherals stay in that document. */
function mergeJoystickBindings({ activeRoot, presetProfile, definitions, activeDevices, presetDevices, scope }) {
  if (!definitions?.size) throw new Error('The installed action catalog is required to apply joystick bindings.');
  const root = readXml(Buffer.from(documentText(activeRoot)));
  const active = profileIn(root), preset = profileIn(presetProfile);
  const current = indexProfile(active), saved = indexProfile(preset);
  const { routes, targetSlots } = routesFor(presetDevices, activeDevices, scope, preset);
  function route(slot) {
    if (routes.has(slot)) return routes.get(slot);
    const source = presetDevices.get(slot);
    const matches = source?.product ? [...activeDevices.values()].filter(device =>
      productId(device.product) === productId(source.product)) : [];
    if (matches.length === 1 && !targetSlots.has(matches[0].slot)) return matches[0].slot;
    throw new Error('Could not identify joystick ' + slot + ' in a cross-device binding.');
  }

  const expected = new Map(), independentInputs = new Set(), appliedInputs = new Set();
  for (const id of new Set([...definitions.keys(), ...current.actions.keys(), ...saved.actions.keys()])) {
    const def = definitions.get(id), source = saved.actions.get(id), destination = current.actions.get(id);
    const { context, action } = def || source || destination;
    const original = destination?.node.children.filter(isJoystickBinding) || [];
    const selected = source?.node.children.filter(isJoystickBinding) || [];
    const defaults = defaultJoystickRows(def);
    const previous = effectiveJoystickRows(destination?.node, def);
    const remappedRows = [];
    for (const row of effectiveJoystickRows(source?.node, def)) {
      if (!occupied(row)) continue;
      const slot = slotOf(row.attrs.input), device = presetDevices.get(slot);
      if (!routes.has(slot)) {
        const family = stickFamily(device);
        if (selected.includes(row) && !hand(device?.device) && device?.device !== 'pedals' &&
            (!device?.product || (family && (!scope || family === scope.family)))) {
          throw new Error('The layout does not identify which stick owns joystick ' + slot + '.');
        }
        continue;
      }
      // An authored SEM hint records the user's chosen host. Older exports only
      // identify the factory extension buttons by the combined product record.
      const actual = activeDevices.get(routes.get(slot));
      if (/\bSEM\b/i.test(device.product) && !/\bSEM\b/i.test(actual.product) &&
          /_button(?:4[1-9]|5\d|6[0-4])$/i.test(row.attrs.input) && !readSemHint(context, action, row).physicalDevice) {
        throw new Error('The SEM host differs between these layouts. Confirm its assignments in the layout editor.');
      }
      const remapped = remapRow(row, route, context, action);
      collectInputs(remapped, appliedInputs);
      remappedRows.push(remapped);
    }
    const others = previous.filter(row => occupied(row) && !targetSlots.has(slotOf(row.attrs.input)));
    const independent = [...(destination?.node.children || []).filter(row =>
      ['rebind', 'addbind'].includes(row.tag) && !isJoystickBinding(row)), ...others];
    for (const row of independent) collectInputs(row, independentInputs);
    if (!remappedRows.length && !selected.some(row => routes.has(slotOf(row.attrs.input))) &&
        !previous.some(row => targetSlots.has(slotOf(row.attrs.input)))) {
      expected.set(id, signatures(previous.filter(occupied), context, action));
      continue;
    }
    // A partial-device apply keeps an unrelated joystick's primary binding first.
    const previousPrimary = previous.find(row => row.tag === 'rebind' && occupied(row));
    const wanted = canonicalJoystickRows(others.includes(previousPrimary) ? [...others, ...remappedRows] : [...remappedRows, ...others]);
    const semanticallyWanted = signatures(wanted, context, action);
    expected.set(id, semanticallyWanted);
    const fallback = signatures(defaults.filter(occupied), context, action);
    // Keep explicit intent on either side of a partial-device merge, including clears.
    const hasSourceOverride = selected.some(row => routes.has(slotOf(row.attrs.input)) || !occupied(row));
    const keepOtherOverride = original.some(row => !targetSlots.has(slotOf(row.attrs.input)));
    const useOverride = hasSourceOverride || keepOtherOverride || semanticallyWanted !== fallback;
    if (Boolean(original.length) === useOverride &&
        signatures(previous.filter(occupied), context, action) === semanticallyWanted) continue;
    const node = destination?.node || putAction(active, current, context, action);
    const replacements = useOverride ? wanted : [];
    if (useOverride && !wanted.length) replacements.push(element('rebind', { input: 'js' + [...targetSlots][0] + '_ ' }));
    node.children = node.children.filter(row => !isJoystickBinding(row)).concat(replacements);
  }
  mergeModifiers(active, preset, routes, targetSlots, route, independentInputs, appliedInputs);
  const text = documentText(root);
  const result = indexProfile(profileIn(readXml(Buffer.from(text))));
  for (const [id, intended] of expected) {
    const def = definitions.get(id), entry = result.actions.get(id);
    const rows = effectiveJoystickRows(entry?.node, def);
    const { context, action } = def || entry || saved.actions.get(id);
    if (signatures(rows.filter(occupied), context, action) !== intended) {
      throw new Error('Could not verify the prepared joystick bindings for ' + id + '.');
    }
  }
  return text;
}

module.exports = { mergeJoystickBindings, routesFor };
