// Retain digital transitions independently of the latest values on moving axes.
// The hidden monitor records data without scheduling timers or updating its DOM.
export function createMonitorHistory(paint, { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const digital = [];
  const axes = new Map();
  let sequence = 0, lastPaint = -Infinity, timer = null, deadline = Infinity;
  let visible = false, dirty = true;

  function unschedule() {
    if (timer !== null) cancel(timer);
    timer = null;
    deadline = Infinity;
  }
  function flush() {
    unschedule();
    if (!visible || !dirty) return;
    dirty = false;
    lastPaint = now();
    paint([...digital, ...axes.values()].sort((a, b) => b.sequence - a.sequence));
  }
  function record(event) {
    const time = now();
    const axis = event.type === 'axis';
    sequence++;
    const key = axis ? event.id + '/' + event.axis : sequence;
    const sample = { key, sequence, time, event };
    if (axis) {
      axes.delete(key);
      axes.set(key, sample);
      if (axes.size > 8) axes.delete(axes.keys().next().value);
    } else {
      digital.push(sample);
      if (digital.length > 96) digital.shift();
    }
    dirty = true;
    if (!visible) return;
    const due = axis ? Math.max(time, lastPaint + 250) : time;
    if (due >= deadline) return;
    unschedule();
    deadline = due;
    timer = schedule(flush, Math.max(0, due - time));
  }
  function clear() {
    digital.length = 0;
    axes.clear();
    dirty = true;
    flush();
  }
  function setVisible(next) {
    if (next === visible) return;
    visible = next;
    if (visible) flush();
    else unschedule();
  }
  return { record, clear, setVisible };
}
