const hands = new Set(['left', 'right']);
const validSlot = value => Number.isInteger(value) && value >= 1 && value <= 8;

export function actionKey({ context, action }) {
  return encodeURIComponent(context) + '/' + encodeURIComponent(action);
}

function controllerHand(name) {
  if (!/VKB/i.test(name || '')) return null;
  if (/\b(?:L|LH|left)\b/i.test(name)) return 'left';
  if (/\b(?:R|RH|right)\b/i.test(name)) return 'right';
  return null;
}

function controlInput(raw) {
  const name = String(raw || '').trim().toLowerCase();
  const axes = { rx: 'rotx', ry: 'roty', rz: 'rotz' };
  const value = Object.hasOwn(axes, name) ? axes[name] : name;
  return /^(?:[xyz]|rot[xyz]|slider[1-9]\d*|button[1-9]\d{0,2}|hat[1-9]\d*_(?:up|rightup|right|rightdown|down|leftdown|left|leftup))$/.test(value) ? value : null;
}

function slotOptions(profile) {
  return Array.from({ length: 8 }, (_, i) => {
    const slot = i + 1;
    const saved = profile?.devices?.find(d => d.slot === slot);
    const hint = saved?.product || (hands.has(saved?.device) ? saved.device + ' stick' : '');
    return { slot, label: 'Joystick ' + slot + (hint ? ' · ' + hint : '') };
  });
}

/** Resolve a physical control against *game* slots. Windows enumeration order
 * and the SEM's visual mounting position are never game slot identifiers. */
export function resolveTarget({ control, profile, hardware = [], slots = {}, capture = null }) {
  const device = control?.device;
  const result = { ok: false, host: device, physicalDevice: device, physicalKey: control?.key,
    input: null, slot: null, reason: '', needsSlot: false, needsCapture: false,
    slotOptions: slotOptions(profile), deviceRecord: null };
  const fail = (reason, extra = {}) => ({ ...result, reason, ...extra });
  if (!hands.has(device) && device !== 'sem') return fail('Choose a control on the left stick, right stick, or SEM.');
  if (control.group === 'inactive' || control.group === 'unmapped') return fail('Choose a configured physical control on the model.');
  const armed = capture?.controlId === (control.id || device + ':' + control.key) ? capture : null;
  let input = controlInput(armed ? armed.raw : control.key);
  if (armed && (!input || (control.needsCapture && (control.kind === 'axis') !== !/^(?:hat|button)/.test(input)))) {
    return fail(control.kind === 'axis' ? 'Move this axis to capture its reported input.' : 'Press this control to capture its reported button.', { needsCapture: true });
  }
  result.input = input;
  const saved = profile?.devices || [];
  const currentSem = hardware.filter(d => controllerHand(d.name) && /\bSEM\b/i.test(d.name));
  const priorSem = saved.filter(d => hands.has(d.device) && /\bSEM\b/i.test(d.product));
  let host = device;
  let reported = null;
  if (device === 'sem') {
    if (armed && (!hands.has(armed.host) || (currentSem.length && !currentSem.some(d => controllerHand(d.name) === armed.host)))) {
      return fail('The captured input does not match a connected SEM host. Capture this control again.', { needsCapture: true });
    }
    if (armed) host = armed.host;
    else if (currentSem.length === 1) host = controllerHand(currentSem[0].name);
    // An offline saved SEM location may predate a move. Only use the old
    // slot after a deliberate choice when there is no current reporting host.
    if (hands.has(host)) reported = currentSem.find(d => controllerHand(d.name) === host);
  } else {
    if (armed && (armed.host !== host || input !== controlInput(control.key))) {
      return fail('The captured input differs from this stick control. Select its reported control or capture again.', { needsCapture: true });
    }
    const matching = hardware.filter(d => controllerHand(d.name) === host);
    if (matching.length === 1) reported = matching[0];
  }
  result.host = host;
  const chosen = slots[host];
  const hasChoice = chosen !== undefined && chosen !== null && chosen !== '';
  const candidates = hands.has(host) ? saved.filter(d => d.device === host && validSlot(d.slot)) : [];
  const slot = hasChoice ? Number(chosen) : candidates.length === 1 ? candidates[0].slot : null;
  if (!validSlot(slot)) {
    if (hasChoice) return fail('Choose a supported game joystick slot from 1 through 8.', { needsSlot: true });
    const reason = host === 'sem'
      ? 'The SEM host is unconfirmed. Choose its game joystick slot or capture a control on the module.'
      : 'Choose the game joystick slot for the ' + host + ' stick. ' + (candidates.length > 1 ? 'Multiple saved slots match.' : 'The layout has no unique slot for this stick.');
    return fail(reason, { needsSlot: true, needsCapture: Boolean(control.needsCapture || host === 'sem') });
  }
  result.slot = slot;
  if (hands.has(host) && Number(slots[host === 'left' ? 'right' : 'left']) === slot) {
    return fail('The two sticks need different game joystick slots.', { needsSlot: true });
  }
  const recorded = saved.find(d => d.slot === slot);
  if (host === 'sem') {
    const confirmedHands = [...hands].filter(hand => Number(slots[hand]) === slot);
    if (confirmedHands.length === 1) host = confirmedHands[0];
    else if (hands.has(recorded?.device)) host = recorded.device;
  }
  result.host = host;
  const savedHost = hands.has(recorded?.device) ? recorded.device : controllerHand(recorded?.product);
  if (hands.has(host) && savedHost && savedHost !== host) {
    return fail('Joystick ' + slot + ' belongs to the ' + savedHost + ' stick in this layout. Choose the game slot for the ' + host + ' stick.', { needsSlot: true });
  }
  if (device === 'sem' && !armed) {
    const identified = new Set((profile?.bindings || []).filter(row => row.slot === slot && row.physicalDevice === 'sem' &&
      (row.physicalKey || row.input) === control.key).map(row => controlInput(row.input)).filter(Boolean));
    if (identified.size > 1) return fail('This control has different recorded inputs in this slot. Capture it again.', { needsCapture: true });
    if (identified.size === 1) input = [...identified][0];
  }
  if (!input) return fail('Capture this control to identify the input Windows reports.', { needsCapture: true });
  const evidence = [];
  if (device === 'sem' && hands.has(host) && (currentSem.length || armed)) {
    evidence.push((armed ? 'Captured SEM input' : 'Windows reports the SEM') + ' on the ' + host + ' stick.');
    if (priorSem.length === 1 && priorSem[0].device !== host) evidence.push('The saved SEM was on the ' + priorSem[0].device + ' stick.');
  }
  evidence.push((hasChoice ? 'Selected' : 'Saved') + ' game slot · js' + slot + '_' + input + '.');
  const product = reported?.name || (recorded?.device === host ? recorded?.product : '') || '';
  return { ...result, ok: true, host, slot, input, reason: evidence.join(' '),
    deviceRecord: hands.has(host) ? { slot, device: host, product } : null };
}

const taps = row => Number(row?.multiTap) || 1;
const activation = row => String(row?.activationMode || '');

function identity(row) {
  return { slot: row.slot, input: row.input, multiTap: taps(row), activationMode: activation(row) };
}

function matchesPrevious(row, previous) {
  return row.slot === previous.slot && row.input === previous.input &&
    (previous.multiTap == null || taps(row) === Number(previous.multiTap)) &&
    (previous.activationMode == null || activation(row) === previous.activationMode);
}

function gestureName(multiTap, mode) {
  if (multiTap > 1) return multiTap === 2 ? 'Double tap' : multiTap + ' taps';
  return mode.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase());
}

function sameGesture(a, b) {
  const mode = r => {
    const s = activation(r).toLowerCase().replace(/[_ -]/g, '');
    return ['', 'press', 'onpress'].includes(s) ? 'press' : s;
  };
  return taps(a) === taps(b) && mode(a) === mode(b);
}

function removal(row) {
  return { context: row.context, action: row.action, slot: row.slot, input: null, previous: identity(row) };
}

/** Preview against the current effective profile, including prior staged operations. */
export function previewEdit({ profile, action, target, previous = null, mode = 'replace', gesture = {}, conflictPolicy }) {
  const bindings = profile?.bindings || [];
  const before = action ? bindings.filter(r => r.context === action.context && r.action === action.action) : [];
  const preview = { ok: false, before, after: before, conflicts: [], otherContexts: [], shared: [],
    needsPrevious: false, needsConflictChoice: false, edit: null, edits: [], reason: '' };
  const fail = (reason, flags) => ({ ...preview, reason, ...flags });
  if (!action?.context || !action?.action) return fail('Select a game action.');
  if (!['replace', 'add', 'remove'].includes(mode)) return fail('Choose how to edit this action.');
  if (mode !== 'remove' && (!target?.ok || !validSlot(target.slot) || !controlInput(target.input))) {
    return fail(target?.reason || 'Choose a joystick control and game slot.');
  }
  if (mode === 'add' && previous) return fail('Adding an alternate input does not replace an existing row.');
  let old = null;
  if (previous) {
    if ((previous.context && previous.context !== action.context) || (previous.action && previous.action !== action.action)) return fail('The chosen binding belongs to a different game action.');
    const matches = before.filter(row => matchesPrevious(row, previous));
    if (matches.length !== 1) return fail('The chosen binding is missing or cannot be distinguished from another row.', { needsPrevious: true });
    old = matches[0];
  } else if (mode !== 'add') {
    if (before.length > 1) return fail('Select the existing joystick binding to change, or add an alternate input.', { needsPrevious: true });
    old = before[0] || null;
  }
  if (old && !validSlot(old.slot)) return fail('This existing assignment uses an unsupported game joystick slot.');
  if (mode === 'remove') {
    if (!old) return fail('This action has no joystick binding to remove.');
    const edit = removal(old);
    return { ...preview, ok: true, after: before.filter(row => row !== old), edit, edits: [edit] };
  }
  const multiTap = gesture?.multiTap == null ? (Number(old?.multiTap ?? action.multiTap) || 1) : Number(gesture.multiTap);
  const requestedMode = gesture?.activationMode;
  const activationMode = requestedMode === undefined ? (old?.activationMode || action.activationMode || '') : (requestedMode || action.activationMode || '');
  if (!Number.isInteger(multiTap) || multiTap < 1 || (gesture?.multiTap != null && multiTap > 4) ||
      (requestedMode !== undefined && (typeof requestedMode !== 'string' || !/^\w{0,64}$/.test(requestedMode)))) return fail('The activation gesture is invalid.');
  const row = { ...(old || {}), action: action.action, context: action.context, label: action.label || old?.label || action.action,
    contextLabel: action.contextLabel || old?.contextLabel || action.context, device: hands.has(target.host) ? target.host : 'unknown',
    slot: target.slot, input: target.input, multiTap, activationMode, gesture: gestureName(multiTap, activationMode), origin: 'draft' };
  delete row.physicalDevice;
  delete row.physicalKey;
  const physical = {};
  if (target.physicalDevice === 'sem') {
    physical.physicalDevice = 'sem';
    if (target.physicalKey && target.physicalKey !== target.input) physical.physicalKey = target.physicalKey;
  }
  Object.assign(row, physical);
  if (before.some(sibling => sibling !== old && matchesPrevious(sibling, identity(row)))) return fail('This action already has that joystick binding.');
  const occupied = bindings.filter(r => r.slot === row.slot && r.input === row.input && actionKey(r) !== actionKey(row));
  preview.conflicts = occupied.filter(r => r.context === row.context && sameGesture(r, row));
  preview.shared = occupied.filter(r => r.context === row.context && !sameGesture(r, row));
  preview.otherContexts = occupied.filter(r => r.context !== row.context);
  preview.after = old ? before.map(r => r === old ? row : r) : [...before, row];
  if (preview.conflicts.length && !['keep', 'replace'].includes(conflictPolicy)) {
    return fail('This input already has an action in this context. Keep both or replace the conflicting binding.', { needsConflictChoice: true });
  }
  const clears = conflictPolicy === 'replace' ? preview.conflicts.map(removal) : [];
  if (clears.some(clear => bindings.filter(r => actionKey(r) === actionKey(clear) && matchesPrevious(r, clear.previous)).length !== 1)) {
    return fail('A conflicting binding cannot be uniquely identified. Keep it or choose another input.');
  }
  const unchanged = old && matchesPrevious(old, identity(row)) &&
    (old.physicalDevice || null) === (row.physicalDevice || null) && (old.physicalKey || null) === (row.physicalKey || null);
  if (unchanged && !clears.length) return fail('This action is already assigned to that input and gesture.');
  const edit = { context: row.context, action: row.action, slot: row.slot, input: row.input, ...physical,
    ...(hands.has(target.host) ? { device: target.host } : {}),
    ...(old ? { previous: identity(old) } : mode === 'add' ? { mode: 'add' } : {}),
    ...(gesture?.multiTap != null ? { multiTap } : {}),
    ...(requestedMode !== undefined ? { activationMode: requestedMode } : {}),
    ui: { row, deviceRecord: target.deviceRecord } };
  return { ...preview, ok: true, after: unchanged ? before : preview.after, edit, edits: unchanged ? clears : [...clears, edit] };
}

export function stageEdit(edits, preview) {
  if (!preview?.ok) throw new Error(preview?.reason || 'The edit could not be staged.');
  return [...edits, ...preview.edits];
}

/** Strip display data before handing operations to the game XML writer. */
export function saveEdits(edits) {
  return edits.map(({ ui, ...operation }) => operation);
}

/** Only declare edited slots to the writer. It preserves the source options,
 * including unknown or out-of-range slots that are outside the user's change. */
export function draftDevices(profile, edits) {
  const devices = new Map();
  for (const edit of edits) {
    const record = edit.ui?.deviceRecord;
    if (!record) continue;
    const prior = profile?.devices?.find(d => d.slot === record.slot);
    devices.set(record.slot, { ...record, product: prior?.product || record.product || '' });
  }
  return [...devices.values()];
}

/** Replay only selected joystick rows; untouched rows retain exact input and gesture data. */
export function applyDraft(profile, edits) {
  if (!edits.length) return profile;
  const bindings = [...profile.bindings];
  for (const edit of edits) {
    const matches = edit.previous ? bindings.filter(r => actionKey(r) === actionKey(edit) && matchesPrevious(r, edit.previous)) : [];
    if (edit.previous && matches.length !== 1) throw new Error('The source binding changed. Reopen the action before applying this draft.');
    const index = matches.length ? bindings.indexOf(matches[0]) : -1;
    if (edit.input === null) {
      if (index >= 0) bindings.splice(index, 1);
    } else if (index >= 0) bindings[index] = edit.ui.row;
    else bindings.push(edit.ui.row);
  }
  const devices = new Map((profile.devices || []).map(d => [d.slot, d]));
  for (const record of draftDevices(profile, edits)) {
    if (!hands.has(devices.get(record.slot)?.device)) devices.set(record.slot, record);
  }
  return { ...profile, devices: [...devices.values()], bindings };
}
