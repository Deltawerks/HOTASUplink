export const falconStarterId = 'starter:virpil-pedals';

export const falconStarterActions = {
  z: { context: 'spaceship_movement', action: 'v_roll', label: 'Roll' },
  'left-toe': { context: 'vehicle_driver', action: 'v_move_back', label: 'Drive backward' },
  'right-toe': { context: 'vehicle_driver', action: 'v_move_forward', label: 'Drive forward' },
};

export function canonicalToeAxis(raw) {
  if (typeof raw !== 'string') return null;
  const axis = raw.trim().toLowerCase().replace(/^r([xyz])$/, 'rot$1');
  return /^(?:[xy]|rot[xyz]|slider[12])$/.test(axis) ? axis : null;
}
