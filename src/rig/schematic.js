import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { anchors, surfaceNormals } from './anchors.js';

// Sections run bottom to top. Each gives the height, center X/Z and two radii.
// Rounded cross sections let the grip lean and the control deck slope toward the pilot.
function housing(sections) {
  const segments = 24, points = [], triangles = [];
  const rounded = value => Math.sign(value) * Math.abs(value) ** .64;
  for (const [y, x, z, rx, rz] of sections) {
    for (let i = 0; i < segments; i++) {
      const angle = i * 2 * Math.PI / segments;
      points.push(x + rx * rounded(Math.cos(angle)), y, z + rz * rounded(Math.sin(angle)));
    }
  }
  for (let level = 1; level < sections.length; level++) {
    const lower = (level - 1) * segments, upper = level * segments;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      triangles.push(lower + i, upper + i, lower + j, lower + j, upper + i, upper + j);
    }
  }
  const top = (sections.length - 1) * segments;
  for (let i = 1; i < segments - 1; i++) triangles.push(0, i, i + 1, top, top + i + 1, top + i);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();
  return geometry;
}

export function createSchematic(device, design) {
  const parts = [];
  const frame = 0x263747, grip = 0x344859, inset = 0x172530;
  const rocker = 0x9baab4, hat = 0x5b7282, red = 0xc34247;
  const append = (geometry, color) => {
    const flat = geometry.toNonIndexed();
    flat.deleteAttribute('uv');
    const rgb = new THREE.Color(color);
    const colors = new Float32Array(flat.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) rgb.toArray(colors, i);
    flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(flat);
    geometry.dispose();
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const disk = (r, h, sides = 24) => new THREE.CylinderGeometry(r, r * 1.03, h, sides);
  const localUp = new THREE.Vector3(0, 1, 0);
  function control(key, geometry, depth, color, recess = 0) {
    const normal = new THREE.Vector3(...(design?.surfaceNormals || surfaceNormals)[device][key]).normalize();
    const center = new THREE.Vector3(...(design?.anchors || anchors)[device][key]).addScaledVector(normal, -depth / 2 - recess);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(localUp, normal));
    geometry.translate(center.x, center.y, center.z);
    append(geometry, color);
  }

  if (design) {
    design.build(device, { append, housing, box, disk, control });
  } else if (device === 'sem') {
    append(housing([[-.505,0,0,.86,.65],[-.45,0,0,.93,.70],[-.24,0,0,.93,.69],
      [.06,0,-.13,.85,.44],[.08,0,-.16,.81,.39]]), frame);
    append(box(.082,.39,.09).translate(.582,.27,-.494), hat);
    for (const key of ['a1','a2','b1','b2','b3','sw1','sw2','c1','gear','flaps']) {
      const lever = key === 'gear' || key === 'flaps';
      const toggle = key.startsWith('sw');
      control(key, box(lever ? .24 : .14, lever ? .1 : .075, toggle ? .22 : .13), lever ? .1 : .075,
        lever || toggle ? rocker : hat);
    }
    control('start', disk(.085,.06), .06, red);
    control('mode', disk(.13,.11,12), .11, rocker);
  } else {
    const left = device === 'left';
    const x = anchors[device].motion[0];
    append(housing([[-.945,x,0,.42,.63],[-.91,x,0,.47,.70],[-.80,x,.01,.46,.68],
      [-.72,x,-.02,.42,.63],[-.54,x,-.035,.39,.51],[-.52,x,-.065,.37,.47]]), frame);
    append(housing([[-.949,x,0,.435,.65],[-.933,x,0,.47,.695],[-.903,x,0,.475,.698]]), inset);
    append(housing([[-.53,x,-.01,.22,.24],[-.49,x,-.01,.22,.24],[-.39,x,.008,.13,.14],
      [-.33,x,.008,.12,.115]]), inset);
    if (left) {
      append(housing([[-.335,x,0,.105,.11],[-.27,-.05,-.07,.12,.20],
        [-.18,-.21,-.14,.17,.19],[-.09,-.32,-.17,.16,.20]]), frame);
      append(housing([[-.14,-.34,-.18,.13,.14],[-.045,-.34,-.22,.18,.19],
        [.11,-.22,-.25,.19,.19],[.34,.02,-.32,.17,.18],[.54,.22,-.405,.19,.20],
        [.68,.33,-.475,.25,.24],[.84,.37,-.44,.15,.15],[.88,.36,-.44,.10,.115]]), grip);
    } else {
      append(housing([[-.345,0,-.025,.12,.14],[-.26,0,-.094,.17,.21],
        [-.19,0,-.19,.18,.24],[-.09,.015,-.24,.14,.19],[.32,0,-.34,.145,.185],
        [.49,.01,-.407,.205,.20],[.62,0,-.435,.255,.215],[.77,0,-.44,.25,.18],
        [.86,.005,-.46,.20,.14]]), grip);
    }
    for (const key of ['a3','a4','pov','c1']) {
      control(key, disk(.09,.105), .105, inset, .012);
      control(key, disk(.075,.036,12), .036, hat);
      control(key, box(.090,.005,.014), .005, grip, -.003);
      control(key, box(.014,.005,.090), .005, grip, -.003);
    }
    for (const key of ['a2','b1','d1']) control(key, disk(.057,.065), .065, key === 'a2' ? red : rocker);
    for (const key of ['trigger','speed']) control(key, box(.16,.09,.085), .09, key === 'trigger' ? red : hat);
    for (const key of ['f1','f2','f3']) control(key, box(.13,.045,.10), .045, hat);
    for (const key of ['en1','throttle','en2']) {
      const w = key === 'throttle' ? .13 : .075;
      control(key, box(w + .025,.075,.17), .075, inset, .005);
      control(key, box(w,.042,.135), .042, hat);
      for (const offset of [-.042,-.014,.014,.042]) {
        control(key, box(w * .83,.006,.009).translate(0,0,offset), .006, rocker, -.004);
      }
    }
  }
  // One draw call and one occlusion grid per device, just like the optional scan.
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .79 }));
  mesh.name = device + ' schematic';
  return mesh;
}
