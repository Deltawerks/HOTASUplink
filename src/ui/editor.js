const unitName = { left: 'Left stick', right: 'Right stick', sem: 'GNX SEM', unknown: 'Saved input' };
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

export function createEditor({ onToggle, onAssign, onSave, onUndo, onPick, onSlot, onPrevious, onConflict, onCapture, onFlow, onChooseDestination }) {
  const toggle = document.getElementById('edit-layout');
  const host = document.getElementById('layout-editor');
  const state = {
    editing: false, flow: 'control', control: null, route: null, actions: [], bindings: [], changes: [],
    sourceName: '', saveLocation: '', busy: false, catalogError: '', preview: null, previous: null, conflictChoice: null,
  };
  let pending = false;
  let draftClose = null;
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
  field.append(name);
  const location = node('p', 'editor-path');
  const error = node('p', 'editor-form-error');
  error.setAttribute('role', 'alert');
  const controls = node('div', 'editor-dialog-buttons');
  const back = button('Cancel', 'editor-secondary');
  const confirm = button('', 'editor-primary');
  confirm.type = 'submit';
  controls.append(back, confirm);
  form.append(summary, field, location, error, controls);
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
    if (assignments.dataset.control !== routeControl) assignments.open = false;
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
    const rows = control?.rows || [];
    assignments.hidden = rows.length === 0;
    assignmentTitle.textContent = rows.length === 1 ? '1 current assignment' : rows.length + ' current assignments';
    if (!control) return;
    for (const row of rows) {
      const li = node('li', '');
      li.append(node('strong', '', titleFor(row)),
        node('small', '', [contextFor(row), row.gesture, routeText(row)].filter(Boolean).join(' · ')));
      targetRows.append(li);
    }
  }

  function showPreview() {
    const action = selectedAction();
    const priorFocus = preview.contains(document.activeElement) ? document.activeElement.id : '';
    preview.replaceChildren();
    review.hidden = !action;
    if (action) {
      const info = state.preview;
      const current = info?.before || (state.bindings || []).filter((route) => route.context === action.context && route.action === action.action);
      const inputs = [...new Set(current.map(routeText).filter(Boolean))];
      preview.append(node('strong', '', titleFor(action)), node('small', '', contextFor(action)));
      const target = routeText(state.route);
      if (target) {
        const prior = state.previous && state.previous !== 'add' ? state.previous : current.length === 1 ? current[0] : null;
        let operation = 'Destination · ' + target;
        if (state.previous === 'add') operation = 'Add ' + target + ' as another input';
        else if (prior) operation = 'Move ' + routeText(prior) + ' → ' + target;
        else if (!current.length) operation = 'Assign to ' + target;
        preview.append(node('p', 'editor-route-preview', operation));
      } else if (inputs.length) preview.append(node('p', '', 'Currently on ' + inputs.join(', ')));
      if (target && current.length > 1 && onPrevious) {
        const field = node('label', 'editor-routing-field', 'Input to move');
        const pick = node('select', '');
        pick.id = 'editor-previous';
        const none = node('option', '', 'Choose an existing input');
        none.value = '';
        pick.append(none);
        const additional = node('option', '', 'Add another input');
        additional.value = 'add';
        pick.append(additional);
        let selected = state.previous === 'add' ? 'add' : '';
        current.forEach((route, index) => {
          const gesture = route.gesture || (Number(route.multiTap) > 1 ? route.multiTap + ' taps' : route.activationMode);
          const option = node('option', '', [routeText(route), gesture].filter(Boolean).join(' · '));
          option.value = String(index);
          if (sameBinding(route, state.previous)) selected = option.value;
          pick.append(option);
        });
        pick.value = selected;
        pick.addEventListener('change', () => {
          if (pick.value === 'add') onPrevious('add');
          else onPrevious(pick.value === '' ? null : current[Number(pick.value)]);
        });
        field.append(pick);
        preview.append(field);
      }
      if (info?.conflicts?.length) {
        const field = node('fieldset', 'editor-conflicts');
        field.append(node('legend', '', 'Same-context assignments'));
        field.append(node('p', '', [...new Set(info.conflicts.map(titleFor))].join(' · ')));
        for (const [value, text] of [['keep', 'Keep both'], ['replace', 'Replace conflicting assignments']]) {
          const label = node('label', '');
          const radio = node('input', '');
          radio.type = 'radio';
          radio.name = 'editor-overlap';
          radio.id = 'editor-conflict-' + value;
          radio.value = value;
          radio.checked = state.conflictChoice === value;
          radio.addEventListener('change', () => { if (radio.checked) onConflict?.(value); });
          label.append(radio, document.createTextNode(text));
          field.append(label);
        }
        preview.append(field);
      }
      if (info?.reason && !info.ok && !info.needsConflictChoice && !info.needsPrevious) preview.append(node('p', 'editor-warning', info.reason));
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
      label.append(node('strong', '', titleFor(change)), node('small', '',
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
    confirm.disabled = back.disabled = Boolean(pending);
    name.readOnly = pending;
    toggle.setAttribute('aria-pressed', String(Boolean(state.editing)));
    toggle.textContent = state.editing ? 'Editing layout' : 'Edit layout';
    showPreview();
  }

  function openDialog(kind) {
    const saving = kind === 'save';
    dialog.dataset.kind = kind;
    dialogTitle.textContent = saving ? 'Save a new layout' : 'Discard staged changes?';
    const count = state.changes.length;
    const changeText = count === 1 ? '1 staged change' : count + ' staged changes';
    summary.textContent = saving
      ? 'Create a named copy of ' + (state.sourceName || 'this layout') + (count ? ' with ' + changeText : '') + '.'
      : 'Closing the editor will discard ' + changeText + '.';
    name.required = saving;
    field.hidden = !saving;
    location.hidden = !saving || !state.saveLocation;
    location.textContent = state.saveLocation || '';
    error.textContent = '';
    back.textContent = saving ? 'Cancel' : 'Keep editing';
    confirm.textContent = saving ? 'Save new layout' : 'Discard changes';
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
    if (draftClose) {
      const { resolve } = draftClose;
      draftClose = null;
      resolve(false);
    }
  }
  dialog.addEventListener('close', handleDialogClose);
  dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
  back.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
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
    pending = true;
    buttons();
    try {
      await onSave(value);
      if (dialog.open) dialog.close();
    } catch (err) {
      error.textContent = messageFor(err);
      name.focus();
    } finally {
      pending = false;
      buttons();
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
