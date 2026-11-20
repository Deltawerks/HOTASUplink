// The JPEG sheets describe the factory control numbers. A device profile may remap them.
// Keep this physical inventory independent of the joystick slots in a game layout.
const hatDirections = ['up', 'right', 'down', 'left', 'press'];
const povDirections = [
  ['up', 'Up'], ['rightup', 'Up-right'], ['right', 'Right'], ['rightdown', 'Down-right'],
  ['down', 'Down'], ['leftdown', 'Down-left'], ['left', 'Left'], ['leftup', 'Up-left'],
];

function button(device, number, group, label, detail = {}) {
  return { device, key: 'button' + number, group, label, kind: 'button', ...detail };
}

function makeStick(device) {
  const inputs = [
    button(device, 1, 'trigger', 'Trigger · first stage'),
    button(device, 2, 'trigger', 'Trigger · second stage'),
    button(device, 3, 'a2', 'A2 · red button'),
    button(device, 4, 'b1', 'B1 · side button'),
    button(device, 5, 'd1', 'D1 · pinky button'),
  ];
  for (const [group, name, first] of [['a3', 'A3 face hat', 6], ['a4', 'A4 upper hat', 11], ['c1', 'C1 thumb hat', 16]]) {
    hatDirections.forEach((direction, i) => inputs.push(button(device, first + i, group, name + ' · ' + direction, { direction })));
  }
  inputs.push(
    button(device, 21, 'speed', 'Rapid-fire trigger · push'),
    button(device, 22, 'speed', 'Rapid-fire trigger · pull'),
    button(device, 23, 'en2', 'En2 encoder · up'),
    button(device, 24, 'en2', 'En2 encoder · down'),
    button(device, 25, 'en1', 'En1 switch · up'),
    button(device, 26, 'en1', 'En1 switch · down'),
    button(device, 27, 'f1', 'F1 · center base button'),
    button(device, 28, 'f2', 'F2 · left base button'),
    button(device, 29, 'f3', 'F3 · right base button'),
  );
  for (const [input, label] of povDirections) {
    inputs.push({ device, key: 'hat1_' + input, group: 'pov', label: 'A1 POV · ' + label, kind: 'hat', direction: label.toLowerCase() });
  }
  for (const [key, group, label] of [
    ['x', 'motion', 'Grip · X axis'], ['y', 'motion', 'Grip · Y axis'], ['rotz', 'motion', 'Grip · twist axis'],
    ['z', 'throttle', 'Base throttle · axis'], ['rotx', 'pov', 'A1 ministick · horizontal axis'], ['roty', 'pov', 'A1 ministick · vertical axis'],
  ]) inputs.push({ device, key, group, label, kind: 'axis' });
  return inputs;
}

function makeSem() {
  const make = (n, group, label, detail) => button('sem', n, group, label, detail);
  const inputs = ['A1', 'A2', 'B1', 'B2', 'B3'].map((name, i) => make(41 + i, name.toLowerCase(), name + ' · push button'));
  for (const [index, name] of ['SW1', 'SW2'].entries()) {
    ['up', 'press', 'down'].forEach((direction, i) => inputs.push(make(46 + index * 3 + i, name.toLowerCase(), name + ' rocker · ' + direction, { direction })));
  }
  inputs.push(make(52, 'start', 'START · red button'));
  for (let mode = 1; mode <= 4; mode++) inputs.push(make(52 + mode, 'mode', 'Mode dial · ' + mode));
  inputs.push(
    make(57, 'c1', 'C1 · front button'),
    make(58, 'flaps', 'Flaps · down'),
    make(59, 'flaps', 'Flaps · center', { optionalPosition: true }),
    make(61, 'flaps', 'Flaps · up'),
    make(62, 'gear', 'Landing gear · down'),
    make(63, 'gear', 'Landing gear · center', { optionalPosition: true }),
    make(64, 'gear', 'Landing gear · up'),
  );
  return inputs;
}

export const controlsByDevice = { left: makeStick('left'), right: makeStick('right'), sem: makeSem() };
export function getControl(device, key) {
  return controlsByDevice[device]?.find(control => control.key === key);
}
