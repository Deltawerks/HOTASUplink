import { anchors, surfaceNormals } from './anchors.js';
import { controlsByDevice } from './controls.js';
import { createSchematic } from './schematic.js';
import { defaultRigId, modelAssetsByRig } from './model-assets.mjs';

// Device IDs connect the model, its control inventory, and the inputs on the sheet.
export const defaultRig = {
  id: defaultRigId,
  name: 'VKB Gladiator EVO / Omni-Throttle',
  controlsByDevice, anchors, surfaceNormals, createFallback: createSchematic,
  devices: {
    left: {
      name: 'Left Omni', focus: 'Left', prefix: 'L',
      model: modelAssetsByRig[defaultRigId].left,
      scale: .92, bounds: [[-.715,-.949,-.755],[.714,.948,.756]],
      darkenPlastic: true,
    },
    right: {
      name: 'Right stick', focus: 'Right', prefix: 'R',
      model: modelAssetsByRig[defaultRigId].right,
      scale: 1, bounds: [[-.515,-.951,-.723],[.516,.949,.722]], rotationY: -Math.PI / 2,
    },
    sem: {
      name: 'SEM', focus: 'SEM', prefix: 'SEM', code: 'GNX SEM',
      model: modelAssetsByRig[defaultRigId].sem,
      scale: .59, bounds: [[-.951,-.505,-.736],[.95,.504,.737]],
    },
  },
  // Layout positions on the desk plane. An omitted module is unmounted.
  deskPositions(placement) {
    const shift = placement === 'left' ? .48 : placement === 'right' ? -.48 : 0;
    const positions = { left: [-.82 + shift, 0], right: [.82 + shift, 0] };
    if (placement === 'left') positions.sem = [positions.left[0] - 1.1, .17];
    if (placement === 'right') positions.sem = [positions.right[0] + 1.09, .17];
    return positions;
  },
  markerFacing(device, group) {
    if (device === 'sem') return group === 'mode' || group === 'c1' ? [0,.32,1] : [0,1,.1];
    if (group === 'c1') return [device === 'left' ? 1 : -1,.1,.15];
    if (device === 'right' && group === 'b1') return [1,.05,-.18];
    if (group === 'trigger' || group === 'speed' || group === 'd1' || group === 'b1') {
      return [device === 'left' ? -.28 : .28,.04,-1];
    }
    return group.startsWith('f') ? [0,1,.3] : [0,.4,1];
  },
};

export const rigProfiles = [defaultRig];

export function rigForId(id) {
  return rigProfiles.find(rig => rig.id === id) || defaultRig;
}
