import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { calloutDirection, placeCallout } from '../rig/callout-layout.js';
import { projectSurfaceHeading } from '../rig/surface-mask.js';

const width = 800, height = 440;
const clear = { coverage: () => 0 };

function intersection(a, b) {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

function checkBox(row, box) {
  // A leader must visibly connect the control to the perimeter of its own chip.
  const epsilon = 0.01;
  assert.equal(box.w, row.w);
  assert.equal(box.h, row.h);
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= width && box.y + box.h <= height, 'chip fits on screen');
  assert.ok(box.endX >= box.x - epsilon && box.endX <= box.x + box.w + epsilon);
  assert.ok(box.endY >= box.y - epsilon && box.endY <= box.y + box.h + epsilon);
  const edge = Math.min(Math.abs(box.endX - box.x), Math.abs(box.endX - box.x - box.w),
    Math.abs(box.endY - box.y), Math.abs(box.endY - box.y - box.h));
  assert.ok(edge <= epsilon, 'leader ends on the chip perimeter');
  assert.ok(Math.hypot(box.endX - row.ax, box.endY - row.ay) > 1, 'leader has visible length');
}

test('leaders extend along unobstructed face normals in overview and focused views', () => {
  for (const focused of [false, true]) {
    for (const [dx, dy] of [[1, 0], [0, -1], [-Math.SQRT1_2, Math.SQRT1_2]]) {
      const row = { ax: 400, ay: 220, w: 82, h: 21, item: { device: 'left' } };
      // The device center would suggest exactly the wrong direction on its own.
      Object.assign(row, calloutDirection(row, [row], { x: row.ax + dx * 50, y: row.ay + dy * 50 },
        { x: dx, y: dy, magnitude: 1 }, 80));
      const box = placeCallout(row, [row], [], width, height, clear, focused);
      checkBox(row, box);
      const x = box.endX - row.ax, y = box.endY - row.ay;
      assert.ok(Math.hypot(x, y) >= 15, 'unobstructed label leaves room to see the control');
      assert.ok((x * dx + y * dy) / Math.hypot(x, y) > 0.92, 'leader follows the projected face');
    }
  }
});

test('neighboring edge controls stay on screen and clear the toolbar and previously placed labels', () => {
  const rows = [185, 200, 215, 233].map(ay => ({ ax: 785, ay, w: 85, h: 19, dx: 1, dy: 0 }));
  const taken = [{ x: 696, y: 145, w: 96, h: 31, reserved: true }];
  for (const row of rows) {
    const box = placeCallout(row, rows, taken, width, height, clear, true);
    checkBox(row, box);
    assert.ok(taken.every(prior => intersection(box, prior) === 0), 'no overlapping chip or reserved toolbar');
    taken.push({ ...box, row });
  }
});

test('a chip clears a projected housing when the surface heading points over it', () => {
  const housing = { x: 207, y: 120, w: 200, h: 105 };
  const row = { ax: 211, ay: 217, w: 91, h: 22, dx: 1, dy: 0 };
  const geometry = { coverage: (x, y, w, h) => intersection({ x, y, w, h }, housing) / (w * h) };
  const box = placeCallout(row, [row], [], width, height, geometry, true);
  checkBox(row, box);
  assert.equal(intersection(box, housing), 0, 'a nearby open position is available');
});

test('camera orbit changes a face heading and a head-on control has no projected direction', () => {
  const camera = new PerspectiveCamera(38, width / height, 0.01, 100);
  const center = new Vector3();
  for (const side of [1, -1]) {
    camera.position.set(0, 0, 5 * side);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    const right = projectSurfaceHeading(center, new Vector3(1, 0, 0), camera, width, height);
    const up = projectSurfaceHeading(center, new Vector3(0, 1, 0), camera, width, height);
    assert.ok(right.x * side > 0.99 && right.magnitude > 0.9);
    assert.ok(up.y < -0.99, 'positive world Y projects upward in screen coordinates');
    const point = new Vector3(0.75, 0.35, 0.4);
    const headOn = camera.position.clone().sub(point).normalize();
    const projected = projectSurfaceHeading(point, headOn, camera, width, height);
    assert.ok(projected.magnitude < 0.0001);
    assert.ok(Math.hypot(projected.x, projected.y) < 0.0001, 'head-on surface leaves the heading to the layout fallback');
    const screen = point.clone().project(camera);
    const row = { ax: (screen.x + 1) * width / 2, ay: (1 - screen.y) * height / 2, w: 80, h: 20, item: { device: 'left' } };
    const neighbor = { ...row, ax: row.ax - 22 };
    const rows = [row, neighbor];
    Object.assign(row, calloutDirection(row, rows, { x: row.ax - 75, y: row.ay }, projected, 80));
    assert.ok(row.dx > 0.99, 'head-on label heads away from its neighboring control');
    const box = placeCallout(row, rows, [], width, height, clear, true);
    checkBox(row, box);
    assert.ok(box.endX > row.ax, 'visible leader extends along the fallback heading');
  }
});
