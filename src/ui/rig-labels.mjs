// Flying changes the reading order. Every action, alternate context and
// activation gesture remains available, including identifiers missing a game label.
function flightPriority(row) {
  const context = (row.context || '').toLowerCase();
  if (/^(spectator|flashui)/.test(context) || /^(flashui|spectator)[ _]/i.test(row.action || row.label || '')) return 3;
  if (/^(spaceship|flight)(_|$)/.test(context)) return 0;
  if (['seat_general', 'lights_controller', 'vehicle_mfd', 'vehicle_general'].includes(context) || /^turret(_|$)/.test(context)) return 1;
  return 2;
}

export function orderedActions(control, context = 'all') {
  return context === 'flying' ? [...control.rows].sort((a, b) => flightPriority(a) - flightPriority(b)) : [...control.rows];
}

function actionName({ label, action, gesture }) {
  const name = label || action;
  if (!gesture || !/double|hold|long|release|\d taps/i.test(gesture) || name.toLowerCase().includes(gesture.toLowerCase())) return name;
  return name + ' · ' + gesture;
}

export function actionNames(control, context = 'all') {
  return [...new Set(orderedActions(control, context).map(actionName))];
}

export function canLocate(control) {
  return ['left', 'right', 'sem'].includes(control.device)
    && !['unmapped', 'inactive'].includes(control.group);
}

function detailLabel(control, count) {
  const code = control.key.replace(/^button(\d+)$/, 'B$1').toUpperCase();
  const detail = control.label.split(' · ')[1] || '';
  const caption = detail.charAt(0).toUpperCase() + detail.slice(1);
  if (/^B\d+$/.test(code) && count > 1) return [caption, code].filter(Boolean).join(' · ');
  return /^B\d+$/.test(code) ? code : caption || code;
}

// These are short names for game actions. Their control, direction and
// priority always come from the selected layout.
const flightNames = new Map(Object.entries({
  v_toggle_qdrive_engagement: 'Engage quantum',
  v_inc_scan_focus_level: 'Scan angle +',
  v_dec_scan_focus_level: 'Scan angle −',
  v_weapon_toggle_launch_missile: 'Launch missiles',
  v_weapon_cycle_missile_fwd: 'Next missile type',
  v_weapon_countermeasure_decoy_launch: 'Launch decoys',
  v_weapon_countermeasure_noise_launch: 'Deploy noise',
  v_weapon_countermeasure_decoy_burst_decrease: 'Decoy burst −',
  v_weapon_countermeasure_decoy_burst_increase: 'Decoy burst +',
  v_weapon_decrease_max_missiles: 'Armed missiles −',
  v_weapon_increase_max_missiles: 'Armed missiles +',
  v_weapon_launch_missile_cinematic: 'Cinematic launch',
  v_weapon_pip_toggle_lead_lag: 'Lead / lag PIPs',
  v_flightready: 'Flight ready',
  v_atc_request: 'Request landing',
  v_deploy_landing_system: 'Gear down',
  v_retract_landing_system: 'Gear up',
  v_ifcs_speed_limiter_decrement: 'Speed limit −',
  v_ifcs_speed_limiter_increment: 'Speed limit +',
  v_ifcs_speed_limiter_toggle: 'Toggle speed limit',
  v_ifcs_throttle_swap_mode: 'Cruise mode',
  v_ifcs_toggle_esp: 'Toggle ESP',
  v_ifcs_toggle_gforce_safety: 'G-force safety',
  v_ifcs_vector_decoupling_toggle: 'Coupled / decoupled',
  v_ads_stable_max_zoom_hold: 'Precision zoom',
  v_ads_toggle: 'Precision targeting',
  v_target_cycle_subitem_back: 'Prev subtarget',
  v_target_cycle_subitem_fwd: 'Next subtarget',
  v_target_cycle_subitem_reset: 'Main target',
  v_target_cycle_friendly_fwd: 'Next friendly',
  v_target_cycle_hostile_fwd: 'Next hostile',
  v_target_cycle_hostile_reset: 'Closest hostile',
  v_target_under_reticle: 'Lock under reticle',
  v_target_unlock: 'Unlock target',
  v_shield_reset_level: 'Balance shields',
  v_invoke_ping: 'Ping',
  v_view_cycle_fwd: 'Cycle camera',
  v_view_dynamic_zoom_abs: 'Dynamic zoom',
  turret_toggle_mouse_mode: 'Turret mouse mode',
  turret_gyromode: 'Turret gyro',
}));

function compactAction(row) {
  if (!row) return '';
  if (flightNames.has(row.action)) return flightNames.get(row.action);
  const full = row.label || (row.action || '').replace(/^v_/, '').replaceAll('_', ' ');
  // Keep distinguishing numbers, directions, modes and words even when a
  // future game action has a long name. The renderer can wrap long labels.
  const short = full
    .replace(/^Weapon Presets\s*[-–]\s*Fire Guns Group (\d+)$/i, 'Fire guns $1')
    .replace(/^Shield raise level (front|back|left|right)$/i, 'Shields $1')
    .replace(/^Engineering assignment (engines?|weapons?|shields?) max$/i, '$1 max')
    .replace(/\s*\((?:abs\.?|rel\.?|axis\s*\/\s*hotas|(?:press|hold|tap|toggle)(?:\s*[&/]\s*(?:press|hold|tap|toggle|release))*)\)\s*$/i, '')
    .replace(/\s*[-–]\s*increase$/i, ' +')
    .replace(/\s*[-–]\s*decrease$/i, ' −')
    .replace(/\s+[-–]\s+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return short ? short.charAt(0).toUpperCase() + short.slice(1) : full;
}

function describe(control, count, context, selected, editedIds, compact = false) {
  const rows = orderedActions(control, context);
  const actions = rows.map(row => ({
    name: actionName(row),
    context: row.contextLabel || row.context || '',
    ...(compact ? { label: row.label || row.action, gesture: row.gesture || '', action: row.action, contextId: row.context,
      activationMode: row.activationMode || '', multiTap: row.multiTap || 1 } : {}),
  }));
  const names = [...new Set(actions.map(action => action.name))];
  return { key: control.key, label: detailLabel(control, count), actions,
    ...(compact ? { compactName: compactAction(rows[0]), controlLabel: control.label,
      direction: control.direction || (control.group === 'pov' && povAxes[control.key]) || '' } : {}),
    text: names.join('\n') || (control.needsCapture ? 'Input number unverified' : 'Unassigned'),
    active: control.id === selected, edited: Boolean(editedIds?.has(control.id)) };
}

const stickHats = new Set(['a3', 'a4', 'c1', 'pov']);
const povAxes = { rotx: 'horizontal', roty: 'vertical' };

function firstAssigned(controls, context) {
  const candidates = controls.filter(control => control.rows.length);
  if (context !== 'flying') return candidates[0];
  let best, score = Infinity;
  for (const control of candidates) {
    const priority = Math.min(...control.rows.map(flightPriority));
    if (priority < score) { best = control; score = priority; }
  }
  return best;
}

export function rigLabels(sheet, focus, selected, { reference = false, context = 'all', editing = false, compact = false, editedIds, placement = 'right' } = {}) {
  compact = compact && !reference;
  const current = sheet.find(control => control.id === selected && canLocate(control));
  if (focus === 'all' && !reference && !compact) {
    if (!current) return [];
    const item = describe(current, 1, context, selected, editedIds);
    return [{ ...item, device: current.device, controlLabel: current.label }];
  }

  const groups = new Map();
  for (const control of sheet) {
    if ((focus !== 'all' && control.device !== focus) || !canLocate(control)) continue;
    if (compact && control.device === 'sem' && placement === 'off') continue;
    const id = control.device + '/' + control.group;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(control);
  }
  const unitNames = { left: 'Left', right: 'Right', sem: 'SEM' };
  const visible = [...groups.values()].filter(controls => !compact || controls.some(control => control.rows.length || control === current));
  return visible.map(controls => {
    const { device, group } = controls[0];
    const chosen = controls.find(control => control.id === selected);
    const edited = controls.find(control => editedIds?.has(control.id));
    const representative = chosen || edited || firstAssigned(controls, context) || controls[0];
    const firstLabel = controls[0].label;
    const hat = compact && device !== 'sem' && stickHats.has(group);
    const title = group === 'pov' ? 'A1 POV / ministick' : hat || controls.length > 1 ? firstLabel.split(' · ')[0] : firstLabel;
    const groupEntries = controls.map(control => describe(control, controls.length, context, selected, editedIds, compact));
    const item = groupEntries.find(entry => entry.key === representative.key);
    // A1's digital POV and analogue ministick share one physical cap. Show all
    // its directions and any bound axes; the detailed popup lists both modes.
    const hatSlots = hat && groupEntries.filter(entry => entry.direction && (!povAxes[entry.key] || entry.actions.length));
    return { ...item, device, group, groupTitle: title, groupEntries,
      ...(compact ? { compact: true, compactName: hat ? title : item.compactName || 'Unassigned' } : {}),
      ...(hat ? { hatSlots } : {}),
      deviceTitle: focus === 'all' ? unitNames[device] : '', reference,
      referenceSide: reference && focus === 'all' ? (device === 'sem' ? placement : device) : undefined,
      dimmed: Boolean(editing && !reference && !compact && current && current.device === focus && !chosen) };
  });
}
