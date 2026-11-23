import { createMonitorHistory } from './monitor-history.mjs';
import { isFalconPedals, stickFamily, stickHand } from '../rig/device-identity.mjs';

const byId = (id) => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function savedDeviceFor(device, profile) {
  const saved = profile?.devices || [];
  const vendor = String(device.vid || '').toUpperCase();
  const product = String(device.pid || '').toUpperCase();
  const usbId = (entry) => entry.product?.match(/\{([a-f0-9]{4})([a-f0-9]{4})-/i)?.slice(1);
  const exact = saved.filter((entry) => {
    const usb = usbId(entry);
    return usb && usb[0].toUpperCase() === product && usb[1].toUpperCase() === vendor;
  });
  const side = stickHand(device);
  const family = stickFamily(device);
  const candidates = exact.length ? exact : isFalconPedals(device) ? saved.filter(isFalconPedals)
    : saved.filter((entry) => side !== 'unknown' && entry.device === side && stickFamily(entry) === family);
  if (candidates.length !== 1) return null;
  const entry = candidates[0];
  const usb = usbId(entry);
  return {
    slot: entry.slot,
    name: entry.product.split('{')[0].trim(),
    pid: usb?.[0].toUpperCase(),
    vid: usb?.[1].toUpperCase(),
    changed: Boolean(usb && !exact.length),
  };
}

function renderCards(container, devices, profile) {
  container.replaceChildren();
  if (!devices.length) {
    container.append(element('p', 'device-card monitor-empty', 'No supported controllers detected.'));
    return;
  }
  for (const device of devices) {
    const card = element('article', 'device-card');
    const name = element('h3', '', device.name);
    const state = element('span', 'monitor-device-state', device.readable ? 'Reading input' : 'Input unavailable');
    if (device.readable) state.classList.add('live');
    const title = element('div', 'monitor-device-title');
    title.append(name, state);
    card.append(title, element('p', 'monitor-counts',
      device.buttonCount + ' buttons · ' + device.hatCount + ' POV · ' + device.axisCount + ' axes'));
    card.append(element('p', 'physical', 'USB ' + device.vid + ' / ' + device.pid));
    const details = element('details', 'monitor-device-details');
    details.append(element('summary', '', 'Device identity'), element('p', 'monitor-id', device.id));
    const ambiguousPedals = isFalconPedals(device) && devices.some(other => other.id !== device.id && isFalconPedals(other));
    const saved = ambiguousPedals ? null : savedDeviceFor(device, profile);
    if (saved) {
      const label = 'Saved JS' + saved.slot + ' · ' + (saved.name || 'Joystick');
      details.append(element('p', '', label + (saved.pid ? ' · USB ' + saved.vid + ' / ' + saved.pid : '')));
      if (saved.changed) card.append(element('div', 'monitor-mismatch', 'Saved JS' + saved.slot + ' uses a different USB product ID.'));
    }
    card.append(details);
    container.append(card);
  }
}

function dialSummary(samples) {
  const completed = samples.filter(Number.isInteger);
  if (!completed.length) return '';
  if (completed.length < 4) return completed.length + ' of 4 positions tested.';
  const distinct = new Set(completed).size;
  if (distinct === 4) return 'Your button reports a different number in every position. You can bind each number separately in Star Citizen.';
  if (distinct === 1) return 'Your button reports button ' + completed[0] + ' in every position. It keeps the same game binding across all four.';
  return 'Your button reports ' + distinct + ' distinct numbers. Positions with the same number share one input.';
}

function makeDialCheck(page) {
  const panel = element('details', 'monitor-card monitor-dial');
  panel.append(element('summary', '', 'Test the SEM mode dial'));
  const body = element('div', 'monitor-dial-body');
  body.append(element('p', 'monitor-dial-instructions',
    'Choose the stick the SEM is connected to. For each position, turn the dial first, then arm capture and tap the same SEM button each time (for example, B3).'));
  const selector = element('select', 'monitor-host-select');
  const hostLabel = element('label', 'monitor-host-label', 'SEM host');
  hostLabel.append(selector);
  const slots = element('div', 'monitor-dial-slots');
  slots.setAttribute('role', 'group');
  slots.setAttribute('aria-label', 'Physical dial position');
  const arm = element('button', 'monitor-arm');
  const reset = element('button', 'text-button', 'Reset test');
  const controls = element('div', 'monitor-dial-controls');
  controls.append(arm, reset);
  const result = element('p', 'monitor-dial-result');
  result.setAttribute('role', 'status');
  body.append(hostLabel, slots, controls, result);
  panel.append(body);
  page.querySelector('.monitor-card').before(panel);

  let devices = [];
  let selected = 0;
  let armed = false;
  let pressed = null;
  const samples = [null, null, null, null];
  const buttons = [];
  function update() {
    for (let index = 0; index < buttons.length; index++) {
      const button = buttons[index];
      button.setAttribute('aria-pressed', String(index === selected));
      button.lastChild.textContent = samples[index] == null ? 'Untested' : 'Button ' + samples[index];
      button.setAttribute('aria-label', 'Position ' + (index + 1) + ' ' + button.lastChild.textContent);
    }
    arm.disabled = !devices.some((device) => device.id === selector.value && device.readable);
    arm.textContent = armed ? 'Cancel capture' : 'Arm position ' + (selected + 1);
    reset.disabled = !armed && samples.every((value) => value == null);
    result.textContent = armed ? (pressed == null ? 'Tap and release your test button.' : 'Release it to record button ' + pressed + '.')
      : dialSummary(samples);
  }
  function disarm() { armed = false; pressed = null; }
  function clear() { disarm(); samples.fill(null); selected = 0; update(); }
  for (let index = 0; index < 4; index++) {
    const button = element('button', 'monitor-slot');
    button.append(element('span', '', 'Position ' + (index + 1)), element('small', '', 'Untested'));
    button.addEventListener('click', () => { disarm(); selected = index; update(); });
    slots.append(button);
    buttons.push(button);
  }
  arm.addEventListener('click', () => { armed = !armed; pressed = null; update(); });
  reset.addEventListener('click', clear);
  selector.addEventListener('change', clear);
  function cancelPending() { if (armed) { disarm(); update(); } }
  panel.addEventListener('toggle', () => { if (!panel.open) cancelPending(); });
  const observer = new MutationObserver(() => { if (page.hidden) cancelPending(); });
  observer.observe(page, { attributes: true, attributeFilter: ['hidden'] });
  return {
    cancelPending,
    setVisible(visible) {
      panel.hidden = !visible;
      if (!visible) { panel.open = false; cancelPending(); }
    },
    setDevices(next) {
      const current = selector.value;
      devices = next;
      const placeholder = element('option', '', 'Select a connected stick');
      placeholder.value = '';
      selector.replaceChildren(placeholder);
      for (const device of devices) {
        const option = element('option', '', device.name);
        option.value = device.id;
        selector.append(option);
      }
      const suggested = devices.filter((device) => /\bSEM\b/i.test(device.name));
      selector.value = devices.some((device) => device.id === current) ? current :
        suggested.length === 1 ? suggested[0].id : '';
      if (selector.value !== current) clear();
      if (!devices.some((device) => device.id === selector.value && device.readable)) disarm();
      update();
    },
    record(event) {
      if (!armed || !panel.open || page.hidden || event.type !== 'button' || event.id !== selector.value) return;
      if (event.pressed && pressed == null) pressed = event.button;
      if (!event.pressed && pressed === event.button) {
        samples[selected] = event.button;
        disarm();
      }
      update();
    },
    dispose() { observer.disconnect(); panel.remove(); },
  };
}

export function createMonitor() {
  const page = byId('monitor-page');
  const cards = byId('device-cards');
  const activity = byId('activity');
  const status = byId('monitor-status');
  const clearButton = byId('clear-events');
  const dial = makeDialCheck(page);
  const rows = new Map();
  const clock = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false,
  });
  let devices = [];
  let profile = null;
  const empty = element('p', 'blank-message', 'Press a button, move a hat, or move an axis to see its input.');
  function paint(samples) {
    const retained = new Set(samples.map(sample => sample.key));
    for (const [key, row] of rows) {
      if (retained.has(key)) continue;
      row.node.remove();
      rows.delete(key);
    }
    clearButton.disabled = !samples.length;
    if (!samples.length) { activity.replaceChildren(empty); return; }
    empty.remove();
    let cursor = activity.firstElementChild;
    for (const { key, time, event, sequence } of samples) {
      let row = rows.get(key);
      if (!row) {
        const node = element('div', 'event');
        node.dataset.type = event.type;
        const name = devices.find(device => device.id === event.id)?.name || event.id;
        const control = event.type === 'axis' ? 'Axis ' + event.axis
          : event.type === 'hat' ? 'POV ' + event.hat : 'Button ' + event.button;
        node.classList.toggle('monitor-press', event.type === 'button' && event.pressed);
        row = { node, time: element('time'), value: element('span') };
        node.append(row.time, element('span', '', name), element('strong', '', control), row.value);
        rows.set(key, row);
      }
      if (row.sequence !== sequence) {
        row.time.textContent = clock.format(time);
        row.value.textContent = event.type === 'axis' ? Number(event.value).toFixed(2)
          : event.type === 'hat' ? event.direction || 'Centered' : event.pressed ? 'Pressed' : 'Released';
        row.sequence = sequence;
      }
      if (row.node === cursor) cursor = cursor.nextElementSibling;
      else activity.insertBefore(row.node, cursor);
    }
  }
  const history = createMonitorHistory(paint);
  const clear = history.clear;
  clearButton.addEventListener('click', clear);
  history.setVisible(!page.hidden && !document.hidden);
  dial.setDevices([]);
  return {
    setDevices(next) {
      devices = Array.isArray(next) ? next : [];
      renderCards(cards, devices, profile);
      dial.setDevices(devices.filter(device => stickFamily(device) === 'vkb'));
    },
    setShowSem(visible) { dial.setVisible(visible); },
    setStatus(next) {
      status.textContent = typeof next === 'string' ? next : next?.message || '';
      status.dataset.level = next?.level || 'info';
    },
    setProfile(next) {
      if (next === profile) return;
      profile = next;
      renderCards(cards, devices, profile);
    },
    setVisible(visible) {
      history.setVisible(visible);
      if (!visible) dial.cancelPending();
    },
    record(event) {
      if (!event || !['button', 'hat', 'axis'].includes(event.type)) return;
      dial.record(event);
      history.record(event);
    },
    dispose() {
      history.setVisible(false);
      clear();
      rows.clear();
      clearButton.removeEventListener('click', clear);
      dial.dispose();
    },
  };
}
