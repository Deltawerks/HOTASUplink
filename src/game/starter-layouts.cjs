'use strict';

const { hostHint, physicalHintComment } = require('./export.cjs');
const { falconPedalName } = require('../rig/device-identity.mjs');
const { falconStarterActions, falconStarterId, canonicalToeAxis } = require('../rig/falcon-starter.mjs');

// Original HOTAS Uplink flight bindings. The two input columns follow the VKB
// SCG Premium and VPC ALPHA Prime grip charts. Numbers denote DirectInput buttons.
// The action IDs and activation modes were checked against Star Citizen 4.10.
const movement = 'spaceship_movement';
const shields = 'spaceship_defensive';
const targeting = 'spaceship_targeting';
const cycling = 'spaceship_targeting_advanced';
const weapons = 'spaceship_weapons';
const contexts = {
  [movement]: 'Flight movement', [shields]: 'Ship defenses', [targeting]: 'Targeting',
  [cycling]: 'Target cycling', [weapons]: 'Ship weapons', spaceship_radar: 'Radar',
  lights_controller: 'Vehicle lights', vehicle_driver: 'Ground vehicle movement'
};

// Context, action, offline label, activation mode, VKB input, VIRPIL input.
const bindings = {
  left: [
    [movement, 'v_strafe_lateral', 'Strafe left / right', '', 'x', 'x'],
    [movement, 'v_strafe_longitudinal', 'Throttle forward / back', '', 'y', 'y'],
    [movement, 'v_strafe_vertical', 'Strafe up / down', '', 'rotz', 'z'],
    [movement, 'v_afterburner', 'Boost', 'all', 1, 4],
    [movement, 'v_space_brake', 'Space brake', '', 4, 32],
    [movement, 'v_toggle_landing_system', 'Toggle landing gear', 'tap', 3, 7],
    [movement, 'v_atc_request', 'Request landing', 'tap', 5, 13],
    [movement, 'v_ifcs_speed_limiter_increment', 'Increase speed limit', 'press', 11, 9],
    [movement, 'v_ifcs_speed_limiter_decrement', 'Decrease speed limit', 'press', 13, 11],
    [movement, 'v_ifcs_speed_limiter_toggle', 'Toggle speed limiter', 'tap', 15, 8],
    [shields, 'v_shield_raise_level_forward', 'Shields forward', 'press', 6, 15],
    [shields, 'v_shield_raise_level_right', 'Shields right', 'press', 7, 16],
    [shields, 'v_shield_raise_level_back', 'Shields rear', 'press', 8, 17],
    [shields, 'v_shield_raise_level_left', 'Shields left', 'press', 9, 18],
    [shields, 'v_shield_reset_level', 'Balance shields', 'press', 10, 14],
    ['spaceship_radar', 'v_invoke_ping', 'Radar ping', 'hold', 16, 24],
    ['lights_controller', 'v_lights', 'Toggle headlights', 'press', 20, 23]
  ],
  right: [
    [movement, 'v_yaw', 'Yaw', '', 'x', 'x'],
    [movement, 'v_pitch', 'Pitch', '', 'y', 'y'],
    [movement, 'v_roll', 'Roll', '', 'rotz', 'z'],
    [weapons, 'v_weapon_preset_fire_guns0', 'Fire weapon group 1', 'all', 1, 4],
    [weapons, 'v_weapon_preset_fire_guns1', 'Fire weapon group 2', 'all', 2, 5],
    [shields, 'v_weapon_countermeasure_decoy_launch', 'Launch decoys', '', 3, 7],
    [shields, 'v_weapon_countermeasure_noise_launch', 'Deploy noise', 'press', 4, 13],
    [cycling, 'v_target_under_reticle', 'Target under reticle', 'tap', 11, 9],
    [cycling, 'v_target_cycle_hostile_fwd', 'Next hostile', 'tap', 12, 12],
    [cycling, 'v_target_cycle_hostile_reset', 'Closest hostile', 'tap', 13, 11],
    [cycling, 'v_target_cycle_hostile_back', 'Previous hostile', 'tap', 14, 10],
    [targeting, 'v_target_unlock', 'Unlock target', 'tap', 15, 8],
    [targeting, 'v_target_toggle_lock_index_1', 'Lock first pinned target', 'tap', 6, 15],
    [cycling, 'v_target_cycle_pinned_fwd', 'Next pinned target', 'tap', 7, 18],
    [cycling, 'v_target_cycle_pinned_reset', 'First pinned target', 'tap', 8, 17],
    [cycling, 'v_target_cycle_pinned_back', 'Previous pinned target', 'tap', 9, 16],
    [targeting, 'v_target_pin_selected', 'Pin selected target', 'tap', 10, 14]
  ]
};

const starters = {
  'starter:vkb': { kind: 'starter', path: 'starter:vkb', manufacturer: 'VKB', name: 'VKB Gladiator EVO flight starter' },
  'starter:virpil': { kind: 'starter', path: 'starter:virpil', manufacturer: 'VIRPIL', name: 'VIRPIL ALPHA Prime flight starter' },
  [falconStarterId]: { kind: 'starter', path: falconStarterId, manufacturer: 'VIRPIL', name: 'VIRPIL ALPHA Prime + R1-FALCON flight starter' }
};

const starterDefinitions = new Map();
for (const hand of Object.values(bindings)) {
  for (const [context, action, label, activationMode] of hand) {
    starterDefinitions.set(context + '/' + action, {
      context, action, label, contextLabel: contexts[context], activationMode,
      category: '', description: '', supportsJoystick: true, multiTap: 1, defaults: []
    });
  }
}

const pedalStarterDefinitions = new Map(starterDefinitions);
for (const { context, action, label } of Object.values(falconStarterActions)) {
  if (!pedalStarterDefinitions.has(context + '/' + action)) {
    pedalStarterDefinitions.set(context + '/' + action, {
      context, action, label, contextLabel: contexts[context], activationMode: '',
      category: '', description: '', supportsJoystick: true, multiTap: 1, defaults: []
    });
  }
}

function definitionsForStarter(path) {
  return path === falconStarterId ? pedalStarterDefinitions : starterDefinitions;
}

function validatedPedalAxes(raw) {
  const result = {};
  for (const toe of ['left-toe', 'right-toe']) {
    if (raw?.[toe] == null) continue;
    const axis = canonicalToeAxis(raw[toe]);
    if (!axis || Object.values(result).includes(axis)) throw new Error('Identify a distinct pedal axis for each toe brake in Settings.');
    result[toe] = axis;
  }
  return result;
}

function createStarterProfile(source, installedDefinitions) {
  const family = source.manufacturer.toLowerCase();
  const profile = { tag: 'ActionMaps', attrs: { profileName: source.name }, children: [] };
  const groups = new Map();
  const actions = new Map();
  function bind(context, action, input, toe) {
    if (!groups.has(context)) {
      const group = { tag: 'actionmap', attrs: { name: context }, children: [] };
      groups.set(context, group);
      profile.children.push(group);
    }
    const id = context + '/' + action;
    if (!actions.has(id)) {
      const node = { tag: 'action', attrs: { name: action }, children: [] };
      groups.get(context).children.push(node);
      actions.set(id, node);
    }
    const inputs = actions.get(id).children;
    const row = { tag: inputs.length ? 'addbind' : 'rebind', attrs: { input }, children: [] };
    if (toe) row.provenanceComment = physicalHintComment(context, action, row.attrs, 'pedals', toe);
    inputs.push(row);
  }

  for (const [device, slot] of [['right', 1], ['left', 2]]) {
    // Logical hands are portable between installations; device GUIDs belong to
    // the recipient's own profile. Apply resolves hands to their actual slots.
    profile.children.push({ tag: 'options', attrs: { type: 'joystick', instance: String(slot) }, children: [],
      provenanceComment: hostHint({ device, slot, family }) });
  }
  for (const [device, rows] of Object.entries(bindings)) {
    for (const [context, action, , , vkb, virpil] of rows) {
      const key = family === 'virpil' ? virpil : vkb;
      const input = typeof key === 'number' ? 'button' + key : key;
      bind(context, action, 'js' + (device === 'right' ? 1 : 2) + '_' + input);
    }
  }
  if (source.path === falconStarterId) {
    profile.children.push({ tag: 'options', attrs: { type: 'joystick', instance: '3', Product: falconPedalName }, children: [] });
    const main = falconStarterActions.z;
    bind(main.context, main.action, 'js3_z');
    for (const [toe, axis] of Object.entries(source.pedalAxes)) {
      const { context, action } = falconStarterActions[toe];
      bind(context, action, 'js3_' + axis, toe);
    }
  }
  // A game export inherits generic joystick bindings for any unspecified action.
  // Explicit clears keep an imported or reopened copy consistent with the preview.
  for (const [id, def] of installedDefinitions) {
    if (!actions.has(id) && def.defaults.some(row => row.input?.trim())) {
      bind(def.context, def.action, 'js1_ ');
    }
  }
  return profile;
}

module.exports = { starters, starterDefinitions, definitionsForStarter, validatedPedalAxes, createStarterProfile };
