const shapes = {
  rig: '<rect x="2" y="12" width="8" height="8" rx="1"/><path d="M6 12V5l2-2 2 2-3 4M16 12V5l2-2 2 2-3 4"/><rect x="14" y="12" width="8" height="8" rx="1"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1"/>',
  pulse: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  reload: '<path d="M20 7v5h-5M19.5 12a7.5 7.5 0 1 0-2 5.2"/>',
  cube: '<path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10"/>',
  home: '<path d="M3 9V4h5M16 4h5v5M3 15v5h5M21 15v5h-5"/><circle cx="12" cy="12" r="3"/>',
  orbit:
    '<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-28 12 12)"/>',
  connect: '<path d="M4 16v-4h7v6H7v3M8 7V3m3 4V3M6 7h7v4M13 14h6v-4M17 8h4v3"/>',
  settings:
    '<path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="12" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  cross: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
};
export function addIcons(root = document) {
  for (const icon of root.querySelectorAll('i[data-icon]:empty')) {
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24">' + (shapes[icon.dataset.icon] || '') + '</svg>';
  }
}
