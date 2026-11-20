// Rig keys describe the reference sheets. Profile slots and Windows device IDs
// are independent identifiers that can change when a module moves.
const hands = new Set(['left', 'right']);
const directionNames = {
  n: 'up', ne: 'rightup', e: 'right', se: 'rightdown',
  s: 'down', sw: 'leftdown', w: 'left', nw: 'leftup',
  up: 'up', rightup: 'rightup', upright: 'rightup', right: 'right',
  rightdown: 'rightdown', downright: 'rightdown', down: 'down',
  leftdown: 'leftdown', downleft: 'leftdown', left: 'left', leftup: 'leftup', upleft: 'leftup',
};
const axisNames = { rx: 'rotx', ry: 'roty', rz: 'rotz' };

export function isWheelAxis(key) {
  return key === 'z' || key === 'slider1' || key === 'slider2';
}

function canonical(raw) {
  const value = raw.toLowerCase().trim();
  const hat = /^hat(\d+)_(.+)$/.exec(value);
  if (hat) {
    const direction = directionNames[hat[2].replace(/[-_]/g, '')];
    if (direction) return 'hat' + hat[1] + '_' + direction;
  }
  return Object.hasOwn(axisNames, value) ? axisNames[value] : value;
}

function hasSem(product) {
  return /\bSEM\b/i.test(product || '');
}

export function liveHand(product) {
  if (!/VKB/i.test(product)) return 'unknown';
  if (/\b(l|lh|left)\b/i.test(product)) return 'left';
  if (/\b(r|rh|right)\b/i.test(product)) return 'right';
  return 'unknown';
}

function configuredSem(inventory, setup) {
  const controls = [...inventory];
  for (const group of ['flaps', 'gear']) {
    const start = controls.findIndex(control => control.group === group);
    if (start === -1) continue;
    const mode = setup[group];
    const lever = group === 'flaps' ? 'Flaps' : 'Landing gear';
    if (mode === 'axis') {
      controls.splice(start, 0, { device: 'sem', key: group + '-axis', label: lever + ' · analog travel', group, kind: 'axis', needsCapture: true });
    } else if (group === 'flaps' && mode === '4') {
      // The reference sheet identifies a center detent in the three-position setup.
      // Neither intermediate detent's reported button is established for four positions.
      const middle = [2, 3].map(number => ({ device: 'sem', key: 'flaps-position-' + number,
        label: 'Flaps · intermediate ' + (number - 1), group, kind: 'button', needsCapture: true }));
      controls.splice(start + 1, 0, ...middle);
    }
  }
  return controls;
}

function inactive(control, setup) {
  if (control.device !== 'sem' || (control.group !== 'flaps' && control.group !== 'gear')) return false;
  const mode = setup[control.group] || '2';
  if (mode === 'axis') return control.kind !== 'axis';
  return Boolean(control.optionalPosition && mode !== '3');
}

function rawLabel(key) {
  const button = /^button(\d+)$/.exec(key);
  return button ? 'Button ' + button[1] : key;
}

/** A full sheet in reference inventory order. Original binding objects retain
 * origin, gesture and action context. Empty controls have rows: []. Unrecognized
 * imports retain the recorded controller and slot. Visual placement never reroutes them. */
export function buildSheet(profile, controlsByDevice, setup = {}) {
  const semInventory = controlsByDevice.sem || [];
  const inventory = [...(controlsByDevice.left || []), ...(controlsByDevice.right || []), ...configuredSem(semInventory, setup)];
  const entries = new Map();
  const semKeys = new Set(semInventory.filter(control => /^button\d+$/.test(control.key)).map(control => control.key));
  const savedDevices = new Map((profile?.devices || []).map(device => [device.slot, device]));
  const semHosts = [...savedDevices.values()].filter(d => hands.has(d.device) && hasSem(d.product));
  const semHostSlot = semHosts.length === 1 ? semHosts[0].slot : null;
  const inactiveEntries = new Map();
  const unidentified = new Map();
  for (const control of inventory) {
    if (control.device === 'sem' && setup.placement === 'off') continue;
    const wheel = setup[control.device + 'Wheel'];
    const key = hands.has(control.device) && control.group === 'throttle' && isWheelAxis(wheel) ? wheel : control.key;
    const id = control.device + ':' + key;
    const entry = { ...control, key, id, rows: [] };
    if (inactive(control, setup)) inactiveEntries.set(id, { ...entry, group: 'inactive' });
    else entries.set(id, entry);
  }
  for (const row of profile?.bindings || []) {
    if (!row.input) continue;
    const key = canonical(row.input);
    const saved = savedDevices.get(row.slot);
    let device = saved?.device || row.device || 'unknown';
    if (row.physicalDevice === 'sem' || (semHostSlot !== null && row.slot === semHostSlot && semKeys.has(key))) {
      if (setup.placement === 'off') continue;
      device = 'sem';
    }
    const physicalKey = device === 'sem' && row.physicalKey ? row.physicalKey : key;
    const id = (device === 'unknown' ? 'js' + row.slot : device) + ':' + physicalKey;
    const known = entries.get(id) || inactiveEntries.get(id);
    if (known) { known.rows.push(row); continue; }
    if (!unidentified.has(id)) {
      unidentified.set(id, { id, device, key, label: rawLabel(key), group: 'unmapped', kind: 'raw', slot: row.slot, rows: [] });
    }
    unidentified.get(id).rows.push(row);
  }
  return [...entries.values(), ...[...inactiveEntries.values()].filter(entry => entry.rows.length), ...unidentified.values()];
}

/** Translate DirectInput events from the CURRENT host. The input monitor can
 * display the original event even for neutral hats and unknown object types. */
export function physicalInput(event, devices, controlsByDevice) {
  if (!event) return null;
  const source = devices?.find(d => d.id === event.id);
  const host = liveHand(source?.name || '');
  let raw;
  if (event.type === 'button' && Number.isInteger(event.button) && event.button > 0) {
    raw = 'button' + event.button;
  } else if (event.type === 'hat' && Number.isInteger(event.hat) && event.hat > 0 && event.direction) {
    const direction = directionNames[String(event.direction).toLowerCase()];
    if (!direction) return null;
    raw = 'hat' + event.hat + '_' + direction;
  } else if (event.type === 'axis' && event.axis) {
    raw = canonical(String(event.axis));
  } else {
    return null;
  }
  const sem = hands.has(host) && hasSem(source?.name) && controlsByDevice.sem?.some(control => control.key === raw);
  return { device: sem ? 'sem' : host, key: raw, host, raw };
}
