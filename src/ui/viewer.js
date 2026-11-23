import { createRig } from '../rig/index.js';
import { defaultRig, rigForId, rigProfiles } from '../rig/profiles.mjs';
import { stickFamily } from '../rig/device-identity.mjs';
import { buildSheet, isPedalToeAxis, isWheelAxis, liveHand, physicalInput } from './bindings.mjs';
import { actionNames, canLocate, orderedActions, rigLabels } from './rig-labels.mjs';
import { createMonitor } from './monitor.js';
import { addIcons } from './icons.js';
import { createEditSession } from './edit-session.mjs';
import { createGameHandoff } from './game-handoff.mjs';
import { createNextLaunch } from './next-launch.mjs';
import { createUpdateControls } from './app-updates.mjs';

const $ = (id) => document.getElementById(id);
const pages = { rig: 'Controls', sheet: 'Binding sheet', monitor: 'Input monitor' };
const searchAliases = { v_atc_request: 'ATC ask to land landing clearance contact tower' };
const blank = () => ({
  source: { kind: 'blank', name: 'Blank layout' },
  devices: [],
  bindings: [],
  diagnostics: [],
});
const textSizeRange = { min: 80, max: 160, step: 5 };
const defaults = { rigId: defaultRig.id, placement: 'off', flaps: '2', gear: '2', textSize: 100, pedalVisibility: {}, pedalAxesByRig: {} };
let setup = { ...defaults };
try {
  const saved = JSON.parse(localStorage.getItem('rig-setup') || '{}');
  setup.rigId = rigForId(saved.rigId).id;
  setup.controllerChosen = saved.controllerChosen === true && setup.rigId === saved.rigId;
  for (const rig of rigProfiles) {
    if (rig.devices.pedals && typeof saved.pedalVisibility?.[rig.id] === 'boolean')
      setup.pedalVisibility[rig.id] = saved.pedalVisibility[rig.id];
    else if (Array.isArray(saved.enabledPedalRigs) && saved.enabledPedalRigs.includes(rig.id))
      setup.pedalVisibility[rig.id] = true;
    const savedAxes = saved.pedalAxesByRig?.[rig.id];
    if (!rig.devices.pedals || !savedAxes) continue;
    const axes = {};
    for (const toe of ['left-toe', 'right-toe']) {
      if (typeof savedAxes[toe] === 'string' && isPedalToeAxis(savedAxes[toe]) && !Object.values(axes).includes(savedAxes[toe]))
        axes[toe] = savedAxes[toe];
    }
    setup.pedalAxesByRig[rig.id] = axes;
  }
  for (const [key, choices] of Object.entries({
    placement: ['left', 'right', 'off'],
    flaps: ['2', '3', '4', 'axis'],
    gear: ['2', '3', 'axis'],
  })) {
    if (choices.includes(saved[key])) setup[key] = saved[key];
  }
  for (const key of ['leftWheel', 'rightWheel']) {
    if (isWheelAxis(saved[key])) setup[key] = saved[key];
  }
  if (Number.isInteger(saved.textSize) && saved.textSize >= textSizeRange.min &&
      saved.textSize <= textSizeRange.max && saved.textSize % textSizeRange.step === 0) {
    setup.textSize = saved.textSize;
  }
} catch {
  /* Fall back to the two-stick desk if the saved setup is unreadable. */
}
document.documentElement.style.setProperty('--text-scale', String(setup.textSize / 100));
let controllerSetup = rigForId(setup.rigId);
function pedalsEnabled(data = profile) {
  const pedals = controllerSetup.devices.pedals;
  if (!pedals) return false;
  return setup.pedalVisibility[controllerSetup.id] ??
    (data.source.kind === 'starter' || data.devices.some(pedals.matches) || hardware.some(pedals.matches));
}
function currentSheet(source) {
  return buildSheet(source, controllerSetup.controlsByDevice, { ...setup, pedalsEnabled: pedalsEnabled(source),
    pedalAxes: setup.pedalAxesByRig[controllerSetup.id] }, controllerSetup.family);
}
function matchesSetupDevice(device) {
  return stickFamily(device) === controllerSetup.family || (pedalsEnabled() && controllerSetup.devices.pedals.matches(device));
}

let profile = blank(),
  livePath = '',
  sourceId = 'active',
  layoutChoice = 'auto',
  autoNotice = '',
  needsGameFolder = false,
  page = 'rig';
let sheet = [],
  hardware = [],
  selected = null,
  focus = 'all',
  query = '';
let streamStatus = { level: 'info', message: 'Starting Windows input reader' };
let observed = null,
  requestId = 0,
  sourceError = '',
  loading = false,
  rig = null;
let inputFrame = 0, axisTimer = 0, latestAxis = null, lastAxisTime = -Infinity;
let compatibilityMode = false;
let controlById = new Map(), learnedControls = new Map(), slotByHost = new Map();
const heldButtons = new Map();
const wheelPositions = new Map();
let axisIdentifiers = [];
const activeInputs = new Set();
const monitor = createMonitor();
const nextLaunch = createNextLaunch({
  bridge: window.viewer,
  isEditing: () => editSession.active,
  async onRestored() {
    if ($('picker').open) $('picker').close();
    await load('active');
  },
});
const handoff = createGameHandoff((id, revision, scope) => window.viewer.verifyLayout(id, revision, scope), nextLaunch);
let reference = false, returnToEdit = null, labelContext = 'flying', buttonLabels = true;
let editedIds = new Set();
try {
  if (localStorage.getItem('rig-label-context') === 'all') labelContext = 'all';
  // Earlier builds stored an optional label overlay. Start upgraded profiles
  // in Quick view and remember subsequent explicit view choices.
  buttonLabels = localStorage.getItem('rig-start-view') !== 'desk';
} catch {}
const editSession = createEditSession({
  context: () => ({
    profile, sheet, sourceSheet: () => currentSheet(profile),
    hardware: hardware.filter(matchesSetupDevice),
    sourceId: profile.source.kind === 'starter' ? profile.source.path : sourceId, livePath, loading, sourceName: sourceName(),
    control: sheet.find(item => item.id === selected) || null,
  }),
  redraw: rebuild,
  onMode(open) {
    reference = false;
    returnToEdit = null;
    showWorkspace(open);
    if (open) {
      updatePage('rig');
    }
  },
  async onSaved(result) {
    await load(result.sourceId, result);
  },
});
window.addEventListener('beforeunload', event => {
  if (editSession.dirty || nextLaunch.writing) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function el(tag, cls, value) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (value !== undefined) n.textContent = value;
  return n;
}
function assignedButton(label, handler, cls) {
  const b = el('button', cls, label);
  b.addEventListener('click', handler);
  return b;
}
function friendlyKey(k) {
  return (k || '')
    .replace(/^button(\d+)$/, 'B$1')
    .replace(/^hat1_/, 'POV ')
    .toUpperCase();
}
function sourceName() {
  if (profile.source.kind === 'active') return 'Active game profile';
  return profile.source.name || 'Blank layout';
}
function codeFor(item) {
  const device = controllerSetup.devices[item.device];
  const name = device?.code || device?.name || 'Saved input';
  return name.toUpperCase() + ' / ' + friendlyKey(item.key);
}
function deviceName(id) {
  return controllerSetup.devices[id]?.name || (id === 'unknown' ? 'Other saved inputs' : id);
}
function focusOptions() {
  return [['all', 'All'], ...Object.entries(controllerSetup.devices)
    .filter(([id]) => id !== 'pedals' || pedalsEnabled()).map(([id, spec]) => [id, spec.focus])];
}
function renderControllerSetup() {
  $('controller-setup').value = controllerSetup.id;
  $('controller-setup').title = controllerSetup.name;
  $('module-controls').hidden = !controllerSetup.devices.sem;
  $('pedal-controls').hidden = !controllerSetup.devices.pedals;
  if (controllerSetup.devices.pedals) $('pedal-name').textContent = controllerSetup.devices.pedals.name;
  for (const b of document.querySelectorAll('[data-pedals]')) {
    const pressed = (b.dataset.pedals === 'on') === pedalsEnabled();
    b.classList.toggle('selected', pressed);
    b.setAttribute('aria-pressed', String(pressed));
  }
  monitor.setShowSem(Boolean(controllerSetup.devices.sem));
  $('camera-focus').replaceChildren(...focusOptions().map(([id, name]) => {
    const button = assignedButton(name, () => setFocus(id));
    button.dataset.focus = id;
    button.classList.toggle('selected', id === focus);
    button.setAttribute('aria-pressed', String(id === focus));
    return button;
  }));
}
function syncPedalView() {
  if (!controllerSetup.devices.pedals) return;
  const enabled = pedalsEnabled();
  if (!enabled && focus === 'pedals') setFocus('all');
  rig?.setPedals(enabled);
  renderControllerSetup();
}
function rememberSetup() {
  try {
    localStorage.setItem('rig-setup', JSON.stringify(setup));
  } catch {}
}
function showWorkspace(editing = editSession.active) {
  $('rig-page').classList.toggle('reference-mode', reference);
  $('rig-heading').textContent = reference ? 'Reference sheet' : 'Desk view';
  $('button-labels').setAttribute('aria-pressed', String(buttonLabels && !reference));
  $('reference-layout').setAttribute('aria-pressed', String(reference));
  $('reference-layout').textContent = reference ? (editing ? 'Back to editing' : 'Back to desk') : 'Reference sheet';
  $('reference-layout').title = reference ? 'Leave reference sheet' : 'Read-only reference sheet';
  $('edit-layout').hidden = reference && editing;
  $('bindings-panel').hidden = reference || editing;
  $('layout-editor').hidden = reference || !editing;
  $('mode-status').textContent = reference ? 'Reference sheet' : editing ? 'Editing layout' : 'Viewing layout';
}
function toggleReference() {
  if (editSession.saving) return;
  if (!reference && editSession.active) returnToEdit = { selected, focus, observed };
  reference = !reference;
  showWorkspace();
  if (!reference && returnToEdit) {
    const previous = returnToEdit;
    returnToEdit = null;
    selected = previous.selected;
    observed = previous.observed;
    if (focus !== previous.focus) setFocus(previous.focus);
    const control = sheet.find(item => item.id === selected);
    rig?.highlight(control?.device, control?.key);
  }
  if (!reference) renderBindings();
  renderDetails();
  labelRig();
}
function setNotice() {
  const currentHost = hardware.find((d) => /\bSEM\b/i.test(d.name));
  const previousHost = profile.devices.find((d) => /\bSEM\b/i.test(d.product));
  const liveSide =
    currentHost &&
    (/\b(?:R|RH|right)\b/i.test(currentHost.name)
      ? 'right'
      : /\b(?:L|LH|left)\b/i.test(currentHost.name)
        ? 'left'
        : null);
  let text = '';
  let level = 'info';
  const missing = sourceId === 'active' && profile.source.missing;
  if (sourceError) {
    text = sourceError;
    level = 'error';
  } else if (missing === 'game-data') {
    text = 'Choose your Star Citizen LIVE folder to load your bindings.';
  } else if (missing === 'active-profile') {
    text = 'This installation has no saved active profile. Save a binding in Star Citizen, then reload the profile here.';
  } else if (autoNotice) {
    text = autoNotice;
  } else if (profile.source.kind === 'starter' && !profile.source.canSave) {
    text = 'Choose your Star Citizen LIVE folder to save this starter as a game layout.';
  } else if (profile.diagnostics?.some((d) => /unavailable|failed|could not/i.test(d))) {
    text = 'Some game data could not be read. See Profile details.';
    level = 'warning';
  } else if (controllerSetup.devices.sem && liveSide && ['left', 'right'].includes(previousHost?.device) && previousHost.device !== liveSide) {
    text = `Saved SEM bindings use the ${previousHost.device} stick. Windows sees the SEM on the ${liveSide} stick.`;
    if (currentHost.readable !== false) text += ' Live input is available in Input monitor.';
  }
  const notice = $('notice');
  notice.dataset.level = level;
  $('notice-message').textContent = text;
  $('notice-folder').hidden = !missing && !needsGameFolder && !(profile.source.kind === 'starter' && !profile.source.canSave);
  notice.hidden = !text;
}
function rebuild() {
  sheet = currentSheet(editSession.draft || profile);
  controlById = new Map(sheet.map(item => [item.id, item]));
  slotByHost = new Map();
  for (const device of (editSession.draft || profile).devices) {
    if (!matchesSetupDevice(device)) continue;
    slotByHost.set(device.device, slotByHost.has(device.device) ? null : device.slot);
  }
  learnedControls = new Map();
  for (const item of sheet) for (const row of item.rows) {
    if (!row.physicalKey) continue;
    const id = row.slot + '/' + row.input;
    // Multiple physical controls claiming the same route are ambiguous.
    if (learnedControls.has(id) && learnedControls.get(id) !== item) learnedControls.set(id, null);
    else learnedControls.set(id, item);
  }
  syncHeldControls();
  editedIds = editSession.stagedControlIds;
  setRigControls();
  if (!sheet.some((c) => c.id === selected)) selected = null;
  for (const b of document.querySelectorAll('[data-place]')) {
    b.classList.toggle('selected', b.dataset.place === setup.placement);
    b.setAttribute('aria-pressed', String(b.dataset.place === setup.placement));
  }
  const semFocus = document.querySelector('[data-focus="sem"]');
  if (semFocus) semFocus.disabled = setup.placement === 'off';
  if (setup.placement === 'off' && focus === 'sem') setFocus('all');
  drawTools();
  renderBindings();
  renderDetails();
  labelRig();
  setNotice();
  monitor.setProfile(profile);
}
function labelRig() {
  const compact = buttonLabels && !reference;
  const items = rigLabels(sheet, focus, selected, {
    reference, compact, placement: setup.placement, context: labelContext, editing: editSession.active && !reference, editedIds,
  });
  $('button-labels-empty').hidden = !compact || items.length > 0 || loading || !sheet.length || !!sourceError;
  $('use-automatic').hidden = layoutChoice === 'auto' || focus !== 'all' || editSession.active;
  rig?.setLabels(items);
}
function setRigControls() {
  rig?.setControls(sheet.map(item => ({ ...item, rows: orderedActions(item, labelContext) })));
}
function setFocus(unit) {
  const current = sheet.find(control => control.id === selected);
  if (unit !== 'all' && current?.device !== unit) {
    selected = null;
    rig?.highlight(null, null);
  }
  focus = unit;
  rig?.focus(unit);
  labelRig();
  drawTools();
  renderBindings();
  renderDetails();
  for (const b of document.querySelectorAll('[data-focus]')) {
    b.classList.toggle('selected', b.dataset.focus === focus);
    b.setAttribute('aria-pressed', String(b.dataset.focus === focus));
  }
}
function updatePage(next) {
  const wasMonitor = page === 'monitor';
  page = next;
  $('page-title').textContent = pages[page];
  document.title = 'HOTAS Uplink · ' + pages[page];
  for (const p of Object.keys(pages)) $(p + '-page').hidden = p !== page;
  for (const b of document.querySelectorAll('[data-page]')) {
    const on = b.dataset.page === page;
    b.classList.toggle('active', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  }
  rig?.setVisible(page === 'rig');
  monitor.setVisible(page === 'monitor' && !document.hidden);
  if (wasMonitor && page !== 'monitor' && latestAxis) {
    if (editSession.active && !reference) clearAxis();
    else flushAxis();
  }
  if (page === 'sheet' || page === 'rig') renderBindings();
  if (page === 'rig') refreshSelection();
}

function refreshSelection() {
  const item = controlById.get(selected);
  rig?.highlight(item?.device, item?.key);
  labelRig();
  renderDetails();
}
function drawTools() {
  for (const [id, label] of [
    ['directory-tools', 'Search bindings'],
    ['sheet-tools', 'Search binding sheet'],
  ]) {
    const host = $(id);
    host.replaceChildren();
    const wrap = el('label', 'searchbox'),
      magnify = el('i');
    magnify.dataset.icon = 'search';
    const input = el('input');
    input.type = 'search';
    input.placeholder = 'Search controls or actions';
    input.setAttribute('aria-label', label);
    input.value = query;
    input.addEventListener('input', () => {
      query = input.value;
      for (const other of document.querySelectorAll('.searchbox input'))
        if (other !== input) other.value = query;
      renderBindings();
    });
    wrap.append(magnify, input);
    host.append(wrap);
    const chips = el('div', 'filter-tabs');
    for (const [key, name] of focusOptions()) {
      if (key === 'sem' && setup.placement === 'off') continue;
      const btn = assignedButton(name, () => setFocus(key));
      btn.classList.toggle('selected', key === focus);
      btn.setAttribute('aria-pressed', String(key === focus));
      chips.append(btn);
    }
    host.append(chips);
    addIcons(host);
  }
}
function matches(item) {
  if (focus !== 'all' && item.device !== focus) return false;
  if (!query.trim()) return true;
  const text = [
    item.key,
    item.label,
    item.group,
    item.productName,
    deviceName(item.device),
    friendlyKey(item.key),
    ...item.rows.flatMap((r) => [
      r.action,
      r.label,
      r.context,
      r.contextLabel,
      r.gesture,
      searchAliases[r.action],
    ]),
  ]
    .join(' ')
    .toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((token) => text.includes(token));
}
function makeRow(item, isSheet) {
  const b = assignedButton(
    '',
    () => {
      selectControl(item.id);
      if (isSheet) updatePage('rig');
    },
    isSheet ? 'sheet-row' : 'binding-row',
  );
  b.dataset.control = item.id;
  b.classList.toggle('chosen', item.id === selected);
  b.classList.toggle('pressed', activeInputs.has(item.id));
  const line = el('div', 'label-line');
  line.append(el('strong', 'row-name', item.label), el('span', 'physical', friendlyKey(item.key)));
  b.append(line);
  const names = actionNames(item, labelContext);
  if (isSheet) {
    for (const value of names) b.append(el('span', 'action-name', value));
  } else if (names.length) {
    const a = el('span', 'action-name', names[0]);
    if (names.length > 1) a.append(el('span', 'overflow', '+' + (names.length - 1)));
    b.append(a);
  }
  if (!names.length)
    b.append(
      el('span', 'action-name empty', item.needsCapture ? 'Input number unverified' : 'Unassigned'),
    );
  return b;
}
function renderBindings() {
  const visible = sheet.filter(matches);
  $('binding-total').textContent =
    String(visible.reduce((total, item) => total + item.rows.length, 0)) + ' binds';
  const dir = $('directory-list'),
    grid = $('sheet-grid');
  const buildList = page === 'rig' && !$('bindings-panel').hidden,
    buildGrid = page === 'sheet';
  if (!buildList && !buildGrid) return;
  const target = buildList ? dir : grid;
  const scroll = target.scrollTop;
  const fragment = document.createDocumentFragment();
  for (const device of [...new Set(visible.map((c) => c.device))]) {
    const items = visible.filter((c) => c.device === device);
    let box = fragment;
    if (buildGrid) {
      box = el('section', 'sheet-card');
      const head = el('div', 'sub-head');
      head.append(
        el('h2', '', deviceName(device)),
        el('span', 'count', String(items.length)),
      );
      box.append(head);
      fragment.append(box);
    }
    let group = '';
    for (const item of items) {
      const next = item.group === 'unmapped' && item.slot
        ? ['JS' + item.slot, item.productName].filter(Boolean).join(' · ')
        : item.group || 'Controls';
      if (next !== group) {
        group = next;
        box.append(
          el(
            'div',
            'group-name',
            buildGrid ? group : deviceName(device) + ' / ' + group,
          ),
        );
      }
      box.append(makeRow(item, buildGrid));
    }
  }
  if (!visible.length)
    fragment.append(
      el(
        'p',
        'blank-message',
        loading ? 'Reading the local profile…' : 'No controls match this search.',
      ),
    );
  target.replaceChildren(fragment);
  target.scrollTop = scroll;
}
function selectControl(id, source = 'ui', activity = null) {
  const item = controlById.get(id);
  if (!item) return;
  if (editSession.active && !reference && !editSession.acceptControl(id, source)) return;
  if (activity) observed = activity;
  const previous = selected;
  selected = id;
  if (document.hidden || page === 'monitor') return;
  if (page === 'rig') {
    rig?.highlight(item.device, item.key);
    renderDetails();
    if (previous !== id) labelRig();
  }
  if (previous !== id) {
    markControl(previous, 'chosen', false);
    markControl(id, 'chosen', true);
  }
}
function renderDetails() {
  if (reference) return;
  editSession.render();
  const item = sheet.find((c) => c.id === selected),
    target = $('control-detail');
  target.replaceChildren();
  $('inspect-code').textContent = item ? codeFor(item) : '';
  $('locate').disabled =
    !rig || !item || !canLocate(item);
  if (!item) {
    target.append(el('p', 'plain-detail', 'Press a control or select one on the model to see its assignments.'));
    return;
  }
  const grid = el('div', 'detail-content'),
    title = el('div'),
    list = el('div', 'detail-items');
  title.append(
    el('span', 'small-label', deviceName(item.device)),
    el('h3', '', item.label),
  );
  const saved = [...new Set(item.rows.map((r) => 'JS' + r.slot + ' / ' + friendlyKey(r.input)))];
  if (saved.length) title.append(el('p', '', (editSession.draft ? 'Layout · ' : 'Saved · ') + saved.join(', ')));
  if (observed?.id === item.id) title.append(el('p', '', 'Observed · ' + observed.raw));
  if (!item.rows.length)
    list.append(
      el(
        'div',
        'detail-action muted',
        item.suggestedAction
          ? 'This starter suggests ' + item.suggestedAction + '. Identify the footplate in Settings → Toe brake axes to bind it.'
          : item.needsCapture
          ? 'The physical position is configured. Its reported input still needs verification.'
          : 'Unassigned',
      ),
    );
  for (const r of orderedActions(item, labelContext)) {
    const action = el('div', 'detail-action', r.label);
    action.append(
      el(
        'small',
        '',
        [r.contextLabel, r.gesture, r.origin === 'draft' ? 'Staged binding' : r.origin === 'default' ? 'Game default' :
          profile.source.kind === 'starter' ? 'Uplink starter binding' : profile.source.kind === 'builtin' ? 'Game preset binding' : 'Saved binding']
          .filter(Boolean)
          .join(' · '),
      ),
    );
    list.append(action);
  }
  grid.append(title, list);
  target.append(grid);
}
function readLayout(id) {
  const pedalStarter = controllerSetup.devices.pedals?.starterLayout;
  if (pedalStarter && id === controllerSetup.starterLayout && setup.pedalVisibility[controllerSetup.id] !== false) {
    return window.viewer.profile(pedalStarter, setup.pedalAxesByRig[controllerSetup.id]);
  }
  return window.viewer.profile(id);
}
async function automaticLayout() {
  const { gamePreset, starterLayout } = controllerSetup;
  const hasStickLabels = data => currentSheet(data).some(control =>
    (control.device === 'left' || control.device === 'right') && canLocate(control) && control.rows.length);
  let reason;
  let needsFolder = false;
  try {
    const active = await window.viewer.profile('active');
    if (hasStickLabels(active)) return { id: 'active', data: active };
    needsFolder = active.source.missing === 'game-data';
    reason = needsFolder ? 'Choose your LIVE folder to see your game bindings.' :
      active.source.missing ? 'Star Citizen has no saved active profile yet.' :
        'Your active profile has no mapped controls on these sticks.';
  } catch (error) {
    reason = 'Could not read your active profile. ' + error.message;
    needsFolder = true;
  }
  if (gamePreset) {
    try {
      if ((await window.viewer.sources()).some(source => source.id === gamePreset)) {
        const data = await window.viewer.profile(gamePreset);
        if (hasStickLabels(data)) return { id: gamePreset, data, notice: 'Showing a Star Citizen preset. ' + reason, needsFolder };
      }
    } catch {
      // The installed preset may have disappeared during a game update. The packaged starter is still available.
    }
  }
  return { id: starterLayout, data: await readLayout(starterLayout),
    notice: 'Showing the HOTAS Uplink starter. ' + reason, needsFolder };
}
async function load(choice, justSaved = null) {
  if (editSession.active && !(await editSession.requestClose())) return;
  const token = ++requestId;
  loading = true;
  handoff.show(null);
  sourceError = '';
  $('profile-name').textContent = 'Loading layout…';
  $('refresh').disabled = true;
  $('edit-layout').disabled = true;
  try {
    const result = choice === 'auto' ? await automaticLayout() :
      { id: choice, data: choice === 'blank' ? blank() : await readLayout(choice) };
    if (token !== requestId) return;
    profile = result.data;
    sourceId = result.id;
    layoutChoice = choice;
    autoNotice = result.notice || '';
    needsGameFolder = Boolean(result.needsFolder);
    observed = null;
    // Previous builds also stored "active" after automatic loads.
    try { localStorage.setItem(layoutPreferenceKey(), choice === 'active' ? 'manual:active' : choice); } catch {}
  } catch (error) {
    if (token !== requestId) return;
    sourceError = 'Could not load layout. ' + error.message;
  }
  if (token !== requestId) return;
  loading = false;
  $('refresh').disabled = false;
  $('profile-name').textContent = sourceName();
  $('game-context').textContent = ({ builtin: 'STAR CITIZEN / GAME PRESET', starter: 'HOTAS UPLINK / STARTER',
    export: 'STAR CITIZEN / SAVED LAYOUT', blank: 'STAR CITIZEN / LAYOUT' })[profile.source.kind] || 'STAR CITIZEN / LIVE';
  $('source').title = 'Choose layout · ' + sourceName();
  $('source-status').textContent = profile.source.build
    ? 'Star Citizen ' + profile.source.build
    : 'Local layout';
  syncPedalView();
  rebuild();
  showLayoutHandoff(justSaved);
  return !sourceError;
}
function showLayoutHandoff(justSaved = null) {
  if (sourceError || !(sourceId.startsWith('export:') || sourceId.startsWith('builtin:'))) return;
  const saved = justSaved || { sourceId, revision: profile.source.revision, name: sourceName() };
  handoff.show({ ...saved, setupName: controllerSetup.shortName || controllerSetup.name,
    scope: { family: controllerSetup.family, pedals: pedalsEnabled() } }, Boolean(justSaved));
}
function layoutPreferenceKey() {
  return 'layout-source/' + livePath.toLowerCase() + '/' + controllerSetup.id;
}
async function loadControllerLayout() {
  const request = requestId;
  let id = 'auto';
  try { id = localStorage.getItem(layoutPreferenceKey()) || id; } catch {}
  if (id === 'active') id = 'auto';
  else if (id === 'manual:active') id = 'active';
  // A named export can be renamed or removed in Star Citizen between sessions.
  if (!['auto', 'active', 'blank', controllerSetup.starterLayout].includes(id)) {
    try {
      if (!(await window.viewer.sources()).some(source => source.id === id)) id = 'auto';
    } catch { /* Try the remembered layout directly if listing the folder failed. */ }
  }
  if (request === requestId) await load(id);
}
function openDialog(title, className = '') {
  axisIdentifiers = [];
  $('picker').className = className;
  $('dialog-title').textContent = title;
  const content = $('dialog-content');
  content.replaceChildren();
  if (!$('picker').open) $('picker').showModal();
  return content;
}
function section(parent, title) {
  const s = el('section', 'dialog-section');
  s.append(el('h3', '', title));
  parent.append(s);
  return s;
}
async function chooseSource() {
  const host = openDialog('Choose layout');
  function option(parent, id, name, label) {
    const b = assignedButton(
      name,
      () => {
        $('picker').close();
        load(id);
      },
      'source-option',
    );
    b.append(el('small', '', id === layoutChoice ? 'Selected' : id === sourceId ? 'Viewing' : label));
    parent.append(b);
  }
  const current = section(host, 'Starting point');
  option(current, 'auto', 'Automatic for these controllers', 'Recommended');
  option(current, 'active', 'Active game profile', 'LIVE');
  option(current, 'blank', 'New blank layout', 'Empty');
  let sources = [];
  try {
    sources = await window.viewer.sources();
  } catch (error) {
    current.append(el('p', 'dialog-note', error.message));
  }
  if (!current.isConnected || !$('picker').open) return;
  for (const [kind, title] of [
    ['export', 'Saved layouts'],
    ['builtin', 'Game presets'],
    ['starter', 'HOTAS Uplink starters'],
  ]) {
    const list = sources.filter(s => s.kind === kind && (kind === 'export' ||
      (kind === 'starter' ? s.id === controllerSetup.starterLayout : s.manufacturer?.toLowerCase() === controllerSetup.family)));
    if (!list.length) continue;
    const group = section(host, title);
    for (const s of list)
      option(
        group,
        s.id,
        s.name.replace(/^layout_/i, '').replace(/_exported\.xml$/i, ''),
        kind === 'export' ? 'XML' : s.manufacturer,
      );
  }
  nextLaunch.addRestoreOption(section(host, 'Binding backup'));
  const location = section(host, 'Game installation');
  location.append(el('p', 'dialog-note', livePath));
  location.append(assignedButton('Choose LIVE folder…', chooseInstallation, 'text-button'));
}
async function chooseInstallation() {
  const fromPicker = $('picker').open;
  if (fromPicker) $('picker').close();
  if (!(await editSession.requestClose())) return;
  try {
    const changed = await window.viewer.chooseInstall();
    if (!changed) {
      if (fromPicker) chooseSource();
      return;
    }
    if (changed !== livePath) {
      profile = blank();
      sourceId = 'active';
      observed = null;
    }
    livePath = changed;
    await loadControllerLayout();
  } catch (error) {
    sourceError = error.message;
    setNotice();
  }
}
const addUpdateControls = createUpdateControls(window.viewer, () => {
  if (editSession.saving || nextLaunch.writing) return 'Wait for the binding file to finish saving before restarting.';
  if (editSession.dirty) return 'Save or discard your staged layout changes before restarting.';
  return '';
}, () => $('picker').close());

function openSettings() {
  const root = openDialog('Settings', 'settings-dialog');
  const appearance = section(root, 'Appearance');
  const heading = el('div', 'text-size-heading');
  const label = el('label', '', 'Text size');
  const value = el('output');
  const slider = el('input');
  slider.type = 'range';
  slider.id = 'text-size';
  label.htmlFor = slider.id;
  value.htmlFor.add(slider.id);
  value.setAttribute('aria-hidden', 'true');
  Object.assign(slider, textSizeRange);
  const describeValue = () => {
    value.value = slider.value + '%';
    slider.setAttribute('aria-valuetext', value.value);
  };
  function previewSize() {
    setup.textSize = slider.valueAsNumber;
    document.documentElement.style.setProperty('--text-scale', String(setup.textSize / 100));
    describeValue();
    rig?.refreshTextLayout();
  }
  slider.value = setup.textSize;
  describeValue();
  slider.oninput = previewSize;
  slider.onchange = rememberSetup;
  const reset = assignedButton('Reset to 100%', () => {
    slider.value = defaults.textSize;
    previewSize();
    rememberSetup();
  }, 'text-button');
  const hint = el('p', 'dialog-note', 'Includes Quick view labels.');
  hint.id = 'text-size-hint';
  slider.setAttribute('aria-describedby', hint.id);
  const notes = el('div', 'text-size-notes');
  notes.append(hint, reset);
  heading.append(label, value);
  appearance.append(heading, slider, notes);
  if (controllerSetup.devices.sem) addVkbSettings(root);
  if (pedalsEnabled()) addAxisSettings(root, 'pedals');
  addUpdateControls(section(root, 'App updates'));
  const about = section(root, 'About HOTAS Uplink');
  about.append(
    el('p', '', 'DeltaWerks made HOTAS Uplink to help Star Citizen players see and edit their joystick bindings. The 3D models are visual references for the controls on your desk.'),
    el('p', 'dialog-note', 'This community project is independent of Cloud Imperium Games, Roberts Space Industries, and the controller manufacturers.'),
  );
}
function addVkbSettings(root) {
  const area = section(root, 'SEM lever positions');
  area.append(
    el(
      'p',
      'dialog-note',
      'Match the detents installed on your SEM. Both levers keep their assignments across dial positions.',
    ),
  );
  for (const [key, label, choices] of [
    ['flaps', 'FLAPS', ['2', '3', '4', 'axis']],
    ['gear', 'LANDING GEAR', ['2', '3', 'axis']],
  ]) {
    const row = el('label', 'setup-row', label),
      select = el('select');
    select.setAttribute('aria-label', label + ' positions');
    for (const v of choices) {
      const o = el('option', '', v === 'axis' ? 'Analog axis' : v + ' positions');
      o.value = v;
      select.append(o);
    }
    select.value = setup[key];
    select.onchange = () => {
      setup[key] = select.value;
      rememberSetup();
      rebuild();
    };
    row.append(select);
    area.append(row);
  }
  addAxisSettings(root, 'wheels');
}
function addAxisSettings(root, kind) {
  const pedals = kind === 'pedals';
  const area = section(root, pedals ? 'Toe brake axes' : 'Center base wheels');
  const message = el('p', 'dialog-note');
  message.setAttribute('role', 'status');
  const buttons = new Map();
  const positions = new Map();
  let listening = null;
  function refresh() {
    for (const [side, { value, button }] of buttons) {
      const connected = hardware.filter(device => device.readable &&
        (pedals ? controllerSetup.devices.pedals.matches(device) : liveHand(device, 'vkb') === side));
      button.disabled = connected.length !== 1;
      if (side === listening && button.disabled) listening = null;
      const axis = pedals ? setup.pedalAxesByRig[controllerSetup.id]?.[side + '-toe'] : setup[side + 'Wheel'] || 'z';
      value.textContent = axis ? axis.toUpperCase() : 'Unidentified';
      const noun = pedals ? 'toe brake' : 'wheel';
      button.textContent = listening === side ? 'Cancel' : 'Identify ' + noun;
      button.setAttribute('aria-label', listening === side ? 'Cancel ' + side + ' ' + noun + ' identification' : 'Identify ' + side + ' ' + noun);
    }
    if (listening) message.textContent = pedals ? 'Press just the ' + listening + ' toe brake.' : 'Roll the ' + listening + ' center wheel a little way.';
    else if (compatibilityMode) message.textContent = 'Axis identification uses live input in the standard app.';
    else if (!pedals) message.textContent = 'If a wheel selects the wrong control or stays quiet, identify its input here.';
    else message.textContent = profile.source.kind === 'starter'
      ? 'Identify each footplate to include its suggested driving action when you save this starter.'
      : 'Identify each toe brake to show its saved bindings on the pedals.';
  }
  for (const side of ['left', 'right']) {
    const label = (side === 'left' ? 'Left' : 'Right') + (pedals ? ' toe brake' : ' stick');
    const row = el('div', 'setup-row');
    const value = el('span', 'physical');
    const button = assignedButton('', async () => {
      const next = listening === side ? null : side;
      if (next && pedals && profile.source.kind === 'starter' && editSession.active && !(await editSession.requestClose())) return;
      for (const id of axisIdentifiers) id.cancel();
      listening = next;
      positions.clear();
      refresh();
    }, 'text-button');
    row.append(el('span', '', label), value, button);
    area.append(row);
    buttons.set(side, { value, button });
  }
  area.append(message);
  axisIdentifiers.push({
    refresh,
    cancel() { listening = null; refresh(); },
    record(event, mapped) {
      if (!listening || !mapped) return;
      if (pedals ? mapped.host !== 'pedals' || !isPedalToeAxis(mapped.raw)
        : mapped.host !== listening || !isWheelAxis(mapped.raw)) return;
      if (!hasAxisTravel(positions, event, 0.16)) return;
      const side = listening;
      listening = null;
      let cleared = '';
      if (pedals) {
        const axes = setup.pedalAxesByRig[controllerSetup.id] ||= {};
        const other = side === 'left' ? 'right' : 'left';
        if (axes[other + '-toe'] === mapped.raw) {
          delete axes[other + '-toe'];
          cleared = ' Identify the ' + other + ' toe brake again.';
        }
        axes[side + '-toe'] = mapped.raw;
      } else setup[side + 'Wheel'] = mapped.raw;
      rememberSetup();
      wheelPositions.clear();
      if (pedals && profile.source.kind === 'starter') void load(layoutChoice);
      else rebuild();
      refresh();
      message.textContent = (side === 'left' ? 'Left' : 'Right') + (pedals ? ' toe brake' : ' wheel') +
        ' identified as ' + mapped.raw.toUpperCase() + '.' + cleared;
    },
  });
  refresh();
}
function detailsDialog() {
  const root = openDialog('Profile details'),
    src = section(root, 'Viewing');
  src.append(el('p', '', sourceName()), el('p', '', profile.source.path || 'Empty layout'));
  if (profile.source.modifiedAt)
    src.append(el('p', '', 'Saved ' + new Date(profile.source.modifiedAt).toLocaleString()));
  const d = section(root, 'Joysticks recorded in this profile');
  for (const device of profile.devices)
    d.append(
      el(
        'p',
        '',
        'JS' +
          device.slot +
          ' · ' +
          (device.product?.split('{')[0]?.trim() || 'Unidentified joystick'),
      ),
    );
  if (!profile.devices.length) d.append(el('p', '', 'No saved device assignments.'));
  if (profile.diagnostics.length) {
    const issues = section(root, 'Reader notes');
    for (const msg of profile.diagnostics) issues.append(el('p', '', msg));
  }
  const live = section(root, 'Windows input');
  live.append(el('p', '', streamStatus.message));
  live.append(
    assignedButton(
      'Open input monitor',
      () => {
        $('picker').close();
        updatePage('monitor');
      },
      'text-button',
    ),
  );
}
function renderDevices() {
  const available = hardware.filter((d) => d.readable !== false).length;
  $('device-count').textContent = compatibilityMode ? 'Compatibility mode' :
    available + ' controller' + (available === 1 ? '' : 's') + ' online';
  $('device-short').textContent = compatibilityMode ? 'Compatibility mode' : available + ' online';
  $('device-count').parentElement.title = compatibilityMode
    ? 'Software 3D rendering. Live joystick input is off.' : $('device-count').textContent;
  $('device-light').classList.toggle('on', available > 0);
  monitor.setDevices(hardware);
  setNotice();
  if (!reference) editSession.render();
}
function markControl(id, token, enabled) {
  if (!id || document.hidden || page === 'monitor') return;
  if (page === 'rig' && $('bindings-panel').hidden) return;
  const list = page === 'sheet' ? $('sheet-grid') : $('directory-list');
  list.querySelector('[data-control="' + CSS.escape(id) + '"]')?.classList.toggle(token, enabled);
}
function controlForInput(mapped) {
  if (!mapped) return null;
  if (mapped.host === 'pedals') {
    if (!pedalsEnabled()) return null;
    const item = sheet.find(control => control.device === 'pedals' && control.reportedInput === mapped.raw);
    if (item) return item;
  }
  // A wheel identified on this stick takes precedence when an older SEM
  // assignment uses the same logical axis in the saved game layout.
  if (setup[mapped.host + 'Wheel'] === mapped.raw) {
    const wheel = controlById.get(mapped.host + ':' + mapped.raw);
    if (wheel?.group === 'throttle') return wheel;
  }
  const slot = slotByHost.get(mapped.host);
  return learnedControls.get(slot + '/' + mapped.raw) || controlById.get(mapped.device + ':' + mapped.key);
}
function syncHeldControls() {
  activeInputs.clear();
  for (const [id, buttons] of heldButtons) for (const button of buttons) {
    const mapped = physicalInput({ type: 'button', id, button }, hardware, controllerSetup.controlsByDevice, controllerSetup.family);
    const item = controlForInput(mapped);
    if (item) activeInputs.add(item.id);
  }
}
function receiveDevices(devices) {
  const hadPedals = pedalsEnabled();
  hardware = devices;
  if (hadPedals !== pedalsEnabled()) {
    syncPedalView();
    rebuild();
    if (!loading) showLayoutHandoff();
  }
  for (const identifier of axisIdentifiers) identifier.refresh();
  heldButtons.clear();
  for (const device of devices) heldButtons.set(device.id, new Set(device.pressedButtons || []));
  syncHeldControls();
  if (!document.hidden && page !== 'monitor') {
    const list = page === 'sheet' ? $('sheet-grid') : $('directory-list');
    for (const button of list.querySelectorAll('[data-control]'))
      button.classList.toggle('pressed', activeInputs.has(button.dataset.control));
  }
  renderDevices();
}
function applyInput(event, wheelMoved = false) {
  const mapped = physicalInput(event, hardware, controllerSetup.controlsByDevice, controllerSetup.family);
  if (!mapped || (mapped.host === 'pedals' && !pedalsEnabled())) return;
  const item = controlForInput(mapped);
  const release = event.type === 'button' && !event.pressed;
  if (event.type === 'button') {
    const buttons = heldButtons.get(event.id);
    if (release) buttons?.delete(event.button);
    else buttons?.add(event.button);
    if (item) {
      if (release) activeInputs.delete(item.id);
      else activeInputs.add(item.id);
      markControl(item.id, 'pressed', !release);
    }
  }
  if (document.hidden) return;
  const editing = editSession.active && !reference;
  if (editing) {
    if (editSession.saving || page !== 'rig' || document.querySelector('dialog[open]')) return;
    if (editSession.capture(event, mapped) || (event.type === 'axis' && !wheelMoved)) return;
  }
  if (!item || release) return;
  if (event.type === 'axis' && item.group === 'throttle' && !wheelMoved) return;
  const picking = editing && editSession.waitingForTarget;
  if (focus !== 'all' && item.device !== focus) {
    if (!picking) return;
    setFocus(item.device);
  }
  const raw = deviceName(mapped.host) + ' / ' + friendlyKey(mapped.raw);
  if (!picking && selected === item.id && observed?.id === item.id && observed.raw === raw) return;
  selectControl(item.id, 'hardware', { id: item.id, raw });
}
function clearAxis() {
  cancelAnimationFrame(inputFrame);
  clearTimeout(axisTimer);
  inputFrame = axisTimer = 0;
  latestAxis = null;
}
function flushAxis() {
  const event = latestAxis;
  clearAxis();
  if (!event || document.hidden) return;
  lastAxisTime = performance.now();
  applyInput(event);
}
// These levers stay where they are set. Measure travel from the last accepted
// position so a slow turn works anywhere on the wheel, even around its midpoint.
function hasAxisTravel(positions, event, threshold) {
  if (!Number.isFinite(event.value)) return false;
  const key = event.id + '/' + event.axis;
  const from = positions.get(key) ?? event.value - (Number.isFinite(event.delta) ? event.delta : 0);
  const moved = Math.abs(event.value - from) >= threshold;
  positions.set(key, moved ? event.value : from);
  return moved;
}
function input(event) {
  if (event.type === 'devices') {
    clearAxis();
    wheelPositions.clear();
    receiveDevices(event.devices);
    return;
  }
  if (event.type === 'status') {
    streamStatus = event;
    monitor.setStatus(event);
    return;
  }
  monitor.record(event);
  if (event.type === 'axis') {
    if (document.hidden) return;
    const mapped = physicalInput(event, hardware, controllerSetup.controlsByDevice, controllerSetup.family);
    if (axisIdentifiers.length && $('picker').open) {
      for (const identifier of axisIdentifiers) identifier.record(event, mapped);
      return;
    }
    if (controlForInput(mapped)?.group === 'throttle' && hasAxisTravel(wheelPositions, event, 0.05) && page !== 'monitor') {
      clearAxis();
      applyInput(event, true);
      return;
    }
    latestAxis = event;
    // The raw monitor already follows each axis. Outside it, passive highlighting
    // can sample ongoing motion while armed capture still sees the next frame.
    if (page === 'monitor' || inputFrame || axisTimer) return;
    // A visible second-monitor reference still follows the sticks while the
    // game has focus. Sample continuous axes less often in that case.
    const interval = document.hasFocus() ? 100 : 250;
    const delay = editSession.active && !reference ? 0 : interval - (performance.now() - lastAxisTime);
    if (delay > 0) axisTimer = setTimeout(flushAxis, delay);
    else inputFrame = requestAnimationFrame(flushAxis);
    return;
  }
  clearAxis();
  applyInput(event);
}

addIcons();
showWorkspace();
$('button-labels').onclick = () => {
  if (editSession.saving) return;
  buttonLabels = reference || !buttonLabels;
  try { localStorage.setItem('rig-start-view', buttonLabels ? 'quick' : 'desk'); } catch {}
  if (reference) toggleReference();
  else {
    showWorkspace();
    labelRig();
  }
};
$('reference-layout').onclick = toggleReference;
$('label-context').value = labelContext;
$('label-context').onchange = event => {
  labelContext = event.target.value;
  try { localStorage.setItem('rig-label-context', labelContext); } catch {}
  setRigControls();
  labelRig();
  renderBindings();
  renderDetails();
};
for (const b of document.querySelectorAll('[data-page]'))
  b.onclick = () => updatePage(b.dataset.page);
for (const b of document.querySelectorAll('[data-place]'))
  b.onclick = () => {
    setup.placement = b.dataset.place;
    rememberSetup();
    rig?.setPlacement(setup.placement);
    rebuild();
  };
for (const b of document.querySelectorAll('[data-pedals]'))
  b.onclick = async () => {
    const enable = b.dataset.pedals === 'on';
    if (!controllerSetup.devices.pedals || enable === pedalsEnabled() || loading || editSession.saving || nextLaunch.writing) return;
    const starter = profile.source.kind === 'starter';
    if (starter && editSession.active && !(await editSession.requestClose())) return;
    const id = controllerSetup.id;
    const previous = setup.pedalVisibility[id];
    setup.pedalVisibility[id] = enable;
    clearAxis();
    if (starter) {
      if (!(await load(layoutChoice))) {
        if (previous === undefined) delete setup.pedalVisibility[id];
        else setup.pedalVisibility[id] = previous;
        syncPedalView();
        rebuild();
        return;
      }
    } else {
      syncPedalView();
      rebuild();
      showLayoutHandoff();
    }
    rememberSetup();
  };
$('home').onclick = () => {
  setFocus('all');
};
$('locate').onclick = () => {
  const item = sheet.find((c) => c.id === selected);
  if (!item || !rig) return;
  setFocus(item.device);
  rig.focusControl(item.device, item.key);
};
$('hardware').onclick = openSettings;
$('diagnostics').onclick = detailsDialog;
$('notice-folder').onclick = chooseInstallation;
$('source').onclick = chooseSource;
$('use-automatic').onclick = () => load('auto');
$('refresh').onclick = () => load(layoutChoice);
$('close-dialog').onclick = () => $('picker').close();
$('picker').addEventListener('close', () => { if (!$('picker').open) axisIdentifiers = []; });
$('picker').addEventListener('click', (e) => {
  if (e.target === $('picker')) {
    const r = $('picker').getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
      $('picker').close();
  }
});
function sceneUnavailable(message) {
  const status = $('scene-status');
  status.hidden = false;
  const open = assignedButton('Open binding sheet', () => updatePage('sheet'), 'text-button');
  status.replaceChildren(document.createTextNode(message + ' '), open);
}
function chooseFirstController() {
  if (setup.controllerChosen) return;
  const dialog = $('controller-welcome');
  return new Promise(resolve => {
    for (const config of rigProfiles) {
      const button = assignedButton(config.name, () => {
        controllerSetup = config;
        setup.rigId = config.id;
        setup.controllerChosen = true;
        rememberSetup();
        dialog.close();
        resolve();
      }, 'source-option');
      const arrow = el('i');
      arrow.dataset.icon = 'arrow';
      button.append(arrow);
      $('welcome-choices').append(button);
    }
    addIcons(dialog);
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.showModal();
  });
}
const setupSelect = $('controller-setup');
setupSelect.disabled = true;
for (const config of rigProfiles) setupSelect.add(new Option(config.shortName || config.name, config.id));
const unsubscribe = window.viewer.onInput(input);
const [initial] = await Promise.all([window.viewer.state(), chooseFirstController()]);
function openControllerScene() {
  rig?.dispose();
  rig = null;
  $('scene-status').hidden = false;
  $('scene-status').textContent = 'Loading controller models…';
  try {
    rig = createRig($('rig-canvas'), {
      profile: controllerSetup,
      scanDevices: initial.scanDevicesByRig?.[controllerSetup.id] ?? initial.scanDevices,
      initialPlacement: setup.placement,
      initialPedals: pedalsEnabled(),
      onReady() {
        $('scene-status').hidden = true;
        labelRig();
      },
      onError: error => sceneUnavailable('3D view unavailable. ' + (error?.message || error)),
      onContextLost: () => sceneUnavailable('3D rendering was interrupted.'),
      onEdit(device, key) {
        const item = controlById.get(device + ':' + key);
        if (!item || loading || editSession.saving || reference) return;
        selectControl(item.id, 'label-edit');
        if (!editSession.active) editSession.open();
        else $('editor-search').focus({ preventScroll: true });
      },
      onSelect(device, key) {
        const item = controlById.get(device + ':' + key);
        if (item) selectControl(item.id);
      },
    });
    rig.setVisible(page === 'rig');
  } catch (error) {
    sceneUnavailable('3D view unavailable. ' + error.message);
  }
}
renderControllerSetup();
openControllerScene();
setupSelect.onchange = async () => {
  const next = rigForId(setupSelect.value);
  if (controllerSetup === next) return;
  setupSelect.value = controllerSetup.id;
  if (editSession.saving || nextLaunch.writing) return;
  setupSelect.disabled = true;
  try {
    if (editSession.active && !(await editSession.requestClose())) return;
    ++requestId;
    controllerSetup = next;
    setup.rigId = next.id;
    rememberSetup();
    profile = blank();
    sourceId = 'blank';
    loading = true;
    handoff.show(null);
    clearAxis();
    wheelPositions.clear();
    observed = selected = null;
    focus = 'all';
    renderControllerSetup();
    openControllerScene();
    rebuild();
    await loadControllerLayout();
  } finally {
    setupSelect.disabled = false;
  }
};
document.addEventListener('visibilitychange', () => {
  monitor.setVisible(page === 'monitor' && !document.hidden);
  if (document.hidden) { clearAxis(); return; }
  if (page === 'rig') refreshSelection();
  if (page !== 'monitor') renderBindings();
});
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  unsubscribe?.();
  clearAxis();
  monitor.dispose();
  rig?.dispose();
});
livePath = initial.livePath;
compatibilityMode = Boolean(initial.compatibilityMode);
streamStatus = initial.status;
receiveDevices(initial.devices);
monitor.setStatus(streamStatus);
await loadControllerLayout();
setupSelect.disabled = false;
if (initial.startEditing && !sourceError) $('edit-layout').click();
