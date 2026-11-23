import { modelAssetsByRig, virpilAlphaId } from './model-assets.mjs';
import { createSchematic } from './schematic.js';
import { isFalconPedals } from './device-identity.mjs';
import { falconStarterId } from './falcon-starter.mjs';

// VPC Alpha Prime factory grip charts. Custom VPC firmware can assign different
// logical inputs. The three five-way hats reverse their horizontal numbers
// between the right-hand and left-hand charts.
function controlsFor(device) {
  const controls = [];
  const slot = direction => ({ direction, hat: true, discoverable: true });
  function button(number, group, label, detail = {}) {
    controls.push({ device, key: 'button' + number, kind: 'button', group, label, ...detail });
  }
  function axis(key, group, label, detail = {}) {
    controls.push({ device, key, kind: 'axis', group, label, ...detail });
  }
  function hat(first, group, title) {
    const right = device === 'right';
    const directions = ['press', 'up', right ? 'left' : 'right', 'down', right ? 'right' : 'left'];
    directions.forEach((direction, i) => button(first + i, group, title + ' · ' + direction, slot(direction)));
  }
  button(1, 'flip', 'Flip trigger · up');
  button(2, 'flip', 'Flip trigger · center position');
  button(3, 'flip', 'Flip trigger · pulled');
  button(4, 'trigger', 'Main trigger · first stage');
  button(5, 'trigger', 'Main trigger · second stage');
  button(6, 'ministick', 'Ministick · press', slot('press'));
  button(7, 'upper-button', 'Upper face button');
  hat(8, 'upper-hat', 'Upper face hat');
  button(13, 'lower-button', 'Lower face button');
  hat(14, 'lower-hat', 'Lower face hat');
  button(19, 'scroll', 'Scroll wheel · first press stage', slot('press'));
  button(20, 'scroll', 'Scroll wheel · second press stage', slot('second-press'));
  button(21, 'scroll', 'Scroll wheel · up', slot('up'));
  button(22, 'scroll', 'Scroll wheel · down', slot('down'));
  hat(23, 'thumb-hat', 'Thumb hat');
  for (const [i, direction] of ['press', 'up', 'down'].entries()) {
    button(28 + i, 'rocker', 'Side rocker · ' + direction, slot(direction));
  }
  button(31, 'pinky', 'Pinky button');
  button(32, 'brake', 'Brake lever · button');
  axis('slider1', 'brake', 'Brake lever · analog travel');
  axis('rotx', 'ministick', 'Ministick · horizontal axis', slot('horizontal'));
  axis('roty', 'ministick', 'Ministick · vertical axis', slot('vertical'));
  axis('x', 'motion', 'Grip · X axis');
  axis('y', 'motion', 'Grip · Y axis');
  axis('z', 'motion', 'Grip · twist axis');
  return controls;
}

// Points were ray-picked on the right scan, in the viewer's +Z pilot-facing
// orientation. Each row has the point and the outward direction of the cap.
const rightMarkers = {
  flip:         [[.021, .360, -.338], [-.01, .06, -1]],
  trigger:      [[-.015, .392, -.112], [-.99, .07, .06]],
  ministick:    [[-.237, .766, .061], [.01, .22, .98]],
  'upper-button': [[-.041, .850, -.024], [-.01, .23, .97]],
  'upper-hat':  [[.098, .851, -.026], [.04, .24, .97]],
  'lower-button': [[.098, .710, .028], [0, .37, .93]],
  'lower-hat':  [[-.050, .714, .036], [.02, .33, .94]],
  scroll:       [[.022, .596, .030], [-.30, .58, .75]],
  'thumb-hat':  [[-.215, .444, .110], [-.99, .08, -.12]],
  rocker:       [[.167, .657, -.285], [.71, .23, -.66]],
  pinky:        [[-.085, .067, .074], [.04, .17, -.99]],
  brake:        [[.040, .150, -.218], [.14, -.66, -.74]],
  motion:       [[.041, -.350, .219], [0, 0, 1]],
};
const anchors = {
  right: {}, left: {},
  pedals: { rudder: [0,-.044,0], 'left-toe': [-.67,.267,.171], 'right-toe': [.67,.267,.171] },
};
const surfaceNormals = {
  right: {}, left: {},
  pedals: { rudder: [0,1,0], 'left-toe': [0,.49,.87], 'right-toe': [0,.49,.87] },
};
// The mirrored model's plane passes through the shaft at x = .04.
for (const [group, [point, normal]] of Object.entries(rightMarkers)) {
  anchors.right[group] = point;
  anchors.left[group] = [.08 - point[0], point[1], point[2]];
  surfaceNormals.right[group] = normal;
  surfaceNormals.left[group] = [-normal[0], normal[1], normal[2]];
}

function buildSchematic(device, { append, housing, box, disk, control }) {
  const frame = 0x263747, grip = 0x354858, cap = 0x718695;
  if (device === 'pedals') {
    append(box(1.6,.05,1.04).translate(0,-.40,0), frame);
    append(housing([[-.38,0,-.1,.23,.34],[-.13,0,-.1,.19,.28]]), grip);
    for (const z of [-.24,.055]) append(box(1.43,.075,.075).translate(0,-.11,z), cap);
    append(disk(.099,.05).translate(0,-.07,0), frame);
    for (const x of [-.67,.67]) {
      // The two slanted open footplates pivot on the upper crossbar.
      for (const dx of [-.245,0,.245]) {
        append(box(.034,.54,.036).rotateX(-.50).translate(x+dx,.166,.22), cap);
      }
      for (const dy of [-.24,0,.24]) {
        append(box(.51,.04,.038).rotateX(-.50).translate(x,.166+dy*.877,.22-dy*.479), cap);
      }
      append(box(.49,.06,.17).translate(x,-.065,.38), grip);
    }
    return;
  }
  const x = .04;
  const towardThumb = device === 'left' ? 1 : -1;
  append(housing([[-.95,x,.08,.226,.30],[-.92,x,.08,.23,.31],[-.59,x,.08,.23,.31],
    [-.58,x,-.005,.28,.40],[-.53,x,-.005,.28,.40],[-.51,x,-.005,.26,.39]]), frame);
  append(housing([[-.51,x,.15,.16,.16],[-.45,x,.15,.14,.14],[-.40,x,.15,.072,.072],
    [-.32,x,.15,.072,.072],[-.30,x,.15,.125,.125],[-.22,x,.15,.125,.125],
    [-.20,x,.15,.08,.08],[-.16,x,.15,.08,.08]]), cap);
  append(housing([[-.17,x,.14,.10,.13],[-.11,x,.13,.13,.18],[.04,x,.13,.15,.17],
    [.28,x,.10,.13,.19],[.48,x,.04,.15,.18],[.55,x,-.05,.18,.16],
    [.69,x,-.187,.155,.165],[.82,x,-.201,.155,.15],[.93,x,-.185,.14,.09]]), grip);
  const podX = x + towardThumb * .17;
  append(housing([[.65,podX,-.07,.08,.07],[.73,podX,-.06,.145,.09],
    [.79,podX,-.07,.145,.08],[.84,podX,-.08,.09,.06]]), grip);
  append(housing([[.388,x+towardThumb*.13,.104,.04,.046],[.445,x+towardThumb*.16,.104,.086,.068],
    [.475,x+towardThumb*.13,.10,.058,.048]]), grip);
  append(disk(.105,.025).translate(x-towardThumb*.20,.005,.16), frame);
  for (const key of ['ministick','upper-hat','lower-hat','thumb-hat','rocker','upper-button','lower-button','pinky']) {
    const r = key === 'ministick' ? .067 : key === 'pinky' ? .03 : .046;
    control(key, disk(r,.065,16), .065, cap);
  }
  control('scroll', box(.032,.025,.061), .025, cap);
  for (const key of ['trigger','flip','brake']) control(key, box(.073,.04,.15), .04, cap);
}

const bounds = {
  right: [[-.341,-.951,-.446],[.334,.951,.438]],
  left: [[-.254,-.951,-.446],[.421,.951,.438]],
};
function deviceSpec(side, name, prefix) {
  return { name, focus: name, prefix, model: modelAssetsByRig[virpilAlphaId][side],
    ...(side === 'left' ? { mirrorOf: 'right', mirrorOffsetX: -.08 } : {}),
    scale: 1, bounds: bounds[side], rotationY: Math.PI };
}
export const virpilAlpha = {
  id: virpilAlphaId, family: 'virpil', name: 'VIRPIL Constellation ALPHA Prime',
  shortName: 'VIRPIL ALPHA Prime',
  starterLayout: 'starter:virpil',
  controlsByDevice: {
    left: controlsFor('left'), right: controlsFor('right'),
    pedals: [
      { device: 'pedals', key: 'z', kind: 'axis', group: 'rudder', label: 'Rudder axis' },
      { device: 'pedals', key: 'left-toe', kind: 'axis', group: 'left-toe', label: 'Left toe brake', needsCapture: true },
      { device: 'pedals', key: 'right-toe', kind: 'axis', group: 'right-toe', label: 'Right toe brake', needsCapture: true },
    ],
  },
  devices: {
    left: deviceSpec('left', 'Left', 'L'), right: deviceSpec('right', 'Right', 'R'),
    pedals: { name: 'R1-FALCON pedals', focus: 'Pedals', prefix: 'Pedals', matches: isFalconPedals, starterLayout: falconStarterId,
      model: modelAssetsByRig[virpilAlphaId].pedals, scale: .90,
      bounds: [[-.951,-.427,-.559],[.951,.414,.564]] },
  },
  deskPositions(_placement, pedals) {
    if (pedals) return { left: [-.94,-.24], right: [.86,-.24], pedals: [0,1.13] };
    return { left: [-.72,0], right: [.64,0] };
  },
  anchors, surfaceNormals,
  markerFacing: (side, group) => surfaceNormals[side][group],
  createFallback: side => createSchematic(side, { anchors, surfaceNormals, build: buildSchematic }),
};
