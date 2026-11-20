'use strict';

const { readXml, serializeXml } = require('./xml.cjs');
const { readSemHint, semSignature } = require('./export.cjs');

const element = (tag, attrs = {}) => ({ tag, attrs, children: [] });
const children = (node, tag) => node?.children.filter(child => child.tag === tag) || [];
const slotOf = input => Number(/^js(\d+)_/i.exec(input || '')?.[1]);
const occupied = node => /^js\d+_\s*\S/i.test(node.attrs.input || '');
const joystickRows = node => children(node, 'rebind').filter(row => slotOf(row.attrs.input));
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
        child.tag === 'joystick' || (child.tag !== 'rebind' && /^js\d+_/i.test(child.attrs.input || '')))) {
        throw new Error('Unsupported joystick binding format for ' + id + '.');
      }
      actions.set(id, { context, action, node });
    }
  }
  return { groups, actions };
}

function routesFor(source, active) {
  const routes = new Map(), targetSlots = new Set();
  for (const saved of source.values()) {
    if (!hand(saved.device)) continue;
    const candidates = [...active.values()].filter(actual => actual.device === saved.device);
    const exact = saved.product && candidates.filter(actual => productId(saved.product) === productId(actual.product));
    const matches = exact?.length ? exact : candidates;
    const sameHand = [...source.values()].filter(other => other.device === saved.device);
    if (matches.length !== 1 || (!exact?.length && sameHand.length !== 1) || targetSlots.has(matches[0].slot)) {
      throw new Error('Could not uniquely match the ' + saved.device + ' stick to the active game profile.');
    }
    routes.set(saved.slot, matches[0].slot);
    targetSlots.add(matches[0].slot);
  }
  if (!routes.size) throw new Error('The layout must identify at least one left or right VKB stick.');
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
  const hint = readSemHint(context, action, node);
  if (hint.physicalDevice) {
    const key = hint.physicalKey || '';
    result.provenanceComment = '<!-- HOTAS UPLINK SEM v1 ' + semSignature(context, action, attrs, key) + (key ? ' ' + key : '') + ' -->';
  }
  return result;
}

function defaultsFor(def) {
  return (def?.defaults || []).filter(attrs => attrs.input?.trim()).map(attrs => {
    const input = attrs.input.trim();
    return element('rebind', { ...attrs, input: /^js\d+_/i.test(input) ? input : 'js1_' + input });
  });
}

function shape(node) {
  return [node.tag, Object.keys(node.attrs).sort().map(key => [key, node.attrs[key]]), node.children.map(shape)];
}

function signatures(rows, context, action) {
  return JSON.stringify(rows.map(row => JSON.stringify([shape(row), readSemHint(context, action, row)])).sort());
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
function mergeJoystickBindings({ activeRoot, presetProfile, definitions, activeDevices, presetDevices }) {
  if (!definitions?.size) throw new Error('The installed action catalog is required to apply joystick bindings.');
  const root = readXml(Buffer.from(documentText(activeRoot)));
  const active = profileIn(root), preset = profileIn(presetProfile);
  const current = indexProfile(active), saved = indexProfile(preset);
  const { routes, targetSlots } = routesFor(presetDevices, activeDevices);
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
    const original = joystickRows(destination?.node), selected = joystickRows(source?.node);
    const defaults = defaultsFor(def);
    const previous = original.length ? original : defaults;
    const wanted = [];
    for (const row of selected.length ? selected : defaults) {
      if (!occupied(row)) continue;
      const slot = slotOf(row.attrs.input), device = presetDevices.get(slot);
      if (!routes.has(slot)) {
        if (selected.length && (!device?.product || /vkb/i.test(device.product))) {
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
      wanted.push(remapped);
    }
    const others = previous.filter(row => occupied(row) && !targetSlots.has(slotOf(row.attrs.input)));
    wanted.push(...others);
    const independent = [...children(destination?.node, 'rebind').filter(row => !slotOf(row.attrs.input)), ...others];
    for (const row of independent) collectInputs(row, independentInputs);
    const semanticallyWanted = signatures(wanted, context, action);
    expected.set(id, semanticallyWanted);
    const fallback = signatures(defaults.filter(occupied), context, action);
    // An explicit joystick row (even an empty one) masks all joystick defaults
    // for its action. Keep explicit intent on either side of a partial-device merge.
    const hasSourceOverride = selected.some(row => routes.has(slotOf(row.attrs.input)) || !occupied(row));
    const keepOtherOverride = original.some(row => !targetSlots.has(slotOf(row.attrs.input)));
    const useOverride = hasSourceOverride || keepOtherOverride || semanticallyWanted !== fallback;
    if (Boolean(original.length) === useOverride &&
        signatures(previous.filter(occupied), context, action) === semanticallyWanted) continue;
    const node = destination?.node || putAction(active, current, context, action);
    const replacements = useOverride ? wanted : [];
    if (useOverride && !wanted.length) replacements.push(element('rebind', { input: 'js' + [...targetSlots][0] + '_ ' }));
    const keep = node.children.filter(row => !original.includes(row) || replacements.includes(row));
    node.children = keep.concat(replacements.filter(row => !keep.includes(row)));
  }
  mergeModifiers(active, preset, routes, targetSlots, route, independentInputs, appliedInputs);
  const text = documentText(root);
  const result = indexProfile(profileIn(readXml(Buffer.from(text))));
  for (const [id, intended] of expected) {
    const def = definitions.get(id), entry = result.actions.get(id);
    const rows = joystickRows(entry?.node);
    const { context, action } = def || entry || saved.actions.get(id);
    if (signatures((rows.length ? rows : defaultsFor(def)).filter(occupied), context, action) !== intended) {
      throw new Error('Could not verify the prepared joystick bindings for ' + id + '.');
    }
  }
  return text;
}

module.exports = { mergeJoystickBindings };
