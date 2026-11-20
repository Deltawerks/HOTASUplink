import { BackSide, DoubleSide, Matrix4, Ray, Vector3 } from 'three';

const viewPoint = new Vector3(), viewNormal = new Vector3();

// Perspective derivative at the physical button. An off-center button viewed
// straight down its own normal still has no preferred screen-space heading.
export function projectSurfaceHeading(worldPoint, worldNormal, camera, width, height) {
  viewPoint.copy(worldPoint).applyMatrix4(camera.matrixWorldInverse);
  viewNormal.copy(worldNormal).transformDirection(camera.matrixWorldInverse);
  const depth = -viewPoint.z;
  if (depth <= 0 || !width || !height) return { x: 0, y: 0, magnitude: 0 };
  const projection = camera.projectionMatrix.elements;
  const x = (viewNormal.x + viewPoint.x * viewNormal.z / depth) * (projection[0] * width) / (projection[5] * height);
  const y = -(viewNormal.y + viewPoint.y * viewNormal.z / depth);
  const length = Math.hypot(x, y);
  return length < 1e-6 ? { x: 0, y: 0, magnitude: 0 } : { x: x / length, y: y / length, magnitude: Math.min(1, length) };
}

// Merge neighboring occupied cells into small boxes for screen projection.
// Tighten each box to its occupied fine cells to retain gaps around the grips.
function surfaceBoxes(cells, nx, ny) {
  const block = 2, blocksX = Math.ceil(nx / block), blocksY = Math.ceil(ny / block);
  const blocks = new Map();
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue;
    const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    const key = Math.floor(x / block) + blocksX * (Math.floor(y / block) + blocksY * Math.floor(z / block));
    const bounds = blocks.get(key);
    if (!bounds) { blocks.set(key, [x,y,z,x+1,y+1,z+1]); continue; }
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.min(bounds[2], z);
    bounds[3] = Math.max(bounds[3], x+1); bounds[4] = Math.max(bounds[4], y+1); bounds[5] = Math.max(bounds[5], z+1);
  }
  const boxes = new Float32Array(blocks.size * 6);
  let offset = 0;
  for (const b of blocks.values()) {
    for (let axis = 0; axis < 3; axis++) {
      boxes[offset + axis] = (b[axis] + b[axis + 3]) / 2;
      boxes[offset + axis + 3] = (b[axis + 3] - b[axis]) / 2;
    }
    offset += 6;
  }
  return boxes;
}

function projectBoxes(boxes, projection, columns, rows, difference) {
  const m = projection.elements, stride = columns + 1;
  for (let i = 0; i < boxes.length; i += 6) {
    const x = boxes[i], y = boxes[i+1], z = boxes[i+2], a = boxes[i+3], b = boxes[i+4], c = boxes[i+5];
    const w = m[3]*x + m[7]*y + m[11]*z + m[15];
    const dw = Math.abs(m[3])*a + Math.abs(m[7])*b + Math.abs(m[11])*c;
    if (w + dw <= 0) continue;
    const centerW = Math.max(w, .00001), nearW = Math.max(w - dw, .00001);
    const px = (m[0]*x + m[4]*y + m[8]*z + m[12]) / centerW;
    const py = (m[1]*x + m[5]*y + m[9]*z + m[13]) / centerW;
    const dx = (Math.abs(m[0])*a + Math.abs(m[4])*b + Math.abs(m[8])*c + Math.abs(px)*dw) / nearW;
    const dy = (Math.abs(m[1])*a + Math.abs(m[5])*b + Math.abs(m[9])*c + Math.abs(py)*dw) / nearW;
    // The projected boxes already surround their sampled surface. Require
    // a little cell coverage at each edge to avoid a second full-cell halo.
    const x0 = Math.max(0, Math.floor((1 + px - dx) * columns / 2 + .3));
    const x1 = Math.min(columns, Math.ceil((1 + px + dx) * columns / 2 - .3));
    const y0 = Math.max(0, Math.floor((1 - py - dy) * rows / 2 + .3));
    const y1 = Math.min(rows, Math.ceil((1 - py + dy) * rows / 2 - .3));
    if (x0 >= x1 || y0 >= y1) continue;
    difference[y0 * stride + x0]++; difference[y0 * stride + x1]--;
    difference[y1 * stride + x0]--; difference[y1 * stride + x1]++;
  }
}

// Sample each scanned surface into a small grid. It lets orbiting labels check
// their sight line against all three models without raycasting 214k triangles per frame.
export function createSurfaceMask(mesh) {
  const geometry = mesh.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const extent = bounds.getSize(new Vector3());
  const cell = Math.max(extent.x, extent.y, extent.z) / 52;
  if (!(cell > 0)) return null;
  const nx = Math.ceil(extent.x / cell) + 2, ny = Math.ceil(extent.y / cell) + 2, nz = Math.ceil(extent.z / cell) + 2;
  const cells = new Array(nx * ny * nz);
  const gridFromLocal = new Matrix4().makeScale(1 / cell, 1 / cell, 1 / cell);
  gridFromLocal.setPosition(1 - bounds.min.x / cell, 1 - bounds.min.y / cell, 1 - bounds.min.z / cell);
  const positions = geometry.attributes.position, index = geometry.index;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  const count = index?.count ?? positions.count;
  function vertex(target, i) {
    target.fromBufferAttribute(positions, index ? index.getX(i) : i).applyMatrix4(gridFromLocal);
  }
  for (let i = 0; i < count; i += 3) {
    vertex(a, i); vertex(b, i + 1); vertex(c, i + 2);
    b.sub(a); c.sub(a);
    const steps = Math.max(1, Math.ceil(Math.max(b.length(), c.length(), b.distanceTo(c))));
    for (let u = 0; u <= steps; u++) for (let v = 0; v <= steps - u; v++) {
      const x = Math.floor(a.x + (b.x * u + c.x * v) / steps);
      const y = Math.floor(a.y + (b.y * u + c.y * v) / steps);
      const z = Math.floor(a.z + (b.z * u + c.z * v) / steps);
      const id = x + nx * (y + ny * z);
      const bucket = cells[id] || (cells[id] = []);
      if (bucket[bucket.length - 1] !== i) bucket.push(i);
    }
  }
  const gridMax = new Vector3(nx, ny, nz);
  const fromWorld = new Matrix4(), eye = new Vector3(), end = new Vector3(), delta = new Vector3();
  const boxes = surfaceBoxes(cells, nx, ny), localFromGrid = gridFromLocal.clone().invert();
  const clipFromGrid = new Matrix4(), nextProjection = new Matrix4();
  let pose = 0;
  const ray = new Ray(), hit = new Vector3();
  const sidedness = mesh.material.side;
  return {
    prepare(camera) {
      fromWorld.copy(mesh.matrixWorld).invert().premultiply(gridFromLocal);
      eye.copy(camera.position).applyMatrix4(fromWorld);
      nextProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld).multiply(localFromGrid);
      if (!nextProjection.equals(clipFromGrid)) { clipFromGrid.copy(nextProjection); pose++; }
    },
    get pose() { return pose; },
    project(columns, rows, difference) { projectBoxes(boxes, clipFromGrid, columns, rows, difference); },
    blocks(point, clearance, distance) {
      end.copy(point).applyMatrix4(fromWorld);
      delta.subVectors(eye, end);
      // The measured anchor can lie slightly inside its own button or lever.
      let lo = Math.min(1, clearance / Math.max(distance, .001)), hi = 1;
      for (const key of ['x', 'y', 'z']) {
        const start = end[key], step = delta[key], limit = gridMax[key];
        if (Math.abs(step) < 1e-8) { if (start < 0 || start >= limit) return false; continue; }
        let first = -start / step, last = (limit - start) / step;
        if (first > last) [first, last] = [last, first];
        lo = Math.max(lo, first); hi = Math.min(hi, last);
        if (lo >= hi) return false;
      }
      const stride = .55 / Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z));
      ray.origin.copy(eye);
      ray.direction.copy(delta).negate().normalize();
      const cutoff = delta.length() * (1 - clearance / Math.max(distance, .001));
      for (let t = lo + .000001; t < hi; t += stride) {
        const x = Math.floor(end.x + delta.x * t), y = Math.floor(end.y + delta.y * t), z = Math.floor(end.z + delta.z * t);
        const bucket = cells[x + nx * (y + ny * z)];
        if (!bucket) continue;
        // A point on a rocker can share a cell with its raised lip. Confirm
        // the actual line of sight against that cell's scanned triangles.
        for (const i of bucket) {
          vertex(a, i); vertex(b, i + 1); vertex(c, i + 2);
          if (ray.intersectTriangle(sidedness === BackSide ? c : a, b, sidedness === BackSide ? a : c,
            sidedness !== DoubleSide, hit) && eye.distanceToSquared(hit) < cutoff * cutoff) return true;
        }
      }
      return false;
    },
  };
}

// Sum the projected model silhouettes once per camera/placement change. An
// integral image makes coverage queries constant-time throughout label layout.
export function createLabelGeometry() {
  const position = new Vector3(), normal = new Vector3();
  let width = 0, height = 0, camera, columns = 0, rows = 0, stride = 0;
  let difference, vertical, integral;
  let previous = [];

  function prepare(w, h, nextCamera, masks) {
    camera = nextCamera;
    if (width === w && height === h && previous.length === masks.length
      && masks.every((mask, i) => previous[i].mask === mask && previous[i].pose === mask.pose)) return;
    width = w; height = h;
    previous = masks.map(mask => ({ mask, pose: mask.pose }));
    const cols = Math.max(1, Math.min(192, Math.ceil(w / 6))), lines = Math.max(1, Math.min(128, Math.ceil(h / 6)));
    if (cols !== columns || lines !== rows) {
      columns = cols; rows = lines; stride = columns + 1;
      difference = new Int32Array(stride * (rows + 1));
      integral = new Uint32Array(difference.length);
      vertical = new Int32Array(columns);
    } else { difference.fill(0); vertical.fill(0); }
    for (const mask of masks) mask.project(columns, rows, difference);
    for (let y = 0; y < rows; y++) {
      let count = 0, occupied = 0;
      for (let x = 0; x < columns; x++) {
        vertical[x] += difference[y * stride + x];
        count += vertical[x];
        if (count > 0) occupied++;
        integral[(y+1) * stride + x+1] = occupied + integral[y * stride + x+1];
      }
    }
  }

  function area(x, y) {
    const x0 = Math.min(columns - 1, Math.floor(x)), y0 = Math.min(rows - 1, Math.floor(y));
    const fx = x - x0, fy = y - y0, i = y0 * stride + x0;
    const top = integral[i] + (integral[i + 1] - integral[i]) * fx;
    const bottom = integral[i + stride] + (integral[i + stride + 1] - integral[i + stride]) * fx;
    return top + (bottom - top) * fy;
  }

  function coverage(x, y, w, h) {
    if (!previous.length || w <= 0 || h <= 0) return 0;
    const sx = columns / width, sy = rows / height;
    const x0 = Math.max(0, Math.min(columns, x * sx)), x1 = Math.max(0, Math.min(columns, (x+w) * sx));
    const y0 = Math.max(0, Math.min(rows, y * sy)), y1 = Math.max(0, Math.min(rows, (y+h) * sy));
    if (x1 <= x0 || y1 <= y0) return 0;
    return Math.max(0, Math.min(1, (area(x1,y1) - area(x0,y1) - area(x1,y0) + area(x0,y0)) / (w*sx*h*sy)));
  }
  function direction(marker) {
    marker.getWorldPosition(position);
    normal.copy(marker.userData.surfaceNormal || marker.userData.facing).transformDirection(marker.parent.matrixWorld);
    return projectSurfaceHeading(position, normal, camera, width, height);
  }
  return { prepare, direction, coverage };
}
