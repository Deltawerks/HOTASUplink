import { createEditor } from './editor.js';
import { isPedalToeAxis } from './bindings.mjs';
import { applyDraft, draftDevices, previewEdit, resolveTarget, saveEdits, stageEdit } from './edit-draft.mjs';

function routeSignature(rows = []) {
  return JSON.stringify(rows.map(row => JSON.stringify([
    row.context, row.action, row.slot, row.input, Number(row.multiTap) || 1, row.activationMode || '',
  ])).sort());
}

export function createEditSession({ context, redraw, onMode, onSaved }) {
  let editing = false;
  let editorVisible = false;
  let saving = false;
  let generation = 0;
  let catalog = null;
  let catalogError = '';
  let draft = null;
  let edits = [];
  let history = [];
  let action = null;
  let flow = 'control';
  let destinationId = null;
  let sourceRoutes = new Map();
  let previous = null;
  let selectedId = null;
  let slots = {};
  let captures = new Map();
  let armed = null;
  const captureOrigins = new Map();

  function clearDestination() {
    destinationId = null;
    armed = null;
    previous = null;
  }

  function waitingForTarget() {
    return editing && !saving && flow === 'action' && Boolean(action) && !destinationId;
  }

  function acceptControl(id, source = 'ui') {
    if (!editing) return true;
    if (saving) return false;
    if (source === 'label-edit' && flow === 'action' && !action) {
      flow = 'control';
      clearDestination();
    }
    if (flow === 'control') return true;
    if (source === 'hardware' && !waitingForTarget()) return false;
    if (action && destinationId !== id) {
      clearDestination();
      destinationId = id;
    }
    return true;
  }

  function chosenControl(control) {
    return flow === 'control' || (action && destinationId === control?.id) ? control : null;
  }

  function hasStagedRoute(item) {
    return Boolean(draft && item && (sourceRoutes.get(item.id) || '[]') !== routeSignature(item.rows));
  }

  function stagedControlIds() {
    if (!draft) return new Set();
    const { sheet, sourceSheet } = context();
    // The same setup must project both layouts if the SEM is hidden or its
    // detents change while editing. Skip source projection for clean layouts.
    if (sourceSheet) sourceRoutes = indexRoutes(sourceSheet());
    return new Set((sheet || []).filter(hasStagedRoute).map(item => item.id));
  }

  function indexRoutes(sheet) {
    return new Map(sheet.filter(item => item.rows?.length).map(item => [item.id, routeSignature(item.rows)]));
  }

  function targetFor(control) {
    const { profile, hardware } = context();
    if (!control) return null;
    return resolveTarget({ control, profile: draft || profile, hardware, slots, capture: captures.get(control.id) });
  }

  function previewFor(target) {
    if (!action || !target?.ok) return null;
    return previewEdit({
      profile: draft || context().profile, action, target,
      mode: previous ? 'replace' : 'add',
      previous,
    });
  }

  function render() {
    const { control: selected, profile, livePath, sourceName, sourceId, loading } = context();
    if (flow === 'action' && destinationId && destinationId !== selected?.id) clearDestination();
    const control = chosenControl(selected);
    const toggle = document.getElementById('edit-layout');
    if (!editing && !editorVisible) {
      toggle.disabled = loading;
      return;
    }
    editorVisible = editing;
    if (selectedId !== control?.id) {
      selectedId = control?.id;
      armed = null;
      previous = null;
    }
    const route = editing ? targetFor(control) : null;
    editor.setState({
      editing, flow, waitingForTarget: waitingForTarget(), control, route, actions: catalog, catalogError, busy: saving,
      preview: previewFor(route), pickedAction: action, previous,
      bindings: (draft || profile).bindings, changes: history.map(h => h.summary),
      sourceName, sourceId, sourceRevision: profile.source.revision,
      saveLocation: livePath.replace(/[\\/]$/, '') + '\\USER\\Client\\0\\Controls\\Mappings',
      capturing: Boolean(armed),
    });
    toggle.disabled = loading || saving;
  }

  function close() {
    generation++;
    editing = false;
    flow = 'control';
    destinationId = null;
    sourceRoutes.clear();
    draft = null;
    edits = [];
    history = [];
    slots = {};
    captures.clear();
    armed = null;
    action = null;
    previous = null;
    onMode(false);
    redraw();
  }

  async function open() {
    const token = ++generation;
    editing = true;
    flow = 'control';
    clearDestination();
    sourceRoutes = indexRoutes(context().sheet || []);
    catalog = null;
    catalogError = '';
    action = null;
    onMode(true);
    redraw();
    try {
      const actions = await window.viewer.actions(context().sourceId);
      if (token !== generation) return;
      const bound = new Set(context().profile.bindings.map(row => row.context + '/' + row.action));
      catalog = actions.filter(row => row.supportsJoystick || bound.has(row.context + '/' + row.action));
    } catch (error) {
      if (token !== generation) return;
      catalogError = error.message;
    }
    render();
  }

  function stage(preview, summary) {
    const start = edits.length;
    const nextEdits = stageEdit(edits, preview);
    const nextDraft = applyDraft(context().profile, nextEdits);
    history.push({ start, summary });
    edits = nextEdits;
    draft = nextDraft;
  }

  function assign(picked, selectedControl) {
    const { control } = context();
    if (saving || !chosenControl(control) || selectedControl?.id !== control.id ||
        action?.context !== picked?.context || action?.action !== picked?.action) return;
    const target = targetFor(control);
    const preview = previewFor(target);
    if (!preview?.ok) return;
    stage(preview, {
      context: action.context, contextLabel: action.contextLabel, action: action.action, label: action.label, slot: target.slot, input: target.input,
    });
    action = null;
    clearDestination();
    redraw();
  }

  function remove(row, selectedControl) {
    const { control, profile } = context();
    if (!editing || saving || !control || selectedControl.id !== control.id) throw new Error('Select the control again.');
    const preview = previewEdit({
      profile: draft || profile, action: row, mode: 'remove',
      previous: { ...row, multiTap: Number(row.multiTap) || 1, activationMode: row.activationMode || '' },
    });
    stage(preview, { ...row, removed: true });
    previous = null;
    redraw();
  }

  function undo() {
    if (saving || !history.length) return;
    edits = edits.slice(0, history.pop().start);
    draft = edits.length ? applyDraft(context().profile, edits) : null;
    previous = null;
    redraw();
  }

  async function save(name, overwrite) {
    if (saving) throw new Error('A layout is already being saved.');
    const { profile, sourceId, livePath } = context();
    saving = true;
    armed = null;
    render();
    let result;
    try {
      result = await window.viewer.saveLayout({
        name, source: sourceId, installation: livePath, expectedRevision: profile.source.revision,
        ...(profile.source.pedalAxes ? { pedalAxes: profile.source.pedalAxes } : {}),
        ...(overwrite ? { overwrite } : {}),
        emptySource: profile.source.kind === 'blank',
        edits: saveEdits(edits), devices: draftDevices(profile, edits),
      });
    } finally {
      saving = false;
      render();
    }
    close();
    await onSaved(result);
    return result;
  }

  const editor = createEditor({
    onListLayouts: () => window.viewer.sources(),
    onLayoutRevision: sourceId => window.viewer.layoutRevision(sourceId, context().livePath),
    onToggle: enabled => enabled ? open() : close(),
    onFlow: next => {
      if (saving || !['control', 'action'].includes(next) || flow === next) return;
      flow = next;
      action = null;
      clearDestination();
      render();
    },
    onChooseDestination: () => { clearDestination(); render(); },
    onPick: picked => {
      if (action?.context === picked?.context && action?.action === picked?.action) return;
      action = picked;
      if (flow === 'action') clearDestination();
      else previous = null;
      render();
    },
    onSlot: slot => {
      const { control } = context();
      if (!control) return;
      slots[targetFor(control)?.slotKey || control.device] = Number(slot);
      previous = null;
      render();
    },
    onCapture: () => { captureOrigins.clear(); armed = armed ? null : context().control?.id; render(); },
    onPrevious: binding => { previous = binding; render(); },
    onUndo: undo, onAssign: assign, onRemove: remove, onSave: save,
  });

  // An armed lever gets its real logical input from the attached controller.
  // Outside that explicit step, analog jitter must not change an editing target.
  function capture(event, mapped) {
    if (!armed) return false;
    const { control, hardware } = context();
    if (control?.id !== armed || !mapped) return true;
    const device = hardware.find(d => d.id === event.id);
    if (!device || !['left', 'right', 'pedals'].includes(mapped.host)) return true;
    if ((control.device === 'pedals') !== (mapped.host === 'pedals')) return true;
    if (control.device === 'sem' && !/\bSEM\b/i.test(device?.name || '')) return true;
    const valid = control.kind === 'axis' ? event.type === 'axis'
      : event.type === 'button' && event.pressed;
    if (!valid) return true;
    if (control.device === 'pedals' && control.needsCapture) {
      if (!isPedalToeAxis(mapped.raw) || mapped.raw === control.otherToeInput || !Number.isFinite(event.value)) return true;
      const baseline = captureOrigins.get(mapped.raw) ?? event.value - (event.delta || 0);
      captureOrigins.set(mapped.raw, baseline);
      if (Math.abs(event.value - baseline) < 0.15) return true;
    }
    captures.set(armed, { device: control.device, host: mapped.host, raw: mapped.raw, controlId: armed });
    armed = null;
    previous = null;
    render();
    return true;
  }

  return {
    get active() { return editing; },
    get draft() { return draft; },
    get dirty() { return saving || edits.length > 0; },
    get saving() { return saving; },
    get waitingForTarget() { return waitingForTarget(); },
    get stagedControlIds() { return stagedControlIds(); },
    open, render, capture, acceptControl, hasStagedRoute,
    requestClose: () => editing ? editor.requestClose() : Promise.resolve(true),
  };
}
