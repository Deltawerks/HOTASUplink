import { Vector3 } from 'three';

const svgNS = 'http://www.w3.org/2000/svg';

function node(tag, className) {
  const result = document.createElement(tag);
  result.className = className;
  return result;
}

function markEdited(element) {
  const badge = node('span', 'rig-edited-marker');
  badge.textContent = 'Edited';
  element.append(badge);
}

function actionDetails(item) {
  return item.actions?.map(action => [action.name, action.context].filter(Boolean).join(' · ')).join('\n') || item.text || 'Unassigned';
}

function referenceValue(element, item) {
  const actions = item.actions || [];
  element.replaceChildren();
  element.classList.toggle('rig-unassigned', !actions.length);
  if (!actions.length) { element.textContent = item.text || 'Unassigned'; return; }
  if (!item.active || !actions.some(action => action.context)) {
    element.textContent = actions[0].name;
    if (actions.length > 1 && !item.active) {
      const count = node('span', 'rig-other-actions');
      count.textContent = ' +' + (actions.length - 1);
      element.append(count);
    } else if (item.active) element.textContent = item.text;
    return;
  }
  for (const action of actions) {
    const line = node('span', 'rig-reference-action');
    line.textContent = action.name;
    if (action.context) {
      const context = node('small', 'rig-action-context');
      context.textContent = action.context;
      line.append(context);
    }
    element.append(line);
  }
}

export function createLabels(host, select, profile) {
  function code(device, key) {
    return (profile.devices[device]?.prefix || device) + ' / ' + key.replace(/^button/i, 'B').toUpperCase();
  }
  const overlay = node('div', 'rig-callouts');
  const lines = document.createElementNS(svgNS, 'svg');
  lines.setAttribute('class', 'rig-callout-lines');
  lines.setAttribute('aria-hidden', 'true');
  const rails = ['left', 'right'].map((side) => {
    const rail = node('div', 'rig-label-rail rig-rail-' + side);
    rail.tabIndex = 0;
    rail.setAttribute('role', 'region');
    rail.setAttribute('aria-label', side === 'left' ? 'Left control labels' : 'Right control labels');
    const stack = node('div', 'rig-rail-stack');
    rail.append(stack);
    rail.addEventListener('scroll', schedule, { passive: true });
    return { rail, stack };
  });
  const floating = node('div', 'rig-floating-labels');
  overlay.append(lines, ...rails.map(({ rail }) => rail), floating);
  host.append(overlay);

  let rows = new Map();
  let grouped = false;
  let reference = false;
  let arrange = true;
  let view = null;
  let enabled = true;
  let frame = 0;
  let activeKey;
  let reveal;
  const point = new Vector3();
  const resizeObserver = new ResizeObserver(schedule);

  function schedule() {
    if (enabled && !frame && view) frame = requestAnimationFrame(() => { frame = 0; update(...view); });
  }

  function makeRow() {
    const card = node('div', 'rig-callout-card');
    const head = node('div', 'rig-callout-head');
    const chip = node('button', 'rig-binding-label');
    chip.type = 'button';
    const title = node('span', 'rig-callout-title');
    const value = node('strong', 'rig-callout-value');
    chip.append(title, value);
    const toggle = node('button', 'rig-expand-group');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const entries = node('div', 'rig-group-entries');
    entries.hidden = true;
    head.append(chip, toggle);
    card.append(head, entries);
    const line = document.createElementNS(svgNS, 'path');
    line.setAttribute('class', 'rig-leader');
    lines.append(line);
    const row = { card, chip, title, value, toggle, entries, line, stamp: null };
    chip.addEventListener('click', () => select(row.item.device, row.item.key));
    toggle.addEventListener('click', () => {
      entries.hidden = !entries.hidden;
      toggle.setAttribute('aria-expanded', String(!entries.hidden));
      schedule();
    });
    entries.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) select(row.item.device, button.dataset.key);
    });
    resizeObserver.observe(card);
    return row;
  }

  function fill(row, item) {
    row.item = item;
    row.card.dataset.rigDevice = item.device;
    if (grouped) row.card.dataset.rigGroup = item.group || item.groupTitle || item.key;
    else delete row.card.dataset.rigGroup;
    row.chip.dataset.rigKey = item.key;
    const title = item.groupTitle || item.controlLabel ||
      profile.controlsByDevice[item.device]?.find(control => control.key === item.key)?.label || '';
    const members = item.groupEntries || [];
    const id = code(item.device, item.key);
    const representative = members.find((entry) => entry.key === item.key);
    const showGrid = reference && members.length > 1;
    row.title.textContent = grouped ? title : [id, title].filter(Boolean).join(' · ');
    if (item.deviceTitle) {
      const unit = node('span', 'rig-reference-unit');
      unit.textContent = item.deviceTitle + ' / ';
      row.title.prepend(unit);
    }
    if (grouped && !showGrid) {
      const identity = node('span', 'rig-representative-input');
      identity.textContent = ' · ' + (representative?.label || id.split(' / ')[1]);
      row.title.append(identity);
    }
    if (item.edited && !showGrid) markEdited(row.title);
    const text = item.text || 'Unassigned';
    const actions = text.split('\n').filter(Boolean);
    row.value.textContent = grouped && !item.active && actions.length > 1
      ? actions[0] + '  +' + (actions.length - 1) : text;
    row.value.classList.toggle('rig-unassigned', text === 'Unassigned');
    row.value.hidden = showGrid;
    if (reference && !showGrid) referenceValue(row.value, item);
    row.chip.title = title + ' · ' + id + '\n' + actionDetails(item);
    row.card.classList.toggle('rig-selected-group', Boolean(item.active));
    row.card.classList.toggle('rig-muted-label', Boolean(item.dimmed));
    row.line.classList.toggle('rig-muted-leader', Boolean(item.dimmed));
    row.chip.classList.toggle('rig-active-label', Boolean(item.active));
    row.line.classList.toggle('rig-active-leader', Boolean(item.active));
    row.toggle.hidden = reference || members.length < 2;
    row.toggle.setAttribute('aria-label', 'Inputs for ' + title);
    row.toggle.title = 'Show or hide ' + members.length + ' inputs';
    if (row.toggle.hidden || row.reference !== reference) row.entries.hidden = !showGrid;
    row.reference = reference;
    row.toggle.setAttribute('aria-expanded', String(!row.entries.hidden));
    const stamp = reference + JSON.stringify(members);
    if (stamp === row.stamp) return;
    row.stamp = stamp;
    const focused = row.entries.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const buttons = members.map((entry) => {
      const button = node('button', 'rig-group-entry');
      button.type = 'button';
      button.dataset.key = entry.key;
      button.dataset.rigKey = entry.key;
      button.classList.toggle('rig-current-entry', Boolean(entry.active));
      button.title = (entry.label || entry.key) + '\n' + actionDetails(entry);
      const input = node('span', 'rig-entry-input');
      input.textContent = entry.label || code(item.device, entry.key);
      if (entry.edited) markEdited(input);
      const value = node('span', 'rig-entry-value');
      value.textContent = entry.text || 'Unassigned';
      if (reference) referenceValue(value, entry);
      button.append(input, value);
      return button;
    });
    row.entries.replaceChildren(...buttons);
    if (focused) buttons.find((button) => button.dataset.key === focused)?.focus({ preventScroll: true });
  }

  function set(items) {
    const nextGrouped = items.some((item) => item.groupTitle || item.groupEntries);
    if (nextGrouped !== grouped) arrange = true;
    grouped = nextGrouped;
    const nextReference = items.some(item => item.reference);
    const modeChanged = reference !== nextReference;
    if (modeChanged) arrange = true;
    reference = nextReference;
    overlay.classList.toggle('rig-reference', reference);
    const next = new Map();
    let selected;
    for (const item of items) {
      const id = item.device + '/' + (grouped ? item.group || item.groupTitle || item.key : item.key);
      if (next.has(id)) continue;
      const row = rows.get(id) || makeRow();
      if (!rows.has(id) || row.item?.referenceSide !== item.referenceSide) arrange = true;
      fill(row, item);
      next.set(id, row);
      if (item.active) selected = { id, key: id + '/' + item.key };
    }
    for (const [id, row] of rows) {
      if (next.has(id)) continue;
      resizeObserver.unobserve(row.card);
      row.card.remove();
      row.line.remove();
      arrange = true;
    }
    if (grouped && (modeChanged || selected?.key !== activeKey)) reveal = selected?.id;
    activeKey = selected?.key;
    rows = next;
    for (const { rail } of rails) rail.hidden = !grouped || !rows.size;
    floating.hidden = grouped || !rows.size;
    if (!grouped) {
      for (const row of rows.values()) if (row.card.parentNode !== floating) floating.append(row.card);
    }
    schedule();
  }

  function placeRails(width, height) {
    if (reference && [...rows.values()].some(row => row.item.referenceSide)) {
      // The full setup reads like two physical sheets. SEM follows the stick
      // that hosts it, even when rotation reverses the devices on the canvas.
      for (const row of rows.values()) {
        row.side = row.item.referenceSide === 'left' ? 0 : 1;
        rails[row.side].stack.append(row.card);
      }
      arrange = false;
      return;
    }
    // Keep rail order stable while orbiting and while a different hat direction is selected.
    const ordered = Array.from(rows.values()).sort((a, b) => (a.x ?? width / 2) - (b.x ?? width / 2));
    const split = Math.ceil(ordered.length / 2);
    [ordered.slice(0, split), ordered.slice(split)].forEach((list, side) => {
      list.sort((a, b) => (a.y ?? height / 2) - (b.y ?? height / 2));
      for (const row of list) {
        row.side = side;
        rails[side].stack.append(row.card);
      }
    });
    arrange = !ordered.some((row) => row.x != null);
  }

  function keepInRail(id) {
    const row = rows.get(id);
    if (!row || row.side == null) return;
    const { rail } = rails[row.side];
    const current = reference && row.card.querySelector('.rig-group-entries:not([hidden]) .rig-current-entry') || row.card;
    const top = current.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    const height = current.offsetHeight;
    if (top < 0) rail.scrollTop += top;
    else if (top + height > rail.clientHeight) rail.scrollTop += Math.min(top, top + height - rail.clientHeight);
  }

  function update(width, height, camera, lookup) {
    view = [width, height, camera, lookup];
    if (!enabled || !rows.size || width < 1 || height < 1) return;
    for (const row of rows.values()) {
      const target = lookup(row.item.device, row.item.key);
      const mounted = target && target.parent?.visible !== false;
      row.x = row.y = null;
      if (mounted) {
        target.getWorldPosition(point).project(camera);
        if (point.z >= -1 && point.z <= 1) {
          row.x = (point.x + 1) * width / 2;
          row.y = (1 - point.y) * height / 2;
        }
      }
      row.onScreen = row.x != null && row.x >= 0 && row.x <= width && row.y >= 0 && row.y <= height;
      row.card.hidden = !grouped && !row.onScreen;
      const far = mounted && !target.visible;
      row.card.classList.toggle('rig-far-label', Boolean(far));
      row.card.classList.toggle('rig-offscreen-label', Boolean(grouped && mounted && !row.onScreen));
      row.line.classList.toggle('rig-far-leader', Boolean(far));
    }
    if (grouped && arrange) placeRails(width, height);
    if (grouped && reveal) { keepInRail(reveal); reveal = null; }
    const bounds = overlay.getBoundingClientRect();
    const clips = grouped ? rails.map(({ rail }) => rail.getBoundingClientRect()) : [];
    for (const row of rows.values()) {
      if (!row.onScreen) { row.line.removeAttribute('d'); continue; }
      let side = row.side;
      if (!grouped) {
        side = row.x < width / 2 ? 0 : 1;
        const w = row.card.offsetWidth, h = row.card.offsetHeight;
        const lowestTop = height - h - 46;
        let top = Math.max(8, Math.min(lowestTop, row.y - h / 2));
        if (Math.min(row.x, width - row.x) < w + 20 && row.y >= top - 8 && row.y <= top + h + 8) {
          if (row.y - h - 18 >= 8) top = row.y - h - 18;
          else if (row.y + 18 <= lowestTop) top = row.y + 18;
          else side = 1 - side;
        }
        const left = side === 0 ? 10 : Math.max(10, width - w - 10);
        row.card.style.transform = 'translate(' + left + 'px,' + top + 'px)';
      } else if (row.card.style.transform) row.card.style.removeProperty('transform');
      const current = reference && row.item.active && row.card.querySelector('.rig-group-entries:not([hidden]) .rig-current-entry');
      const rect = (current || row.card).getBoundingClientRect();
      const clip = grouped ? clips[side] : bounds;
      const top = Math.max(rect.top, clip.top);
      const bottom = Math.min(rect.bottom, clip.bottom);
      if (bottom <= top) { row.line.removeAttribute('d'); continue; }
      const x = (side === 0 ? rect.right : rect.left) - bounds.left;
      const y = (top + bottom) / 2 - bounds.top;
      const elbow = x + (side === 0 ? 9 : -9);
      row.line.setAttribute('d', 'M' + x + ',' + y + ' H' + elbow + ' L' + row.x + ',' + row.y);
    }
  }
  set([]);
  function fitWidth(width) {
    const railWidth = rails[0].rail.offsetWidth || Math.min(width * .27, 385);
    return Math.max(.32, (width - 2 * (railWidth + 17)) / width);
  }
  function setVisible(visible) {
    enabled = visible;
    if (!visible) { cancelAnimationFrame(frame); frame = 0; }
  }
  return { set, update, fitWidth, setVisible, dispose() {
    resizeObserver.disconnect();
    cancelAnimationFrame(frame);
    overlay.remove();
  } };
}
