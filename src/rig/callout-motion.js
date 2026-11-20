import { Quaternion, Vector3 } from 'three';
import { leaderHitsBox, overlap } from './callout-layout.js';

// A tile's center is a fixed device-local point. Only its projection changes
// when the user moves the rig.
export function projectPin(row, pin, width, height, camera, point) {
  row.unit.localToWorld(point.copy(pin)).project(camera);
  point.x = (1 + point.x) * width / 2;
  point.y = (1 - point.y) * height / 2;
  return point;
}

// The 2D layout fixes the chip's starting pixel, which leaves its depth along
// that viewing ray free. Prefer clearance along the button's measured normal.
// Nearby depths give crowded rows a little parallax as the hardware turns.
function depthOptions(row, box, width, height, camera, eye) {
  const { x, y, w, h } = box;
  const flat = new Vector3(2 * (x + w / 2) / width - 1, 1 - 2 * (y + h / 2) / height, row.depth);
  row.unit.worldToLocal(flat.unproject(camera));
  const toEye = row.unit.worldToLocal(eye.clone()).sub(flat);
  const eyeDistance = toEye.length();
  toEye.normalize();
  const normal = row.marker.userData.surfaceNormal;
  const reach = Math.min(.52, Math.max(.16, flat.distanceTo(row.marker.position)));
  const preferred = reach * normal.dot(toEye);
  return [0, -.5, .5, -1, 1].map(variation => {
    const depth = Math.min(eyeDistance * .22, preferred + variation * reach * .8);
    return { pin: flat.clone().addScaledVector(toEye, depth), bias: Math.abs(variation) * .16 };
  });
}

function rotatedViews(camera, eye, pivot) {
  const up = camera.up.clone().normalize();
  const across = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const yaw = [.36, .74, 1.16, 1.5, 1.82, 2.07, 2.42, 2.8];
  const poses = yaw.flatMap(angle => [[up, -angle], [up, angle]]);
  return [...poses, [up, Math.PI], [across, -.42], [across, .42]].map(([axis, angle]) => {
    const view = camera.clone(false);
    const rotation = new Quaternion().setFromAxisAngle(axis, angle);
    view.position.copy(eye).sub(pivot).applyQuaternion(rotation).add(pivot);
    camera.getWorldQuaternion(view.quaternion).premultiply(rotation);
    view.updateMatrixWorld();
    return { eye: view.position, projection: view.projectionMatrix.multiply(view.matrixWorldInverse) };
  });
}

function crowdCost(item, option, layout, best = Infinity) {
  let cost = option.bias;
  for (const other of layout) {
    if (item === other) continue;
    const minArea = Math.min(item.row.w * item.row.h, other.row.w * other.row.h);
    // Allow a little clearance between the sampled orbit angles as well.
    const halfWidth = (item.row.w + other.row.w) / 2 + 6;
    const halfHeight = (item.row.h + other.row.h) / 2 + 6;
    let worst = 0;
    for (let i = 0; i < option.centers.length; i++) {
      const a = option.centers[i], b = other.chosen.centers[i];
      if (!a || !b) continue;
      const w = Math.min(item.row.w, other.row.w, halfWidth - Math.abs(a.x - b.x));
      const h = Math.min(item.row.h, other.row.h, halfHeight - Math.abs(a.y - b.y));
      if (w <= 0 || h <= 0) continue;
      const area = w * h / minArea;
      cost += area;
      worst = Math.max(worst, area);
    }
    cost += worst;
    if (cost >= best) break;
  }
  return cost;
}

function clearAtStart(box, item, layout) {
  return layout.every(other => {
    const b = other.chosen.box;
    return other === item || (!overlap(box.x, box.y, box.w, box.h, b) && !leaderHitsBox(box, b) && !leaderHitsBox(b, box));
  });
}

// Choose depths once. Only the newly placed rows may change. Compare the
// projected chip rectangles from a few neighboring views without moving the
// real camera or modifying any previously pinned control.
export function pinNewRows(pending, visible, width, height, camera, orbitTarget, alternateBoxes) {
  if (!pending.length) return;
  const eye = camera.getWorldPosition(new Vector3());
  const point = new Vector3();
  const pivot = orbitTarget || new Vector3();
  if (!orbitTarget) {
    for (const row of visible) pivot.add(row.marker.getWorldPosition(point));
    pivot.multiplyScalar(1 / visible.length);
  }
  const views = rotatedViews(camera, eye, pivot);
  const fresh = new Set(pending);
  function projectOptions(row, seen, box, options) {
    const displacement = Math.hypot(box.x - row.box.x, box.y - row.box.y);
    for (const option of options) {
      option.box = box;
      option.bias += displacement * .004 + (box.penalty || 0);
      const world = row.unit.localToWorld(option.pin.clone());
      option.centers = views.map((view, i) => {
        if (!seen[i]) return null;
        point.copy(world).applyMatrix4(view.projection);
        if (!(point.z >= -1 && point.z <= 1)) return null;
        return { x: Math.max(row.w / 2 + 3, Math.min(width - row.w / 2 - 3, (1 + point.x) * width / 2)),
          y: Math.max(row.h / 2 + 3, Math.min(height - row.h / 2 - 3, (1 - point.y) * height / 2)) };
      });
    }
    return options;
  }
  const layout = visible.map(row => {
    const anchor = row.marker.getWorldPosition(new Vector3());
    const facing = row.marker.userData.facing.clone().transformDirection(row.unit.matrixWorld);
    const seen = views.map(view => point.subVectors(view.eye, anchor).normalize().dot(facing) > -.12);
    const initial = fresh.has(row) ? depthOptions(row, row.box, width, height, camera, eye) : [{ pin: row.pin, bias: 0 }];
    const options = projectOptions(row, seen, row.box, initial);
    return { row, seen, options, chosen: options[0] };
  });
  function choose(item, options) {
    let best = crowdCost(item, item.chosen, layout);
    for (const option of options) {
      const cost = crowdCost(item, option, layout, best);
      if (cost < best) { best = cost; item.chosen = option; }
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const item of layout) if (fresh.has(item.row)) choose(item, item.options);
  }
  if (alternateBoxes?.size) {
    // Only crowded new rows need another starting slot. Never displace an
    // existing pin. Reject a choice if its front view blocks another tile or
    // cuts its connector, including tiles already moved during this pass.
    const crowded = layout.filter(item => fresh.has(item.row) && alternateBoxes.has(item.row))
      .map(item => ({ item, crowd: crowdCost(item, item.chosen, layout) - item.chosen.bias }))
      .filter(({ crowd }) => crowd > .05).sort((a, b) => b.crowd - a.crowd);
    for (const { item } of crowded) {
      for (const box of alternateBoxes.get(item.row).slice(0, 12)) {
        if (!clearAtStart(box, item, layout)) continue;
        const options = depthOptions(item.row, box, width, height, camera, eye);
        choose(item, projectOptions(item.row, item.seen, box, options));
      }
    }
  }
  for (const item of layout) if (fresh.has(item.row)) {
    item.row.box = item.chosen.box;
    item.row.pin = item.chosen.pin;
  }
}

export function boxAt(row, cx, cy, width, height) {
  const { ax, ay, w, h } = row;
  const x = Math.max(3, Math.min(width - w - 3, cx - w / 2));
  const y = Math.max(3, Math.min(height - h - 3, cy - h / 2));
  const dx = ax - (x + w / 2), dy = ay - (y + h / 2);
  const edgeScale = Math.max(Math.abs(dx) / (w / 2), Math.abs(dy) / (h / 2));
  const endX = edgeScale ? x + w / 2 + dx / edgeScale : x;
  const endY = edgeScale ? y + h / 2 + dy / edgeScale : y + h / 2;
  return { x, y, w, h, endX, endY, row };
}

