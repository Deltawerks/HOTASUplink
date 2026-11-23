import { normalizeActivationMode } from './binding-gesture.mjs';

const unitName = { left: 'Left stick', right: 'Right stick', sem: 'GNX SEM', pedals: 'Rudder pedals', unknown: 'Saved input' };
const keyFor = (action) => JSON.stringify([action.context, action.action]);
const titleFor = (action) => action.label || action.action;
const contextFor = (action) => action.contextLabel || action.context || 'Other actions';

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function button(text, className, id) {
  const el = node('button', className, text);
  el.type = 'button';
  if (id) el.id = id;
  return el;
}

function routeText(route) {
  if (!route?.slot || !route?.input) return '';
  return 'JS' + route.slot + ' / ' + route.input.replace(/^button(\d+)$/i, 'B$1').toUpperCase();
}

function gestureText(row, input = row.input) {
  const taps = Number(row.multiTap) || 1;
  const mode = row.activationMode || '';
  const normalized = normalizeActivationMode(mode);
  const modeLabel = normalized === 'onhold' ? 'Hold' : mode.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ').toLowerCase().replace(/^./, first => first.toUpperCase());
  if (taps > 1) {
    const count = taps === 2 ? 'Double tap' : taps + ' taps';
    return normalized === 'press' || modeLabel === count ? count : count + ' + ' + modeLabel;
  }
  if (normalized !== 'press') return modeLabel;
  if (!mode && row.gesture) return row.gesture;
  return /^(?:[xyz]|rot[xyz]|r[xyz]|slider\d+)$/i.test(input || '') ? 'Axis' : 'Tap';
}

function searchText(value) {
  return value.toLowerCase().replace(/[_\-]+/g, ' ').trim();
}

function messageFor(error) {
  return (error?.message || String(error)).replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i, '');
}

function sameBinding(a, b) {
  return a && b && a.slot === b.slot && a.input === b.input &&
    (a.activationMode || '') === (b.activationMode || '') && (Number(a.multiTap) || 1) === (Number(b.multiTap) || 1);
}

function savedLayout(id, profileName) {
  const filename = id.slice('export:'.length);
  const fileLabel = /^layout_(.+)_exported\.xml$/i.exec(filename)?.[1] || filename.replace(/\.xml$/i, '');
  const name = profileName && profileName !== filename ? profileName : fileLabel;
  return { id, filename, fileLabel, name };
}

export function createEditor({ onToggle, onAssign, onRemove, onSave, onListLayouts, onLayoutRevision, onUndo, onPick, onSlot, onPrevious, onCapture, onFlow, onChooseDestination }) {
  const toggle = document.getElementById('edit-layout');
  const host = document.getElementById('layout-editor');
  const state = {
    editing: false, flow: 'control', control: null, route: null, actions: [], bindings: [], changes: [],
    sourceName: '', saveLocation: '', busy: false, catalogError: '', preview: null, previous: null,
  };
  let pending = false;
  let draftClose = null;
  let currentSave = null;
  let nameEdited = false;
  let saveTargets = [];
  let loadingTargets = false;
  let listRequest = 0;
  let replacement = null;
  let catalog = [];
  let byAction = new Map();
  const title = node('h2', '', 'Binding editor');
  const top = node('div', 'editor-banner');
  const cancel = button('Cancel editing', 'text-button', 'editor-cancel');
  top.append(title, cancel);
  const order = node('div', 'editor-order');
  order.setAttribute('role', 'group');
  order.setAttribute('aria-label', 'Choose binding order');
  const controlFirst = button('Control first', '', 'editor-control-first');
  const actionFirst = button('Action first', '', 'editor-action-first');
  order.append(controlFirst, actionFirst);
  const layout = node('div', 'editor-main');

  const targetPane = node('section', 'editor-target');
  const physical = node('h3', 'editor-control-name');
  physical.id = 'editor-control';
  const destination = node('p', 'editor-destination');
  destination.id = 'editor-route';
  const targetRows = node('ul', 'editor-binding-list');
  const assignments = node('details', 'editor-disclosure');
  const assignmentTitle = node('summary', '');
  assignments.append(assignmentTitle, targetRows);
  const routeDetails = node('details', 'editor-disclosure');
  const routing = node('div', 'editor-routing');
  routeDetails.append(node('summary', '', 'Joystick routing'), routing);
  const chooseDestination = button('Choose another control', 'text-button', 'editor-choose-control');
  targetPane.append(physical, destination, chooseDestination, routeDetails, assignments);

  const actionPane = node('section', 'editor-actions');
  const searchLabel = node('label', 'editor-field-label', 'Find a game action');
  const search = node('input', 'editor-search');
  search.type = 'search';
  search.id = 'editor-search';
  searchLabel.htmlFor = search.id;
  search.placeholder = 'Search actions or flight contexts';
  search.autocomplete = 'off';
  search.spellcheck = false;
  const searchField = node('div', 'editor-search-field');
  const clearSearch = button('Clear', 'text-button', 'editor-clear-search');
  clearSearch.setAttribute('aria-label', 'Clear action search');
  searchField.append(search, clearSearch);
  const matchCount = node('span', 'editor-match-count');
  const fieldHead = node('div', 'editor-field-head');
  fieldHead.append(searchLabel, matchCount);
  const choices = node('select', 'editor-results');
  choices.id = 'editor-actions';
  choices.size = 5;
  choices.setAttribute('aria-label', 'Matching game actions');
  const empty = node('p', 'editor-no-results');
  const preview = node('div', 'editor-preview');
  preview.id = 'editor-preview';
  const assign = button('Assign', 'editor-primary', 'editor-assign');
  const review = node('section', 'editor-review');
  review.append(preview, assign);
  actionPane.append(fieldHead, searchField, choices, empty);
  layout.append(targetPane, actionPane, review);

  const draft = node('section', 'editor-draft');
  const draftTitle = node('span', 'editor-staged-count');
  draftTitle.id = 'editor-staged-count';
  draftTitle.setAttribute('role', 'status');
  const changeDetails = node('details', 'editor-disclosure');
  const changes = node('ul', 'editor-changes');
  changes.id = 'editor-changes';
  changeDetails.append(node('summary', '', 'Review staged changes'), changes);
  const status = node('p', 'editor-feedback');
  status.setAttribute('role', 'status');
  const bottom = node('div', 'editor-bottom');
  const undo = button('Undo last', 'text-button', 'editor-undo');
  const save = button('Save layout for Star Citizen…', 'editor-primary', 'editor-save');
  const draftTools = node('div', 'editor-draft-tools');
  draftTools.append(draftTitle, undo);
  bottom.append(draftTools, save);
  draft.append(changeDetails, status);
  const scroll = node('div', 'editor-scroll');
  scroll.append(layout, draft);
  host.replaceChildren(top, order, scroll, bottom);
  toggle.setAttribute('aria-controls', host.id);

  const dialog = node('dialog', 'editor-dialog');
  const dialogTitle = node('h2', '');
  dialogTitle.id = 'editor-dialog-title';
  dialog.setAttribute('aria-labelledby', dialogTitle.id);
  const dialogHead = node('div', 'dialog-head');
  dialogHead.append(dialogTitle);
  const form = node('form', 'editor-dialog-body');
  const summary = node('p', 'editor-dialog-summary');
  const field = node('label', 'editor-name-label', 'Layout name');
  const name = node('input', 'editor-name');
  name.type = 'text';
  name.id = 'editor-layout-name';
  name.autocomplete = 'off';
  const suggestions = node('datalist');
  suggestions.id = 'editor-saved-layouts';
  name.setAttribute('list', suggestions.id);
  field.append(name);
  const location = node('p', 'editor-path');
  const error = node('p', 'editor-form-error');
  error.setAttribute('role', 'alert');
  const controls = node('div', 'editor-dialog-buttons');
  const back = button('Cancel', 'editor-secondary');
  const confirm = button('', 'editor-primary');
  confirm.type = 'submit';
  controls.append(back, confirm);
  form.append(summary, field, suggestions, location, error, controls);
  dialog.append(dialogHead, form);
  document.body.append(dialog);

  function report(err) { status.textContent = messageFor(err); }
  function selectedAction() { return byAction.get(choices.value); }
  function setCatalog() {
    catalog = (state.actions || []).map((action) => {
      const label = searchText(titleFor(action));
      const alias = action.action === 'v_atc_request' ? 'ask to land request landing clearance ATC contact tower' : '';
      const direct = searchText([label, action.action, alias].join(' '));
      const searchable = direct + ' ' + searchText([contextFor(action), action.context].join(' '));
      return { action, label, direct, searchable };
    }).sort((a, b) => contextFor(a.action).localeCompare(contextFor(b.action)) || titleFor(a.action).localeCompare(titleFor(b.action)));
    byAction = new Map(catalog.map(({ action }) => [keyFor(action), action]));
  }

  function showChoices() {
    const old = choices.value;
    const words = searchText(search.value).split(/\s+/).filter(Boolean);
    // A context such as "Vehicles - Missiles" contains unrelated actions. Keep
    // those discoverable after actions whose own label, ID or alias matches.
    const ranks = [new Map(), new Map(), new Map(), new Map()];
    let count = 0;
    for (const { action, label, direct, searchable } of catalog) {
      if (!words.every((word) => searchable.includes(word))) continue;
      const rank = words.every(word => label.includes(word)) ? 0 : words.every(word => direct.includes(word)) ? 1
        : words.some(word => direct.includes(word)) ? 2 : 3;
      const groups = ranks[rank];
      const context = contextFor(action);
      let group = groups.get(context);
      if (!group) { group = document.createElement('optgroup'); group.label = context; groups.set(context, group); }
      const option = node('option', '', titleFor(action));
      option.value = keyFor(action);
      group.append(option);
      count++;
    }
    choices.replaceChildren(...ranks.flatMap(groups => [...groups.values()]));
    choices.value = old;
    choices.hidden = count === 0;
    empty.hidden = count !== 0;
    empty.textContent = (state.catalogError && messageFor(state.catalogError)) || (catalog.length ? 'No matching actions.' :
      state.busy || !state.actions ? 'Reading the action catalog…' : 'No game actions available.');
    matchCount.textContent = count === 1 ? '1 action' : count + ' actions';
    clearSearch.hidden = !search.value;
    showPreview();
  }

  function showControl() {
    const control = state.control;
    const initialActionStep = state.flow === 'action' && !state.pickedAction;
    targetPane.hidden = initialActionStep;
    targetPane.classList.toggle('awaiting-control', Boolean(state.waitingForTarget));
    physical.textContent = control ? (unitName[control.device] || 'Joystick') + ' · ' + control.label : 'Choose a physical control';
    destination.textContent = control ? (state.route?.ok ? routeText(state.route) : state.route?.reason || 'Choose the destination joystick slot.')
      : 'Press a button, move a hat, or select a control on the model or binding sheet.';
    chooseDestination.hidden = !(state.flow === 'action' && control);
    const needsRouting = control && (state.route?.needsSlot || state.route?.needsCapture);
    const routeControl = control?.id || '';
    if (routeDetails.dataset.control !== routeControl || needsRouting) routeDetails.open = Boolean(needsRouting);
    const rows = state.route?.assignedRows || control?.rows || [];
    if (assignments.dataset.control !== routeControl || assignments.hidden) {
      assignments.open = rows.length > 0 && state.flow === 'control';
    }
    routeDetails.dataset.control = assignments.dataset.control = routeControl;
    routeDetails.hidden = !control || (!state.route?.ok && !needsRouting);
    routing.replaceChildren();
    if (control && state.route?.ok && state.route.reason) routing.append(node('p', 'editor-destination', state.route.reason));
    if (control && onSlot && state.route?.slotOptions?.length) {
      const field = node('label', 'editor-routing-field', 'Destination slot');
      const slots = node('select', '');
      slots.setAttribute('aria-label', 'Destination joystick slot');
      const prompt = node('option', '', 'Choose a joystick slot');
      prompt.value = '';
      slots.append(prompt);
      for (const option of state.route.slotOptions) {
        const fullName = option.label || 'JS' + option.slot;
        const displayName = fullName.replace(/\s*\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\}\s*$/i, '');
        const el = node('option', '', displayName);
        el.title = fullName;
        el.value = String(option.slot);
        slots.append(el);
      }
      slots.value = String(state.route.slot || '');
      slots.addEventListener('change', () => { if (slots.value) onSlot(Number(slots.value)); });
      field.append(slots);
      routing.append(field);
    }
    if (control && state.route?.needsCapture && onCapture) {
      const capture = button(state.capturing ? 'Cancel capture' : 'Capture physical input', 'editor-secondary', 'editor-capture');
      if (state.capturing) routing.append(node('p', 'editor-destination', 'Move or press the selected physical control now.'));
      capture.addEventListener('click', () => onCapture());
      routing.append(capture);
    }
    targetRows.replaceChildren();
    assignments.hidden = rows.length === 0;
    assignmentTitle.textContent = rows.length === 1 ? '1 current assignment' : rows.length + ' current assignments';
    if (!control) return;
    for (const row of rows) {
      const li = node('li', '');
      const label = node('div', '');
      label.append(node('strong', '', titleFor(row)),
        node('small', '', [contextFor(row), gestureText(row), routeText(row)].filter(Boolean).join(' · ')));
      li.append(label);
      if (onRemove && state.flow === 'control') {
        const remove = button('Remove', 'editor-secondary');
        remove.title = 'Remove ' + titleFor(row) + ' from ' + routeText(row);
        remove.disabled = Boolean(state.busy);
        remove.addEventListener('click', () => {
          if (pending || state.busy) return;
          try {
            onRemove(row, control);
            status.textContent = titleFor(row) + ' removal staged.';
          } catch (err) { report(err); }
        });
        li.append(remove);
      }
      targetRows.append(li);
    }
  }

  function showPreview() {
    const action = selectedAction();
    const priorFocus = preview.contains(document.activeElement) ? document.activeElement.id : '';
    const priorMove = preview.querySelector('#editor-move-input');
    preview.replaceChildren();
    assign.textContent = 'Assign';
    review.hidden = !action;
    if (action) {
      const info = state.preview;
      const current = info?.before || (state.bindings || []).filter((route) => route.context === action.context && route.action === action.action);
      const inputs = [...new Set(current.map(routeText).filter(Boolean))];
      const target = state.route?.ok ? routeText(state.route) : '';
      const atTarget = target ? (info?.after || current).filter(row => routeText(row) === target) : [];
      const gestures = atTarget.length ? [...new Set(atTarget.map(row => gestureText(row)))] :
        [gestureText(state.previous || action, state.route?.input)];
      preview.append(node('strong', '', titleFor(action) + ' · ' + gestures.join(' / ')), node('small', '', contextFor(action)));
      const otherInputs = current.filter(route => routeText(route) !== target);
      if (target) {
        assign.textContent = state.previous ? 'Move binding' : current.length ? 'Add input' : 'Assign';
        preview.append(node('p', 'editor-route-preview', 'Assign to ' + target));
        if (info?.ok && info.conflicts?.length) {
          for (const row of info.conflicts) {
            preview.append(node('p', '', 'Removes ' + titleFor(row) + ' · ' + gestureText(row) + ' from ' + routeText(row)));
          }
          assign.textContent = 'Replace assignment';
        }
      } else if (inputs.length) preview.append(node('p', '', 'Currently on ' + inputs.join(', ')));
      if (target && otherInputs.length && onPrevious) {
        const routes = [...new Set(otherInputs.map(routeText))].join(', ');
        preview.append(node('p', '', state.previous ? 'Moving from ' + routeText(state.previous) : 'Also on ' + routes));
        const details = node('details', 'editor-disclosure');
        details.id = 'editor-move-input';
        details.dataset.key = JSON.stringify([keyFor(action), target]);
        details.open = priorMove?.dataset.key === details.dataset.key && priorMove.open;
        const summary = node('summary', '', 'Move an existing input');
        summary.id = 'editor-move-toggle';
        const field = node('label', 'editor-routing-field', 'Existing inputs for this action');
        const pick = node('select', '');
        pick.id = 'editor-previous';
        const keep = node('option', '', 'Keep ' + routes);
        keep.value = '';
        pick.append(keep);
        let selected = '';
        otherInputs.forEach((route, index) => {
          const option = node('option', '', 'Move from ' + routeText(route) + ' · ' + gestureText(route));
          option.value = String(index);
          if (sameBinding(route, state.previous)) selected = option.value;
          pick.append(option);
        });
        pick.value = selected;
        pick.addEventListener('change', () => {
          onPrevious(pick.value === '' ? null : otherInputs[Number(pick.value)]);
        });
        field.append(pick);
        details.append(summary, field);
        preview.append(details);
      }
      const reason = state.route && !state.route.ok ? state.route.reason : info?.reason;
      if (reason && !info?.ok) preview.append(node('p', 'editor-warning', reason));
      else if (!state.control && state.waitingForTarget) preview.append(node('p', '', 'Press a control or click it on the model to choose the destination.'));
    }
    if (priorFocus) preview.querySelector('#' + priorFocus)?.focus({ preventScroll: true });
    assign.disabled = pending || state.busy || !action || !state.control || !routeText(state.route) || state.route?.ok === false ||
      state.preview?.ok === false || Boolean(onPick && !state.preview);
  }

  function showDraft() {
    const count = state.changes.length;
    draftTitle.textContent = count === 1 ? '1 staged change' : count + ' staged changes';
    changeDetails.hidden = count === 0;
    bottom.classList.toggle('has-staged-changes', count > 0);
    changes.replaceChildren(...state.changes.map((change) => {
      const row = node('li', '');
      const label = node('div', '');
      label.append(node('strong', '', (change.removed ? 'Remove ' : '') + titleFor(change)), node('small', '',
        [change.contextLabel || change.context, change.routeLabel || routeText(change)].filter(Boolean).join(' · ')));
      row.append(label);
      return row;
    }));
  }

  function buttons() {
    toggle.disabled = Boolean(pending || state.busy);
    cancel.disabled = Boolean(pending || state.busy);
    save.disabled = Boolean(pending || state.busy);
    undo.hidden = !onUndo;
    undo.disabled = !state.changes.length || Boolean(pending || state.busy);
    controlFirst.disabled = actionFirst.disabled = chooseDestination.disabled = Boolean(pending || state.busy);
    search.disabled = choices.disabled = Boolean(pending || state.busy);
    back.disabled = Boolean(pending);
    if (dialog.open && dialog.dataset.kind === 'save') showSaveDestination();
    else confirm.disabled = Boolean(pending);
    name.readOnly = pending;
    toggle.setAttribute('aria-pressed', String(Boolean(state.editing)));
    toggle.textContent = state.editing ? 'Editing layout' : 'Edit layout';
    showPreview();
  }

  function matchingSaveTargets() {
    const value = name.value.trim().toLowerCase();
    if (!value) return [];
    if (!nameEdited && currentSave?.name.toLowerCase() === value) return [currentSave];
    const exact = saveTargets.find(layout => layout.filename.toLowerCase() === value);
    if (exact) return [exact];
    return saveTargets.filter(layout => layout.name.toLowerCase() === value || layout.fileLabel.toLowerCase() === value);
  }

  function showSaveDestination() {
    const matches = matchingSaveTargets();
    const target = matches[0];
    const current = target && target.id === currentSave?.id;
    dialogTitle.textContent = replacement ? 'Replace saved layout?' : 'Save layout';
    field.hidden = Boolean(replacement);
    back.textContent = replacement ? 'Back' : 'Cancel';
    if (replacement) {
      summary.textContent = 'Replace ' + replacement.layout.filename + ' with the layout you are editing?';
      confirm.textContent = 'Replace layout';
    } else if (matches.length > 1) {
      summary.textContent = 'Several layouts use this name. Choose ' + matches.map(layout => layout.filename).join(' or ') + '.';
      confirm.textContent = 'Review replacement';
    } else if (current) {
      summary.textContent = 'Save your changes to ' + currentSave.filename + '. Enter a different name to save a copy.';
      confirm.textContent = 'Save changes';
    } else if (target) {
      summary.textContent = target.filename + ' already exists. Review the replacement before saving.';
      confirm.textContent = 'Review replacement';
    } else {
      summary.textContent = 'Save a named copy of ' + (state.sourceName || 'this layout') + '.';
      confirm.textContent = 'Save new layout';
    }
    confirm.disabled = Boolean(pending || matches.length > 1 || (loadingTargets && (!current || nameEdited)));
  }

  async function loadSaveTargets() {
    const request = ++listRequest;
    loadingTargets = true;
    showSaveDestination();
    try {
      const sources = await onListLayouts();
      if (request !== listRequest) return;
      const otherLayouts = sources.filter(s => s.kind === 'export' && s.id !== currentSave?.id).map(s => savedLayout(s.id));
      saveTargets = currentSave ? [currentSave, ...otherLayouts] : otherLayouts;
      const counts = new Map();
      for (const layout of saveTargets) {
        const aliases = new Set([layout.name.toLowerCase(), layout.fileLabel.toLowerCase(), layout.filename.toLowerCase()]);
        for (const alias of aliases) counts.set(alias, (counts.get(alias) || 0) + 1);
      }
      suggestions.replaceChildren(...saveTargets.map(layout => {
        const option = node('option');
        option.value = counts.get(layout.name.toLowerCase()) > 1 ? layout.filename : layout.name;
        option.label = layout.filename;
        return option;
      }));
    } catch (err) {
      if (request === listRequest && !error.textContent) error.textContent = messageFor(err);
    } finally {
      if (request === listRequest) {
        loadingTargets = false;
        showSaveDestination();
      }
    }
  }

  function openDialog(kind) {
    const saving = kind === 'save';
    dialog.dataset.kind = kind;
    const count = state.changes.length;
    const changeText = count === 1 ? '1 staged change' : count + ' staged changes';
    name.required = saving;
    field.hidden = !saving;
    location.hidden = !saving || !state.saveLocation;
    location.textContent = state.saveLocation || '';
    error.textContent = '';
    replacement = null;
    if (saving) {
      currentSave = state.sourceId?.startsWith('export:') ? savedLayout(state.sourceId, state.sourceName) : null;
      nameEdited = false;
      saveTargets = currentSave ? [currentSave] : [];
      suggestions.replaceChildren();
      name.value = currentSave?.name || '';
      name.placeholder = 'Type a name or choose a saved layout';
      void loadSaveTargets();
    } else {
      dialogTitle.textContent = 'Discard staged changes?';
      summary.textContent = 'Closing the editor will discard ' + changeText + '.';
      back.textContent = 'Keep editing';
      confirm.textContent = 'Discard changes';
      confirm.disabled = false;
    }
    dialog.showModal();
    if (saving) { name.focus(); name.select(); } else back.focus();
  }

  async function closeEditor() {
    try { await onToggle(false); return true; }
    catch (err) { report(err); return false; }
  }

  function requestClose() {
    if (!state.editing) return Promise.resolve(true);
    if (draftClose) return draftClose.promise;
    if (dialog.open || pending || state.busy) return Promise.resolve(false);
    if (!state.changes.length) return closeEditor();
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    draftClose = { promise, resolve };
    openDialog('discard');
    return promise;
  }

  function handleDialogClose() {
    if (dialog.open) return;
    listRequest++;
    loadingTargets = false;
    if (draftClose) {
      const { resolve } = draftClose;
      draftClose = null;
      resolve(false);
    }
  }
  dialog.addEventListener('close', handleDialogClose);
  dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
  back.addEventListener('click', () => {
    if (!replacement) { dialog.close(); return; }
    replacement = null;
    error.textContent = '';
    showSaveDestination();
    name.focus();
  });
  name.addEventListener('input', () => {
    nameEdited = true;
    error.textContent = '';
    showSaveDestination();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || confirm.disabled) return;
    error.textContent = '';
    if (dialog.dataset.kind === 'discard') {
      const confirmation = draftClose;
      draftClose = null;
      dialog.close();
      confirmation?.resolve(await closeEditor());
      return;
    }
    const value = name.value.trim();
    if (!value) { error.textContent = 'Enter a layout name.'; name.focus(); return; }
    const target = replacement?.layout || matchingSaveTargets()[0];
    pending = true;
    buttons();
    try {
      if (target && target.id !== currentSave?.id && !replacement) {
        const revision = await onLayoutRevision(target.id);
        replacement = { layout: target, revision };
        showSaveDestination();
        return;
      }
      const overwrite = target ? {
        sourceId: target.id,
        expectedRevision: replacement ? replacement.revision : state.sourceRevision,
      } : null;
      await onSave(target?.name || value, overwrite);
      if (dialog.open) dialog.close();
    } catch (err) {
      error.textContent = messageFor(err);
      replacement = null;
      void loadSaveTargets();
      name.focus();
    } finally {
      pending = false;
      buttons();
      if (replacement && dialog.open) confirm.focus();
    }
  });
  async function handleToggle() {
    if (state.editing) { await requestClose(); return; }
    try { await onToggle(true); } catch (err) { report(err); }
  }
  toggle.addEventListener('click', handleToggle);
  cancel.addEventListener('click', requestClose);
  controlFirst.addEventListener('click', () => onFlow?.('control'));
  actionFirst.addEventListener('click', () => onFlow?.('action'));
  chooseDestination.addEventListener('click', () => onChooseDestination?.());
  function changeQuery() {
    const previous = selectedAction();
    status.textContent = '';
    choices.selectedIndex = -1;
    showChoices();
    choices.scrollTop = 0;
    if (previous) onPick?.(null);
  }
  search.addEventListener('input', changeQuery);
  clearSearch.addEventListener('click', () => { search.value = ''; changeQuery(); search.focus(); });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' || choices.hidden) return;
    event.preventDefault();
    if (choices.selectedIndex < 0) choices.selectedIndex = 0;
    choices.focus();
    onPick?.(selectedAction() || null);
    showPreview();
  });
  choices.addEventListener('change', () => { status.textContent = ''; onPick?.(selectedAction() || null); showPreview(); });
  assign.addEventListener('click', async () => {
    if (assign.disabled) return;
    const action = selectedAction(), control = state.control;
    pending = true;
    status.textContent = '';
    buttons();
    try {
      await onAssign(action, control);
      status.textContent = titleFor(action) + ' staged for ' + control.label + '.';
    } catch (err) { report(err); }
    finally { pending = false; buttons(); }
  });
  save.addEventListener('click', () => { if (!dialog.open) openDialog('save'); });
  undo.addEventListener('click', async () => {
    try { await onUndo?.(); status.textContent = ''; } catch (err) { report(err); }
  });

  function setState(next) {
    const entering = next.editing === true && !state.editing;
    const leaving = next.editing === false && state.editing;
    const flowChanges = Object.hasOwn(next, 'flow') && state.flow !== next.flow;
    const catalogChanges = Object.hasOwn(next, 'actions') && next.actions !== state.actions;
    const catalogStatusChanges = (Object.hasOwn(next, 'catalogError') && next.catalogError !== state.catalogError) ||
      (Object.hasOwn(next, 'busy') && next.busy !== state.busy && !catalog.length);
    const controlChanges = Object.hasOwn(next, 'control') || Object.hasOwn(next, 'route');
    const draftChanges = Object.hasOwn(next, 'changes');
    Object.assign(state, next);
    host.hidden = !state.editing;
    if (entering || leaving || flowChanges) {
      search.value = '';
      if (entering || leaving) name.value = '';
      choices.selectedIndex = -1;
      status.textContent = '';
      if (leaving && dialog.open) dialog.close();
    }
    if (flowChanges || entering) {
      const actionLeads = state.flow === 'action';
      layout.replaceChildren(...(actionLeads ? [actionPane, targetPane] : [targetPane, actionPane]), review);
      controlFirst.setAttribute('aria-pressed', String(!actionLeads));
      actionFirst.setAttribute('aria-pressed', String(actionLeads));
      scroll.scrollTop = 0;
    }
    if (catalogChanges) setCatalog();
    if (entering || flowChanges || catalogChanges || catalogStatusChanges) showChoices();
    if (Object.hasOwn(next, 'pickedAction')) choices.value = next.pickedAction ? keyFor(next.pickedAction) : '';
    if (entering || flowChanges || controlChanges || Object.hasOwn(next, 'pickedAction')) showControl();
    if (entering || draftChanges) showDraft();
    buttons();
    if (entering || (flowChanges && state.flow === 'action')) search.focus({ preventScroll: true });
  }
  setState({});
  return {
    setState, requestClose,
    dispose() {
      toggle.removeEventListener('click', handleToggle);
      if (dialog.open) dialog.close();
      handleDialogClose();
      dialog.remove();
      host.replaceChildren();
    },
  };
}
