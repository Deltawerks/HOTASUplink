import { Vector3 } from 'three';
import { calloutDirection, leaderHitsBox, overlap, placeCallout } from './callout-layout.js';
import { boxAt, pinNewRows, projectPin } from './callout-motion.js';
import { animateHatTransition } from './hat-transition.js';

const svgNS = 'http://www.w3.org/2000/svg';
const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
const directionSymbols = { up: '↑', right: '→', down: '↓', left: '←', press: '●',
  'up-right': '↗', 'down-right': '↘', 'down-left': '↙', 'up-left': '↖', horizontal: '↔', vertical: '↕' };
const pairedDirections = ['up', 'down', 'left', 'right', 'up-left', 'up-right',
  'down-left', 'down-right', 'horizontal', 'vertical', 'press'];

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

function shortName(item) {
  const bound = item.groupEntries?.filter(entry => entry.actions?.length) || [];
  return item.compactName || bound.find(entry => entry.key === item.key)?.compactName
    || bound[0]?.compactName || bound[0]?.actions?.[0]?.name || item.groupTitle;
}

export function createCompactLabels(host, edit, devices) {
  const unitName = Object.fromEntries(Object.entries(devices).map(([id, device]) => [id, device.name]));
  const overlay = node('div', 'rig-compact-labels');
  const lines = document.createElementNS(svgNS, 'svg');
  lines.setAttribute('class', 'rig-compact-stems');
  lines.setAttribute('aria-hidden', 'true');
  overlay.append(lines);
  host.append(overlay);
  const point = new Vector3();
  const rows = new Map();
  const stageControls = [...(host.closest('.stage')?.querySelectorAll('.camera-tools, .orbit-hint') || [])];
  let reserved = [], measuredWidth = 0, measuredHeight = 0;
  let expanded = null, popup = null, openKey = null, enabled = true;
  let lastScope = null;

  function trigger(row, key) {
    if (!row.summary) return row.chip;
    if (!row.detailed) return row.summary;
    return [...row.directions.children].find(button => button.dataset.rigKey === key) || row.directions.firstElementChild;
  }

  function close(restoreFocus = false) {
    if (!popup) return;
    const button = trigger(expanded, openKey);
    button.setAttribute('aria-expanded', 'false');
    const visible = !expanded.chip.hidden;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    popup.remove(); popup = expanded = openKey = null;
    if (restoreFocus && visible) button.focus({ preventScroll: true });
  }
  function outside(event) {
    if (!popup.contains(event.target) && !expanded.chip.contains(event.target)) close();
  }
  function escape(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  }

  function populate(row) {
    const { item } = row;
    const heading = node('div', 'rig-compact-heading');
    const title = node('strong', '', item.groupTitle);
    const unit = node('span', 'rig-compact-unit', unitName[item.device]);
    const dismiss = node('button', 'rig-compact-dismiss', '×');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Close control details');
    dismiss.onclick = () => close(true);
    const names = node('div', '');
    names.append(unit, title);
    heading.append(names, dismiss);
    const body = node('div', 'rig-compact-entries');
    for (const entry of item.groupEntries) {
      const section = node('div', 'rig-compact-entry');
      section.dataset.rigDetailKey = entry.key;
      if (entry.active) section.classList.add('rig-compact-current');
      const head = node('div', 'rig-compact-entry-head');
      const label = node('strong', '', entry.label || entry.key);
      if (entry.edited) label.append(node('small', 'rig-edited-marker', 'Edited'));
      const button = node('button', 'rig-compact-edit', 'Edit');
      button.type = 'button';
      button.dataset.rigEditKey = entry.key;
      button.setAttribute('aria-label', 'Edit ' + unitName[item.device] + ' ' + item.groupTitle + ', ' + (entry.label || entry.key));
      button.onclick = () => { close(); edit(item.device, entry.key); };
      head.append(label, button); section.append(head);
      for (const action of entry.actions || []) {
        const assignment = node('div', 'rig-compact-assignment', action.label || action.name);
        const meta = [action.context, action.gesture].filter(Boolean).join(' · ');
        if (meta) assignment.append(node('small', '', meta));
        section.append(assignment);
      }
      if (!entry.actions?.length) section.append(node('span', 'rig-compact-empty', entry.text || 'Unassigned'));
      body.append(section);
    }
    popup.replaceChildren(heading, body);
  }

  function positionPopup() {
    if (!popup || !expanded.box) return;
    const { x, y, w, h } = expanded.box;
    const width = overlay.clientWidth, height = overlay.clientHeight, pw = popup.offsetWidth, ph = popup.offsetHeight;
    const px = x + w + pw + 7 <= width ? x + w + 5 : x - pw - 5 >= 0 ? x - pw - 5 : x + w / 2 - pw / 2;
    const py = clamp(y + h / 2 - 25, 4, height - ph - 4);
    popup.style.transform = 'translate(' + Math.round(clamp(px, 4, width - pw - 4)) + 'px,' + Math.round(py) + 'px)';
  }

  function open(row, key = null) {
    if (!row || row.chip.hidden) return false;
    if (expanded === row && openKey === key) { close(true); return true; }
    close();
    expanded = row; openKey = key;
    popup = node('div', 'rig-compact-popup');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', unitName[row.item.device] + ' · ' + row.item.groupTitle);
    overlay.append(popup);
    populate(row); positionPopup();
    row.stamp = JSON.stringify(row.item.groupEntries);
    trigger(row, key).setAttribute('aria-expanded', 'true');
    const entry = [...popup.querySelectorAll('[data-rig-detail-key]')].find(el => el.dataset.rigDetailKey === key);
    const focus = entry?.querySelector('button') || popup.querySelector('.rig-compact-dismiss');
    if (entry) {
      const body = entry.parentElement;
      body.scrollTop += entry.getBoundingClientRect().top - body.getBoundingClientRect().top;
    }
    focus.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return true;
  }
  function set(items) {
    const kept = new Set();
    for (const item of items) {
      const id = item.device + '/' + item.group;
      kept.add(id);
      let row = rows.get(id);
      if (!row) {
        const hat = Boolean(item.hatSlots);
        const chip = node(hat ? 'div' : 'button', hat ? 'rig-compact-chip rig-hat-group' : 'rig-compact-chip');
        chip.hidden = true;
        chip.dataset.rigDevice = item.device; chip.dataset.rigGroup = item.group;
        const summary = hat ? node('button', 'rig-hat-summary') : null;
        const button = summary || chip;
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
        const text = node('span', 'rig-compact-name');
        const count = node('small', 'rig-compact-count');
        const directions = node('span', 'rig-compact-directions');
        button.append(text, count);
        if (hat) { chip.setAttribute('role', 'group'); chip.append(summary); }
        chip.append(directions); overlay.append(chip);
        const line = document.createElementNS(svgNS, 'path'); lines.append(line);
        row = { chip, summary, text, count, directions, line, item, sizes: {} }; rows.set(id, row);
        chip.onclick = event => open(row, event.target.closest('[data-rig-key]')?.dataset.rigKey || null);
      }
      row.item = item;
      const text = shortName(item);
      const actions = item.groupEntries.reduce((n, entry) => n + (entry.actions?.length || 0), 0);
      const extra = !row.summary && actions > 1 ? '+' + (actions - 1) : '';
      if (row.text.textContent !== text || row.count.textContent !== extra) {
        row.text.textContent = text; row.count.textContent = extra; row.count.hidden = !extra;
        row.sizes = {};
      }
      const entries = row.summary
        ? [...item.hatSlots].sort((a, b) => pairedDirections.indexOf(a.direction) - pairedDirections.indexOf(b.direction))
        : item.groupEntries.filter(entry => entry.actions?.length);
      const directional = Boolean(row.summary) || (entries.length > 1 && entries.length <= 5 && entries.every(entry => directionSymbols[entry.direction]));
      const directionText = directional ? entries.map(entry => [entry.direction, entry.compactName || entry.text, entry.actions.length, entry.key, entry.label]) : [];
      const signature = JSON.stringify(directionText);
      if (row.signature !== signature) {
        row.signature = signature; row.sizes = {}; row.directional = directional;
        const focusKey = row.chip.contains(document.activeElement) ? document.activeElement.dataset.rigKey : null;
        row.directions.replaceChildren(...directionText.map(([direction, name, count, key, label]) => {
          const line = node(row.summary ? 'button' : 'span', row.summary ? 'rig-compact-direction rig-hat-slot' : 'rig-compact-direction');
          const glyph = node('b', '', directionSymbols[direction]);
          glyph.setAttribute('aria-hidden', 'true');
          line.append(glyph, node('span', '', name));
          if (count > 1) line.append(node('small', 'rig-compact-count', '+' + (count - 1)));
          line.title = label + ' · ' + name;
          if (row.summary) {
            line.type = 'button';
            line.dataset.direction = direction; line.dataset.rigKey = key;
            line.setAttribute('aria-label', unitName[item.device] + ' · ' + item.groupTitle + ' · ' + line.title);
            line.setAttribute('aria-haspopup', 'dialog');
            line.setAttribute('aria-expanded', String(expanded === row && key === openKey));
            line.classList.toggle('rig-hat-empty', count === 0);
          }
          return line;
        }));
        if (focusKey) trigger(row, focusKey).focus({ preventScroll: true });
      }
      const caption = unitName[item.device] + ' · ' + item.groupTitle;
      const accessible = row.summary ? caption : caption + ' · ' + text;
      row.chip.setAttribute('aria-label', accessible);
      (row.summary || row.chip).title = accessible;
      if (row.summary) {
        row.summary.setAttribute('aria-label', accessible);
        row.directions.dataset.hatName = item.groupTitle;
        for (const button of row.directions.children) {
          button.toggleAttribute('data-active', Boolean(item.active) && item.key === button.dataset.rigKey);
        }
      }
      row.chip.classList.toggle('rig-compact-active', Boolean(item.active));
      if (expanded === row) {
        const stamp = JSON.stringify(item.groupEntries);
        if (row.stamp !== stamp) {
          const focusKey = document.activeElement?.dataset.rigEditKey;
          const scroll = popup.querySelector('.rig-compact-entries').scrollTop;
          populate(row);
          popup.querySelector('.rig-compact-entries').scrollTop = scroll;
          const target = [...popup.querySelectorAll('[data-rig-edit-key]')].find(button => button.dataset.rigEditKey === focusKey);
          (target || popup.querySelector('.rig-compact-dismiss')).focus({ preventScroll: true });
        }
        row.stamp = stamp;
      }
    }
    for (const [id, row] of rows) {
      if (kept.has(id)) continue;
      if (row === expanded) close();
      row.chip.remove(); row.line.remove(); rows.delete(id);
    }
    overlay.hidden = !items.length;
  }

  function size(row, detailed) {
    if (row.detailed !== detailed) {
      const hasFocus = row.chip.contains(document.activeElement);
      if (expanded === row) trigger(row, openKey).setAttribute('aria-expanded', 'false');
      row.detailed = detailed;
      row.chip.classList.toggle('rig-compact-directional', detailed);
      row.chip.style.width = '';
      if (expanded === row) trigger(row, openKey).setAttribute('aria-expanded', 'true');
      if (hasFocus) trigger(row, openKey).focus({ preventScroll: true });
    }
    if (!row.sizes[detailed]) {
      row.chip.style.width = '';
      const bounds = row.chip.getBoundingClientRect();
      row.sizes[detailed] = [Math.ceil(bounds.width), Math.ceil(bounds.height)];
    }
    [row.w, row.h] = row.sizes[detailed];
  }
  function resetLayout() {
    for (const row of rows.values()) {
      row.pin = null;
      row.otherPin = null;
      row.transitionFrom = null;
    }
  }

  function invalidateMeasurements() {
    // Text can change size when a font arrives or the viewport height changes.
    // Measure once at the next layout, never while reprojecting a cached pin.
    measuredWidth = 0;
  }

  function hide(row) {
    row.transitionFrom = null;
    row.chip.hidden = true;
    row.line.removeAttribute('d');
    if (expanded === row) close();
  }

  function update(width, height, camera, lookup, scope, geometry, deferNewPins, prepareGeometry, orbitTarget, showHatDirections, closeHatDirections) {
    if (!enabled || !rows.size || !width || !height) return;
    const resized = width !== measuredWidth || height !== measuredHeight;
    if (resized || lastScope !== scope) resetLayout();
    lastScope = scope;
    if (resized) {
      measuredWidth = width; measuredHeight = height;
      for (const row of rows.values()) row.sizes = {};
      overlay.classList.toggle('rig-compact-narrow', width < 630);
      const base = overlay.getBoundingClientRect();
      reserved = stageControls.filter(control => !control.hidden).map(control => {
        const rect = control.getBoundingClientRect();
        return { x: rect.left - base.left, y: rect.top - base.top, w: rect.width, h: rect.height, reserved: true };
      }).filter(rect => rect.w && rect.h);
    }
    const visible = [], pending = [], fixed = [...reserved];
    for (const row of rows.values()) {
      const target = lookup(row.item.device, row.item.key);
      let show = Boolean(target?.visible && target.parent?.visible);
      if (show) {
        target.getWorldPosition(point).project(camera);
        show = Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && Math.abs(point.z) <= 1;
      }
      if (!show) {
        hide(row);
        continue;
      }
      row.ax = (point.x + 1) * width / 2; row.ay = (1 - point.y) * height / 2;
      row.depth = point.z; row.unit = target.parent; row.marker = target;
      if (row.summary) {
        const detailed = row.item.group === 'pov' ? closeHatDirections : showHatDirections;
        if (row.showDirections !== detailed) {
          // Each size has its own pin. Give enlarged neighbors room once,
          // and restore the exact overview placement when they fold.
          if (row.pin && !row.chip.hidden) {
            projectPin(row, row.pin, width, height, camera, point);
            row.transitionFrom = boxAt(row, point.x, point.y, width, height);
          }
          [row.pin, row.otherPin] = [row.otherPin, row.pin];
          row.showDirections = detailed;
        }
      }
      if (row.pin) {
        projectPin(row, row.pin, width, height, camera, point);
        if (!(point.z >= -1 && point.z <= 1)) {
          hide(row);
          continue;
        }
        row.pinX = point.x; row.pinY = point.y;
      } else if (deferNewPins) {
        hide(row);
        continue;
      } else {
        pending.push(row);
      }
      row.chip.hidden = false;
      visible.push(row);
    }
    for (const row of visible) {
      if (!row.pin) continue;
      const detailed = row.summary ? row.showDirections : row.detailed && row.directional;
      if (row.detailed !== detailed || !row.sizes[detailed]) {
        size(row, detailed);
        if (!detailed && row.widthLimit && row.w > row.widthLimit) {
          row.w = row.widthLimit; row.chip.style.width = row.w + 'px';
        }
      }
      row.box = boxAt(row, row.pinX, row.pinY, width, height);
      fixed.push(row.box);
    }
    // Once placed, a chip belongs to the hardware. Orbit, zoom, release and
    // a neighbor appearing can only reproject that pin or obscure the button.
    if (pending.length) {
      prepareGeometry();
      const centers = new Map();
      for (const row of pending) {
        if (centers.has(row.item.device)) continue;
        row.unit.getWorldPosition(point).project(camera);
        centers.set(row.item.device, { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 });
      }
      layoutRows(pending, visible, centers, fixed, width, height, geometry, scope !== 'all');
      const alternatives = new Map();
      for (const row of pending) {
        const occupied = fixed.concat(pending.filter(other => other !== row).map(other => other.box));
        alternatives.set(row, alternateSlots(row, visible, occupied, width, height, geometry));
      }
      pinNewRows(pending, visible, width, height, camera, orbitTarget, alternatives);
      for (const row of pending) {
        projectPin(row, row.pin, width, height, camera, point);
        row.box = boxAt(row, point.x, point.y, width, height);
      }
    }
    for (const row of visible) {
      const box = row.box;
      row.chip.style.transform = 'translate(' + box.x.toFixed(2) + 'px,' + box.y.toFixed(2) + 'px)';
      if (row.transitionFrom) {
        animateHatTransition(row.chip, row.detailed, row.sizes[true], row.transitionFrom, box);
        row.transitionFrom = null;
      }
      row.chip.dataset.anchorX = String(Math.round(row.ax)); row.chip.dataset.anchorY = String(Math.round(row.ay));
      row.line.classList.toggle('rig-compact-active-stem', Boolean(row.item.active));
      row.line.setAttribute('d', 'M' + row.ax.toFixed(1) + ',' + row.ay.toFixed(1) + ' L' + box.endX.toFixed(1) + ',' + box.endY.toFixed(1));
    }
    positionPopup();
  }

  // A crowded side view sometimes needs more than a different pin depth.
  // Offer nearby slots that still leave the starting view legible. The
  // multi-view placement pass can then choose a pin once for the whole orbit.
  function alternateSlots(row, visible, occupied, width, height, geometry) {
    const { x, y, w, h } = row.box;
    const cx = x + w / 2, cy = y + h / 2;
    const stepX = Math.max(26, w * .5), stepY = Math.max(25, h * .85);
    const maxCover = geometry.coverage(x, y, w, h) + .025;
    const slots = [];
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [0, -2], [0, 2],
      [-1, -1], [1, -1], [-1, 1], [1, 1], [-2, 0], [2, 0]]) {
      const box = boxAt(row, cx + dx * stepX, cy + dy * stepY, width, height);
      if (Math.hypot(box.x - x, box.y - y) < 3 || geometry.coverage(box.x, box.y, w, h) > maxCover) continue;
      if (visible.some(({ ax, ay }) => ax > box.x - 4 && ax < box.x + w + 4
        && ay > box.y - 4 && ay < box.y + h + 4)) continue;
      if (occupied.some(other => overlap(box.x, box.y, w, h, other) > 0 || leaderHitsBox(box, other)
        || (other.row && leaderHitsBox(other, box)))) continue;
      if (!slots.some(other => other.x === box.x && other.y === box.y)) slots.push(box);
    }
    return slots;
  }

  function layoutRows(pending, visible, centers, fixed, width, height, geometry, focused) {
    const radius = clamp(height * (focused ? .25 : .16), 55, 180);
    for (const row of pending) {
      Object.assign(row, calloutDirection(row, visible, centers.get(row.item.device), geometry.direction(row.marker), radius));
    }
    const detailed = new Set(pending.filter(row => row.summary ? row.showDirections
      : focused && width >= 630 && height >= 330 && row.directional));
    // Multi-line hats need more free space than a single button label.
    pending.sort((a, b) => Number(detailed.has(b)) - Number(detailed.has(a))
      || (detailed.has(a) ? a.ay - b.ay : 0));
    // Prefer the directions at normal desk sizes. If those extra lines collide
    // at this zoom or viewing angle, compact the involved group and place it again.
    while (true) {
      const taken = [...fixed];
      let collision = null;
      for (const row of pending) {
        size(row, detailed.has(row));
        let box = placeCallout(row, visible, taken, width, height, geometry, focused);
        let hit = taken.find(other => overlap(box.x, box.y, box.w, box.h, other) > 2);
        if (hit && !row.summary && !detailed.has(row) && row.w > 80) {
          row.w = Math.max(80, Math.floor(row.w * .77));
          const smaller = placeCallout(row, visible, taken, width, height, geometry, focused);
          if (!taken.some(other => overlap(smaller.x, smaller.y, smaller.w, smaller.h, other) > 2)) {
            box = smaller; hit = null;
          }
        }
        if (!collision && hit) {
          if (!row.summary && detailed.has(row)) collision = row;
          else if (!hit.row?.summary && detailed.has(hit.row)) collision = hit.row;
        }
        box.row = row; row.box = box; taken.push(box);
      }
      if (!collision || !detailed.delete(collision)) break;
    }
    // The first controls were placed before their neighbors. Give interrupted
    // leaders a second choice now that all the occupied space is known.
    for (const row of pending) {
      const box = row.box;
      const interrupted = pending.some(other => other !== row &&
        (leaderHitsBox(box, other.box) || leaderHitsBox(other.box, box)));
      if (!interrupted && geometry.coverage(box.x, box.y, box.w, box.h) < .06) continue;
      const taken = fixed.concat(pending.filter(other => other !== row).map(other => other.box));
      row.w = box.w;
      row.box = placeCallout(row, visible, taken, width, height, geometry, focused, box);
      row.box.row = row;
    }
    for (const row of pending) {
      const box = row.box;
      row.w = box.w; row.h = box.h;
      row.detailed = detailed.has(row);
      row.widthLimit = box.w < row.sizes[row.detailed][0] ? box.w : 0;
      row.chip.classList.toggle('rig-compact-directional', row.detailed);
      row.chip.style.width = row.widthLimit ? row.widthLimit + 'px' : '';
    }
  }
  return { set, update, resetLayout, invalidateMeasurements, openGroup: (device, group) => open(rows.get(device + '/' + group)),
    setVisible(visible) { enabled = visible; if (!visible) close(); },
    dispose() { close(); rows.clear(); overlay.remove(); },
  };
}
