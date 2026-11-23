export const falconPedalName = 'VPC R1-FALCON Pedals';

export function isFalconPedals(device) {
  const product = typeof device === 'string' ? device : device?.product || device?.name || '';
  const guid = product.match(/\{([\da-f]{4})([\da-f]{4})-/i);
  const vid = (device?.vid || guid?.[2] || '').toLowerCase();
  const pid = (device?.pid || guid?.[1] || '').toLowerCase();
  if (vid && vid !== '3344') return false;
  if (vid === '3344' && pid === '01fa') return true;
  const name = product.split('{')[0].trim();
  return /^(?:(?:vpc|virpil)\s+)?r1[-\s]+falcon\s+(?:rudder\s+)?pedals$/i.test(name);
}

// A VIRPIL grip can report the name of its base. A vendor ID alone also covers
// pedals, throttles and panels, so it cannot identify a stick or its hand.
export function stickFamily(device) {
  const product = typeof device === 'string' ? device : device?.product || device?.name || '';
  const name = product.split('{')[0];
  const vid = (typeof device === 'object' && device?.vid || product.match(/\{[\da-f]{4}([\da-f]{4})-/i)?.[1] || '').toLowerCase();
  if (isFalconPedals(device) || /\b(?:pedals?|rudder)\b/i.test(name)) return null;
  if (vid === '231d' || (!vid && /vkb/i.test(name))) return 'vkb';
  if (vid === '3344' || (!vid && /\b(?:vpc|virpil)\b/i.test(name))) {
    if (/\b(?:throttle|panel|collective)\b/i.test(name)) return null;
    return /\b(?:stick|joystick|alpha|warbrd|grip)\b|\bMT-50CM3\b/i.test(name) ? 'virpil' : null;
  }
  // Uplink's manually assigned, unnamed slots predate the controller selector.
  if (!product && (device?.device === 'left' || device?.device === 'right')) return device.family || 'vkb';
  return null;
}

export function stickHand(device) {
  if (!stickFamily(device)) return 'unknown';
  const name = (typeof device === 'string' ? device : device?.product || device?.name || '').split('{')[0];
  const left = /\b(?:l|lh|left)\b/i.test(name);
  const right = /\b(?:r|rh|right)\b/i.test(name);
  return left === right ? 'unknown' : left ? 'left' : 'right';
}
