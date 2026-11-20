import assert from 'node:assert/strict';
import test from 'node:test';
import { Group, PerspectiveCamera, Vector3 } from 'three';
import { boxAt, pinNewRows, projectPin } from '../rig/callout-motion.js';

function screenPoint(local, unit, camera, width, height) {
  const clip = local.clone().applyMatrix4(unit.matrixWorld)
    .applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
  return new Vector3((clip.x + 1) * width / 2, (1 - clip.y) * height / 2, clip.z);
}

function control(unit, camera, local, shiftX, shiftY, normal = new Vector3(0, 0, 1)) {
  const marker = new Group();
  unit.add(marker);
  marker.position.copy(local);
  marker.userData = { surfaceNormal: normal, facing: normal };
  const anchor = screenPoint(local, unit, camera, 800, 440);
  const w = 92, h = 22;
  const row = { unit, marker, depth: anchor.z, ax: anchor.x, ay: anchor.y, w, h };
  row.box = boxAt(row, anchor.x + shiftX, anchor.y + shiftY, 800, 440);
  return row;
}

test('the initial pixel is exact while a face-on tile stands off the button surface', () => {
  const unit = new Group();
  unit.updateMatrixWorld(true);
  const camera = new PerspectiveCamera(42, 800 / 440, .05, 50);
  camera.position.set(0, 0, 4);
  camera.updateMatrixWorld();
  const row = control(unit, camera, new Vector3(.15, .05, .3), 74, -18);
  pinNewRows([row], [row], 800, 440, camera);
  const projected = projectPin(row, row.pin, 800, 440, camera, new Vector3());
  assert.ok(Math.abs(projected.x - row.box.x - row.w / 2) < 1e-8);
  assert.ok(Math.abs(projected.y - row.box.y - row.h / 2) < 1e-8);
  assert.ok(row.pin.z - row.marker.position.z > .15, 'face-on pin has physical depth');
  assert.ok(row.pin.z - row.marker.position.z <= .52, 'depth stays proportional to the hardware');
});

test('rapid reversals and revealing a neighboring control preserve the same device-local pin', () => {
  const desk = new Group(), unit = new Group();
  desk.add(unit);
  desk.position.set(-.3, .1, .4);
  desk.rotation.set(.1, .35, -.16);
  unit.position.set(.25, -.1, .2);
  unit.rotation.set(.2, -.4, .1);
  unit.scale.set(1.3, .85, 1.1);
  desk.updateMatrixWorld(true);
  const camera = new PerspectiveCamera(42, 800 / 440, .05, 50);
  function turn(x, y, z) {
    camera.position.set(x, y, z);
    camera.lookAt(.2, .1, 0);
    camera.updateMatrixWorld();
  }
  turn(2, 1.5, 4);
  const row = control(unit, camera, new Vector3(.18, .36, .17), 62, -11);
  pinNewRows([row], [row], 800, 440, camera);
  const initial = row.pin.clone(), initialProjected = screenPoint(initial, unit, camera, 800, 440);
  const point = new Vector3();
  for (const pose of [[-1.5,2,4], [2.4,1.3,3], [-1,2.1,3.7], [2,1.5,4]]) {
    turn(...pose);
    const expected = screenPoint(initial, unit, camera, 800, 440);
    assert.ok(projectPin(row, row.pin, 800, 440, camera, point).distanceTo(expected) < 1e-8);
  }
  assert.ok(point.distanceTo(initialProjected) < 1e-8);
  row.marker.visible = false;
  turn(-2, .8, 4);
  const revealed = control(unit, camera, new Vector3(.3, .4, .2), 65, -20);
  pinNewRows([revealed], [revealed], 800, 440, camera);
  row.marker.visible = true;
  const third = control(unit, camera, new Vector3(.28, .44, .1), 12, 60);
  const identity = row.pin;
  pinNewRows([third], [row, revealed, third], 800, 440, camera);
  assert.equal(row.pin, identity, 'a new visible control cannot replace an existing pin');
  assert.ok(row.pin.equals(initial));
  turn(2, 1.5, 4);
  assert.ok(projectPin(row, row.pin, 800, 440, camera, point).distanceTo(initialProjected) < 1e-8);

  desk.rotation.y += .4;
  unit.position.x += .65;
  desk.updateMatrixWorld(true);
  camera.aspect = 430 / 700;
  camera.updateProjectionMatrix();
  const resized = screenPoint(initial, unit, camera, 430, 700);
  assert.ok(projectPin(row, row.pin, 430, 700, camera, point).distanceTo(resized) < 1e-8);
});

test('neighboring labels get fixed depths that reduce overlap through a side-on orbit', () => {
  const unit = new Group();
  unit.updateMatrixWorld();
  const camera = new PerspectiveCamera(42, 800 / 440, .05, 50);
  const pivot = new Vector3();
  camera.position.set(0, .3, 4);
  camera.lookAt(pivot);
  camera.updateMatrixWorld();
  const rows = [
    control(unit, camera, new Vector3(-.65, 0, .1), -36, 4),
    control(unit, camera, new Vector3(.65, 0, .1), 36, -4),
    control(unit, camera, new Vector3(.03, -.12, .2), 23, 34),
  ];
  function totalOverlap(pins) {
    let area = 0;
    for (let degrees = -86; degrees <= 86; degrees += 4) {
      const view = camera.clone();
      view.position.applyAxisAngle(camera.up, degrees * Math.PI / 180);
      view.lookAt(pivot);
      view.updateMatrixWorld();
      const points = pins.map((pin, i) => screenPoint(pin, rows[i].unit, view, 800, 440));
      for (let i = 0; i < points.length; i++) {
        for (let j = 0; j < i; j++) {
          area += Math.max(0, 92 - Math.abs(points[i].x - points[j].x))
            * Math.max(0, 22 - Math.abs(points[i].y - points[j].y));
        }
      }
    }
    return area;
  }
  for (const row of rows) pinNewRows([row], [row], 800, 440, camera, pivot);
  const independent = totalOverlap(rows.map(row => row.pin));
  pinNewRows(rows, rows, 800, 440, camera, pivot);
  assert.ok(independent > 0 && totalOverlap(rows.map(row => row.pin)) < independent * .6);

  // A second initial slot may improve the side view. A slot on top of an
  // existing chip is never eligible, even if it were clearer from the side.
  const fixed = rows[0], moving = rows[1], pin = fixed.pin;
  const obstructed = boxAt(moving, fixed.box.x + fixed.w / 2, fixed.box.y + fixed.h / 2, 800, 440);
  const elevated = boxAt(moving, moving.box.x + moving.w / 2, moving.box.y + moving.h / 2 - 58, 800, 440);
  pinNewRows([moving], rows, 800, 440, camera, pivot, new Map([[moving, [obstructed, elevated]]]));
  assert.equal(moving.box, elevated);
  assert.equal(fixed.pin, pin);
  assert.ok(totalOverlap(rows.map(row => row.pin)) < independent * .25);
});

test('a reprojected stem ends on the clamped tile perimeter, including a nearly coincident anchor', () => {
  const width = 430, height = 300, w = 98, h = 24, epsilon = 1e-7;
  for (const [cx, cy, ax, ay] of [
    [150, 120, 20, 115], [150, 120, 370, 265], [150, 120, 150, 40],
    [-55, 345, 180, 280], [600, -15, 280, 68],
    [150, 120, 150, 120], [150, 120, 150 + 1e-9, 120],
  ]) {
    const box = boxAt({ ax, ay, w, h }, cx, cy, width, height);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + w <= width && box.y + h <= height);
    assert.ok(box.endX >= box.x - epsilon && box.endX <= box.x + w + epsilon);
    assert.ok(box.endY >= box.y - epsilon && box.endY <= box.y + h + epsilon);
    const edgeDistance = Math.min(Math.abs(box.endX - box.x), Math.abs(box.endX - box.x - w),
      Math.abs(box.endY - box.y), Math.abs(box.endY - box.y - h));
    assert.ok(edgeDistance < epsilon, 'stem touches a visible chip edge');
    const centerX = box.x + w / 2, centerY = box.y + h / 2;
    const endX = box.endX - centerX, endY = box.endY - centerY;
    if (Math.hypot(ax - centerX, ay - centerY) > 1) {
      assert.ok(endX * (ax - centerX) + endY * (ay - centerY) > 0, 'stem uses the edge facing the anchor');
      assert.ok(Math.abs(endX * (ay - centerY) - endY * (ax - centerX)) < epsilon, 'stem follows the center-to-anchor ray');
    }
  }
});
