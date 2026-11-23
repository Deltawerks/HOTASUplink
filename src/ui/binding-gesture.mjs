export function normalizeActivationMode(value) {
  const mode = (value || '').toLowerCase().replace(/[_ -]/g, '');
  return ['', 'press', 'onpress'].includes(mode) ? 'press' : mode;
}
