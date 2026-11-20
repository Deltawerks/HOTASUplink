const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
const angles = [0, 18, -18, 36, -36, 60, -60, 90, -90, 120, -120, 150, -150, 180]
  .map(degrees => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)]);
const distances = [1, 1.55, 2.2, 3.2, 4.3, .58];
const crowdedDistances = [...distances, 5.8, 7.5];

export function overlap(x, y, w, h, rect) {
  return Math.max(0, Math.min(x + w, rect.x + rect.w + 3) - Math.max(x, rect.x - 3))
    * Math.max(0, Math.min(y + h, rect.y + rect.h + 2) - Math.max(y, rect.y - 2));
}

function throughBox(ax, ay, bx, by, x, y, w, h) {
  const dx = (bx - ax) / 2, dy = (by - ay) / 2;
  const mx = ax + dx - x - w / 2, my = ay + dy - y - h / 2;
  return Math.abs(mx) < w / 2 + Math.abs(dx) && Math.abs(my) < h / 2 + Math.abs(dy)
    && Math.abs(dx * my - dy * mx) < (w * Math.abs(dy) + h * Math.abs(dx)) / 2;
}

export function leaderHitsBox(leader, box) {
  return throughBox(leader.row.ax, leader.row.ay, leader.endX, leader.endY, box.x, box.y, box.w, box.h);
}

function crosses(ax, ay, bx, by, cx, cy, dx, dy) {
  const x = bx - ax, y = by - ay, u = dx - cx, v = dy - cy;
  return ((cx - ax) * y - (cy - ay) * x) * ((dx - ax) * y - (dy - ay) * x) < 0
    && ((ax - cx) * v - (ay - cy) * u) * ((bx - cx) * v - (by - cy) * u) < 0;
}

// A face-on surface normal has essentially no direction on screen. In that
// case spread controls toward the free sides of their local hat or base cluster.
export function calloutDirection(row, visible, center, normal, radius) {
  let x = 0, y = 0, weight = 0;
  for (const other of visible) {
    if (other === row || other.item.device !== row.item.device) continue;
    const dx = row.ax - other.ax, dy = row.ay - other.ay;
    const proximity = Math.max(0, 1 - Math.hypot(dx, dy) / radius);
    x += dx * proximity; y += dy * proximity; weight += proximity;
  }
  const mx = row.ax - center.x, my = row.ay - center.y;
  const distance = Math.max(1, Math.hypot(mx, my));
  x = x / Math.max(1, weight) + 12 * mx / distance;
  y = y / Math.max(1, weight) + 12 * my / distance;
  const length = Math.hypot(x, y);
  const fx = length > 1 ? x / length : 0, fy = length > 1 ? y / length : -1;
  const strength = clamp(((normal?.magnitude || 0) - .07) / .53, 0, 1);
  // Interpolate angles so opposing vectors never cancel each other out.
  const turn = strength ? Math.atan2(fx * normal.y - fy * normal.x, fx * normal.x + fy * normal.y) : 0;
  const angle = Math.atan2(fy, fx) + strength * turn;
  return { dx: Math.cos(angle), dy: Math.sin(angle), fx, fy };
}

// Search along the projected normal first, then fan out around it when the
// hardware silhouette, another leader, or the viewport edge occupies that space.
export function placeCallout(row, visible, taken, width, height, geometry, focused, initialBox) {
  const { ax, ay, w, h } = row;
  const clearance = focused ? clamp(Math.min(width, height) * .078, 28, 68)
    : clamp(Math.min(width, height) * .054, 18, 44);
  let best, bestCost = Infinity, bestOverlap = Infinity;
  function consider(px, py) {
    const x = clamp(Math.round(px), 3, width - w - 3), y = clamp(Math.round(py), 3, height - h - 3);
    let occupied = 0;
    for (const other of taken) occupied += overlap(x, y, w, h, other) * (other.reserved ? 3 : 1);
    if (occupied > bestOverlap) return;
    const cx = x + w / 2 - ax, cy = y + h / 2 - ay;
    const distance = Math.hypot(cx, cy) || 1;
    const ux = cx / distance, uy = cy / distance;
    // Clip the ray to the near side of the card, even when the card had to
    // slide inside the viewport or its direction is almost vertical.
    const inset = Math.min(w / (2 * Math.max(.00001, Math.abs(ux))), h / (2 * Math.max(.00001, Math.abs(uy))));
    const gap = Math.max(0, distance - inset), endX = ax + gap * ux, endY = ay + gap * uy;
    const under = Math.max(0, clearance - gap);
    let cost = under * 3 + Math.max(0, gap - clearance) * .58
      + (1 - ux * row.dx - uy * row.dy) * 40
      + geometry.coverage(x - 2, y - 2, w + 4, h + 4) * 380;
    if (row.fx !== undefined) cost += (1 - ux * row.fx - uy * row.fy) * 9;
    if (occupied === bestOverlap && cost >= bestCost) return;
    for (const anchor of visible) {
      if (anchor.ax > x - 4 && anchor.ax < x + w + 4 && anchor.ay > y - 4 && anchor.ay < y + h + 4) cost += 800;
    }
    for (const other of taken) {
      if (throughBox(ax, ay, endX, endY, other.x, other.y, other.w, other.h)) cost += 330;
      if (!other.row) continue;
      const { ax: ox, ay: oy } = other.row;
      // A row of hats that is wide from the front can become a single stack
      // from the side. Give neighboring controls different elevations when
      // first placing their pins, especially for multi-line direction cards.
      if (focused && Math.hypot(ax - ox, ay - oy) < Math.min(width, height) * .32) {
        const verticalClearance = Math.abs(y + h / 2 - other.y - other.h / 2) - (h + other.h) / 2;
        cost += Math.max(0, 9 - verticalClearance) * (Math.max(h, other.h) > 30 ? 4 : 1.5);
      }
      if (throughBox(ox, oy, other.endX, other.endY, x, y, w, h)) cost += 330;
      if (crosses(ax, ay, endX, endY, ox, oy, other.endX, other.endY)) cost += 80;
    }
    // Prefer to exit a housing promptly when several card locations are free.
    // Sampling along the connector avoids running down the length of a grip.
    if (occupied === bestOverlap && cost >= bestCost) return;
    for (const t of [.3, .65]) cost += geometry.coverage(ax + ux * gap * t - 2, ay + uy * gap * t - 2, 4, 4) * gap * .35;
    if (occupied < bestOverlap || cost < bestCost) {
      bestOverlap = occupied; bestCost = cost;
      best = { x, y, w, h, endX, endY, ux, uy, gap };
    }
  }
  function along(ux, uy, gap) {
    const inset = Math.min(w / (2 * Math.max(.00001, Math.abs(ux))), h / (2 * Math.max(.00001, Math.abs(uy))));
    consider(ax + ux * (inset + gap) - w / 2, ay + uy * (inset + gap) - h / 2);
  }
  if (initialBox) consider(initialBox.x, initialBox.y);
  for (const [cos, sin] of angles) {
    const ux = row.dx * cos - row.dy * sin, uy = row.dx * sin + row.dy * cos;
    for (const scale of (!focused && width < 630 ? crowdedDistances : distances)) along(ux, uy, clearance * scale);
  }
  if (initialBox && !focused && width < 630 && bestCost >= 300) {
    // At minimum window width the open slot may lie just beside a chip
    // between two sampled rays. Try its edges with a short, straight leader.
    for (const other of taken) {
      const nearX = clamp(ax - w / 2, other.x - w, other.x + other.w);
      const nearY = clamp(ay - h / 2, other.y - h, other.y + other.h);
      for (const x of [other.x - w - 4, other.x + other.w + 4]) {
        for (const y of [nearY, other.y, other.y + other.h - h]) consider(x, y);
      }
      for (const y of [other.y - h - 4, other.y + other.h + 4]) {
        for (const x of [nearX, other.x, other.x + other.w - w]) consider(x, y);
      }
    }
  }
  if (bestOverlap > 0) {
    // Find a free slot between cards in the crowded whole-rig view.
    const xs = new Set([3, width - w - 3, ax - w / 2]), ys = new Set([3, height - h - 3, ay - h / 2]);
    for (const other of taken) {
      xs.add(other.x - w - 4); xs.add(other.x + other.w + 4);
      ys.add(other.y - h - 4); ys.add(other.y + other.h + 4);
    }
    for (const x of xs) for (const y of ys) consider(x, y);
  }
  return best;
}
