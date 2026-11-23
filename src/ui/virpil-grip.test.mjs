import assert from 'node:assert/strict';
import test from 'node:test';
import { virpilAlpha } from '../rig/virpil-alpha.mjs';

test('VIRPIL grip callouts expose each physical input on the hand-specific chart', () => {
  for (const hand of ['left', 'right']) {
    const group = name => virpilAlpha.controlsByDevice[hand].filter(control => control.group === name);
    const check = (name, inputs) => {
      const controls = group(name);
      assert.deepEqual(controls.map(({ key, direction }) => [key, direction]), inputs);
      assert.ok(controls.every(control => control.discoverable && control.hat));
    };
    check('ministick', [['button6', 'press'], ['rotx', 'horizontal'], ['roty', 'vertical']]);
    check('rocker', [['button28', 'press'], ['button29', 'up'], ['button30', 'down']]);
    check('scroll', [['button19', 'press'], ['button20', 'second-press'], ['button21', 'up'], ['button22', 'down']]);
    check('thumb-hat', [
      ['button23', 'press'], ['button24', 'up'], ['button25', hand === 'right' ? 'left' : 'right'],
      ['button26', 'down'], ['button27', hand === 'right' ? 'right' : 'left'],
    ]);
    for (const [name, number] of [['upper-button', 7], ['lower-button', 13]]) {
      assert.deepEqual(group(name).map(({ key, hat }) => [key, Boolean(hat)]), [['button' + number, false]]);
    }
  }
});
