import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorHistory } from './monitor-history.mjs';

function fixture() {
  let time = 0, last = null;
  const paints = [], timers = new Map();
  const history = createMonitorHistory(samples => paints.push(samples), {
    now: () => time,
    schedule(fn, delay) { last = Symbol(); timers.set(last, { fn, due: time + delay }); return last; },
    cancel(id) { timers.delete(id); },
  });
  function advance(ms) {
    time += ms;
    for (const timer of [...timers.values()]) if (timer.due <= time) timer.fn();
  }
  return { history, paints, timers, advance };
}
const axis = (axis, value) => ({ type: 'axis', id: 'stick', axis, value });
const button = (button, pressed) => ({ type: 'button', id: 'stick', button, pressed });

test('hidden input retains exactly the newest eight axes and 96 digital transitions without scheduling or painting', () => {
  const { history, paints, timers } = fixture();
  for (let i = 0; i < 5000; i++) {
    history.record(axis(i % 12, i));
    history.record(button(i, i % 2 === 0));
  }
  assert.equal(timers.size, 0);
  assert.equal(paints.length, 0);
  history.setVisible(true);
  assert.equal(paints.length, 1);
  const records = paints[0];
  assert.equal(records.length, 104);
  const buttons = records.filter(row => row.event.type === 'button');
  assert.equal(buttons.length, 96);
  assert.equal(buttons[0].event.button, 4999);
  assert.equal(buttons.at(-1).event.button, 4904);
  assert.equal(new Set(records.filter(row => row.event.type === 'axis').map(row => row.event.axis)).size, 8);
});

test('visible axes share a trailing update and digital input preempts it without dropping press or release', () => {
  const { history, paints, timers, advance } = fixture();
  history.setVisible(true);
  for (let i = 0; i < 100; i++) history.record(axis('X', i));
  advance(249);
  assert.equal(timers.size, 1);
  assert.equal(paints.length, 1);
  advance(1);
  assert.deepEqual(paints[1][0].event, axis('X', 99));
  history.record(axis('Y', 2));
  history.record(button(5, true));
  history.record(button(5, false));
  advance(0);
  assert.deepEqual(paints[2].map(row => row.event), [button(5, false), button(5, true), axis('Y', 2), axis('X', 99)]);
  assert.equal(timers.size, 0);
});

test('leaving the monitor cancels its timer and clearing a hidden log cannot resurrect an axis sample', () => {
  const { history, paints, timers, advance } = fixture();
  history.setVisible(true);
  history.record(axis('X', 1));
  history.setVisible(false);
  assert.equal(timers.size, 0);
  advance(1000);
  assert.equal(paints.length, 1);
  history.clear();
  history.setVisible(true);
  assert.deepEqual(paints.at(-1), []);
  history.record(axis('X', .5));
  history.clear();
  advance(1000);
  assert.equal(timers.size, 0);
  assert.deepEqual(paints.at(-1), []);
});
