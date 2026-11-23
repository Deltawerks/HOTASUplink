import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { defaultRig } from './profiles.mjs';
import { createLabels } from './labels.js';
import { createCompactLabels } from './compact-labels.js';
import { createLabelGeometry, createSurfaceMask } from './surface-mask.js';
const normalView = new THREE.Vector3(.18, .64, 1).normalize();

function attachStyles() {
  const href = new URL('./style.css', import.meta.url).href;
  if (document.querySelector('link[data-rig-style]')) return;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = href;
  css.dataset.rigStyle = '';
  document.head.appendChild(css);
}

function makeMarkerTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(32, 32, 22, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(3, 14, 31, .78)';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'white';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(32, 32, 6, 0, Math.PI * 2);
  ctx.fillStyle = 'white';
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeFloor() {
  // The grid fades before the horizon so the axis of rotation stays legible.
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `
      varying vec2 floorXZ;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.);
        floorXZ = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      varying vec2 floorXZ;
      float grid(float cells) {
        vec2 p = floorXZ * cells;
        vec2 g = abs(fract(p - .5) - .5) / max(fwidth(p), vec2(.0001));
        return 1. - min(min(g.x, g.y), 1.);
      }
      void main() {
        float fade = 1. - smoothstep(1.1, 5.7, length(floorXZ * vec2(.8, 1.2)));
        float alpha = (.12 * grid(5.) + .17 * grid(1.)) * fade;
        gl_FragColor = vec4(.29, .53, .77, alpha);
      }`,
  });
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), material);
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = -.014;
  return grid;
}

function disposeObject(object) {
  const resources = new Set(), images = new Set();
  object.traverse(child => {
    if (child.geometry) resources.add(child.geometry);
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material || resources.has(material)) continue;
      resources.add(material);
      for (const prop of Object.values(material)) {
        if (prop?.isTexture) {
          resources.add(prop);
          if (prop.source?.data?.close) images.add(prop.source.data);
        }
      }
    }
  });
  for (const resource of resources) resource.dispose();
  for (const image of images) image.close();
}

export function createRig(container, { profile = defaultRig, initialPlacement = 'off', initialPedals = false, scanDevices = Object.keys(profile.devices), onSelect = () => {}, onEdit = onSelect, onReady = () => {}, onError = () => {}, onContextLost = () => {} } = {}) {
  const { devices, controlsByDevice, anchors, surfaceNormals, markerFacing } = profile;
  attachStyles();
  const surface = document.createElement('div');
  surface.className = 'rig-surface';
  container.appendChild(surface);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  } catch (error) {
    queueMicrotask(() => onError(error));
    const noop = () => {};
    return { setVisible: noop, setPlacement: noop, setPedals: noop, setLabels: noop, setControls: noop, refreshTextLayout: noop, focus: noop, focusControl: noop, highlight: noop, home: noop, dispose: () => surface.remove() };
  }
  renderer.setClearColor(0, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.24;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-label', '3D controllers. Drag to orbit, scroll to zoom, or select a marked control.');
  surface.appendChild(canvas);
  const scene = new THREE.Scene();
  const defaultFov = 33;
  const camera = new THREE.PerspectiveCamera(defaultFov, 1, .025, 80);
  const orbit = new OrbitControls(camera, canvas);
  orbit.enableDamping = true;
  orbit.dampingFactor = .17;
  orbit.minDistance = .38;
  orbit.maxDistance = 15;
  orbit.maxPolarAngle = Math.PI * .71;
  orbit.rotateSpeed = .7;
  orbit.zoomSpeed = .9;
  orbit.zoomToCursor = true;
  const labels = createLabels(surface, choose, profile);
  const compact = createCompactLabels(surface, (device, key) => {
    if (inScope(device)) onEdit(device, key);
  }, devices);
  const grid = makeFloor();
  scene.add(grid);
  scene.add(new THREE.HemisphereLight(0xf0f7ff, 0x8096b1, 2.6));
  for (const [color, intensity, coords] of [
    [0xffffff, 3.0, [-3,5,4]], [0xd1e9ff, 1.55, [4,2,3]], [0xbed8ff, 2.6, [.5,3,-4]],
  ]) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(...coords);
    scene.add(light);
  }
  const markerTexture = makeMarkerTexture();
  const units = {};
  const markers = [];
  const groupMarkers = new Map();
  const meshes = [];
  const masks = new Map();
  const labelGeometry = createLabelGeometry();
  const ray = new THREE.Raycaster();
  const point = new THREE.Vector3();
  const towardEye = new THREE.Vector3();
  const pointer = new THREE.Vector2();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fades = new Map();
  let placement = null, scope = 'all', active = null, popup = null;
  let pedalsEnabled = Boolean(initialPedals && devices.pedals);
  let deskPositions = {};
  let referenceMode = false, compactMode = false;
  let frame = 0, disposed = false, animation = null, pressed = null;
  let cameraChanged = false;
  const blockedMarkers = new Map();
  let pageVisible = true, hasArea = false, contextLost = false, modelsReady = false;
  let autoFrame = 'all';
  let fittedDistance = 0, showHatDirections = false, closeHatDirections = false;
  let width = 0, height = 0;
  let textResizePending = false;
  let selectable = new Map();
  let sheetMarkers = new Map();

  for (const [device, spec] of Object.entries(devices)) {
    const unit = new THREE.Group();
    unit.name = device;
    unit.scale.setScalar(spec.scale);
    unit.position.y = -spec.bounds[0][1] * spec.scale;
    scene.add(unit);
    units[device] = unit;
    fades.set(device, { alpha: 1, from: 1, to: 1, start: 0, materials: new Set() });
    for (const [group, position] of Object.entries(anchors[device])) {
      const material = new THREE.SpriteMaterial({
        map: markerTexture, color: 0x8be2ff, opacity: .92, transparent: true,
        sizeAttenuation: false, depthWrite: false, toneMapped: false,
      });
      const marker = new THREE.Sprite(material);
      marker.position.set(...position);
      marker.userData = {
        device, group, facing: new THREE.Vector3(...markerFacing(device, group)).normalize(),
        surfaceNormal: new THREE.Vector3(...surfaceNormals[device][group]).normalize(),
      };
      unit.add(marker);
      markers.push(marker);
      groupMarkers.set(device + '/' + group, marker);
    }
  }

  function mounted(device) {
    return Object.hasOwn(deskPositions, device);
  }

  function inScope(device) {
    return mounted(device) && (scope === 'all' || scope === device);
  }

  function lookup(device, key) {
    return inScope(device) ? sheetMarkers.get(device + '/' + key) : undefined;
  }

  // Display meshes are opaque at rest. Restore normal depth rendering as soon
  // as the transition ends. Markers and picking follow the requested scope immediately.
  function setMaterialAlpha(material, alpha) {
    const blending = alpha < 1;
    if (material.transparent !== blending) {
      material.transparent = blending;
      material.depthWrite = !blending;
      material.needsUpdate = true;
    }
    material.opacity = alpha;
  }

  function updateFade(device, state, time) {
    const t = reducedMotion.matches ? 1 : THREE.MathUtils.clamp((time - state.start) / 255, 0, 1);
    const ease = t * t * (3 - 2 * t);
    const alpha = t < 1 ? THREE.MathUtils.lerp(state.from, state.to, ease) : state.to;
    units[device].visible = alpha > 0 || state.to === 1;
    if (alpha !== state.alpha) {
      for (const material of state.materials) setMaterialAlpha(material, alpha);
      state.alpha = alpha;
    }
    if (alpha !== state.to) invalidate();
  }

  function setScope(next, smooth) {
    if (camera.fov !== defaultFov) {
      camera.fov = defaultFov;
      camera.updateProjectionMatrix();
    }
    scope = mounted(next) ? next : 'all';
    const now = performance.now();
    for (const [device, state] of fades) {
      const to = inScope(device) ? 1 : 0;
      const animate = smooth && mounted(device) && !reducedMotion.matches;
      if (to === state.to && animate) continue;
      updateFade(device, state, now);
      state.from = animate ? state.alpha : to;
      state.to = to;
      state.start = now;
      updateFade(device, state, now);
    }
    invalidate();
  }

  function setControls(sheet) {
    closeChoices();
    selectable = new Map();
    sheetMarkers = new Map();
    for (const entry of sheet || []) {
      const groupId = entry.device + '/' + entry.group;
      const marker = groupMarkers.get(groupId);
      if (!marker) continue;
      if (!selectable.has(groupId)) selectable.set(groupId, []);
      selectable.get(groupId).push(entry);
      sheetMarkers.set(entry.device + '/' + entry.key, marker);
    }
    if (active && ![...sheetMarkers.values()].includes(active)) highlight(null, null);
    invalidate();
  }

  function choose(device, key) {
    if (!inScope(device)) return;
    closeChoices();
    highlight(device, key);
    onSelect(device, key);
  }

  function closeChoices() {
    popup?.remove();
    popup = null;
  }

  function showChoices(marker, x, y) {
    closeChoices();
    const { device, group } = marker.userData;
    if (compactMode && compact.openGroup(device, group, x, y)) return;
    const entries = selectable.get(device + '/' + group) || [];
    if (!entries.length) return;
    if (entries.length === 1) {
      choose(device, entries[0].key);
      return;
    }
    popup = document.createElement('div');
    popup.className = 'rig-input-choices';
    popup.setAttribute('role', 'group');
    popup.setAttribute('aria-label', 'Choose a control input');
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      const title = document.createElement('strong');
      title.textContent = entry.label;
      button.appendChild(title);
      if (entry.rows?.length) {
        for (const row of entry.rows) {
          const action = document.createElement('span');
          const context = entry.rows.some(other => other !== row && other.label === row.label) ? row.contextLabel : '';
          action.textContent = [row.label || row.action, context, row.gesture].filter(Boolean).join(' · ');
          button.appendChild(action);
        }
      } else {
        const empty = document.createElement('span');
        empty.className = 'rig-choice-empty';
        empty.textContent = 'Unassigned';
        button.appendChild(empty);
      }
      button.onclick = () => choose(device, entry.key);
      popup.appendChild(button);
    }
    surface.appendChild(popup);
    popup.style.left = Math.max(4, Math.min(width - popup.offsetWidth - 4, x + 8)) + 'px';
    popup.style.top = Math.max(4, Math.min(height - popup.offsetHeight - 4, y + 7)) + 'px';
  }

  function canDraw() {
    return !disposed && pageVisible && !document.hidden && hasArea && !contextLost;
  }

  function invalidate() {
    if (canDraw() && !frame) frame = requestAnimationFrame(draw);
  }

  function syncVisibility() {
    const enabled = canDraw();
    labels.setVisible(enabled);
    compact.setVisible(enabled);
    if (enabled) invalidate();
    else {
      cancelAnimationFrame(frame); frame = 0;
      pressed = null;
      blockedMarkers.clear();
    }
  }
  function lostContext(event) {
    event.preventDefault();
    contextLost = true;
    syncVisibility();
    onContextLost();
  }
  function restoredContext() {
    contextLost = false;
    syncVisibility();
    if (modelsReady) onReady();
  }

  function draw(time) {
    frame = 0;
    if (!canDraw()) return;
    let checkingReveal = false;
    const wasAnimating = Boolean(animation);
    if (animation) {
      const t = reducedMotion.matches ? 1 : THREE.MathUtils.clamp((time - animation.start) / 290, 0, 1);
      const ease = 1 - (1 - t) ** 3;
      camera.position.lerpVectors(animation.fromEye, animation.toEye, ease);
      orbit.target.lerpVectors(animation.fromTarget, animation.toTarget, ease);
      if (t >= 1) {
        animation = null;
        if (compactMode) compact.resetLayout();
      }
      else invalidate();
    }
    for (const [device, state] of fades) {
      if (state.alpha !== state.to) updateFade(device, state, time);
    }
    orbit.update();
    const moving = wasAnimating || cameraChanged;
    cameraChanged = false;
    camera.updateMatrixWorld();
    scene.updateMatrixWorld();
    const perPixel = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / height;
    const visibleMasks = [], silhouettes = [];
    if (compactMode) for (const mesh of meshes) {
      const device = mesh.userData.unit;
      if (!units[device].visible) continue;
      if (!masks.has(mesh)) masks.set(mesh, createSurfaceMask(mesh));
      const mask = masks.get(mesh);
      if (mask) {
        mask.prepare(camera);
        silhouettes.push(mask);
        if (inScope(device)) visibleMasks.push({ device, mask });
      }
    }
    for (const marker of markers) {
      marker.getWorldPosition(point);
      towardEye.copy(camera.position).sub(point);
      const distance = towardEye.length();
      towardEye.normalize();
      const facing = towardEye.dot(marker.userData.facing);
      const eligible = inScope(marker.userData.device) && selectable.has(marker.userData.device + '/' + marker.userData.group);
      marker.visible = eligible && facing > -.12;
      if (marker.visible && compactMode) {
        marker.visible = visibleMasks.length > 0 && !visibleMasks.some(({ device, mask }) =>
          mask.blocks(point, marker.userData.device === device ? .09 * devices[device].scale : .008, distance));
      }
      // Hide obstructed controls immediately, including for picking. During
      // orbit, require a brief clear sight line before showing them again.
      if (!compactMode || !eligible || reducedMotion.matches) blockedMarkers.delete(marker);
      else if (!marker.visible) blockedMarkers.set(marker, null);
      else if (blockedMarkers.has(marker)) {
        let since = blockedMarkers.get(marker);
        if (since === null && moving) { since = time; blockedMarkers.set(marker, since); }
        if (since !== null && time - since < 45) {
          marker.visible = false;
          checkingReveal = true;
        } else blockedMarkers.delete(marker);
      }
      const selected = marker === active;
      const pixels = selected ? 21 : scope === marker.userData.device ? 13 : 10;
      marker.scale.setScalar(pixels * perPixel / marker.parent.scale.x);
    }
    renderer.render(scene, camera);
    if (compactMode) {
      // Radius changes on dolly, and stays constant during orbit and pan.
      // Leave a gap between thresholds for small wheel and pinch reversals.
      if (!animation && fittedDistance > 0) {
        const magnification = fittedDistance / orbit.getDistance();
        const openAt = scope === 'all' ? 1.32 : .98;
        const closeAt = scope === 'all' ? 1.65 : 1.22;
        showHatDirections = magnification >= openAt * (showHatDirections ? .88 : 1);
        closeHatDirections = magnification >= closeAt * (closeHatDirections ? .88 : 1);
      }
      // Fit new pins at the destination of an automatic camera move and
      // once the full rig silhouette is available on startup.
      compact.update(width, height, camera, lookup, scope, labelGeometry, !modelsReady || Boolean(animation),
        () => labelGeometry.prepare(width, height, camera, silhouettes), orbit.target, showHatDirections, closeHatDirections);
    }
    else labels.update(width, height, camera, lookup);
    if (checkingReveal) invalidate();
  }

  function moveCamera(target, eye, smooth) {
    closeChoices();
    // OrbitControls leaves a sub-threshold residual after damping. Treat the
    // same refit as complete at the controller's position-change tolerance.
    const moved = camera.position.distanceToSquared(eye) > 1e-6 || orbit.target.distanceToSquared(target) > 1e-6;
    if (moved && smooth && !reducedMotion.matches) {
      animation = { start: performance.now(), fromTarget: orbit.target.clone(), fromEye: camera.position.clone(), toTarget: target, toEye: eye };
    } else {
      animation = null;
      orbit.target.copy(target);
      camera.position.copy(eye);
      orbit.update();
      if (moved && smooth && compactMode) compact.resetLayout();
    }
    invalidate();
  }

  function frameScope(next = 'all', smooth = true) {
    setScope(next, smooth);
    autoFrame = scope;
    const visible = Object.keys(units).filter(inScope);
    if (!visible.length || width === 0 || height === 0) return;
    const box = new THREE.Box3();
    const corners = [];
    for (const device of visible) {
      const [min, max] = devices[device].bounds;
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
        const v = units[device].localToWorld(new THREE.Vector3(x, y, z));
        box.expandByPoint(v);
        corners.push(v);
      }
    }
    const target = box.getCenter(new THREE.Vector3());
    const view = (scope === 'sem' || scope === 'pedals') ? new THREE.Vector3(.16,.97,1).normalize() : normalView;
    const across = new THREE.Vector3().crossVectors(camera.up, view).normalize();
    const up = new THREE.Vector3().crossVectors(view, across);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanH = tanV * width / height;
    // Size the model to the space between the annotation rails. Actual mesh
    // vertices matter here: the tall grip occupies very little of its bounding box.
    const focused = scope !== 'all';
    const fitWidth = referenceMode ? labels.fitWidth(width) : focused && !compactMode ? Math.max(.52, 1 - 518 / width) : 1 / 1.12;
    const fitHeight = focused ? .86 : 1 / 1.12;
    let distance = .55;
    function include(world) {
      const delta = world.sub(target);
      const projected = Math.max(Math.abs(delta.dot(across)) / (tanH * fitWidth), Math.abs(delta.dot(up)) / (tanV * fitHeight));
      distance = Math.max(distance, delta.dot(view) + projected);
    }
    const parts = focused ? meshes.filter(mesh => mesh.userData.unit === scope) : [];
    if (parts.length) {
      const world = new THREE.Vector3();
      for (const mesh of parts) {
        mesh.updateWorldMatrix(true, false);
        const positions = mesh.geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          include(world.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld));
        }
      }
    } else {
      for (const corner of corners) include(corner);
    }
    fittedDistance = distance;
    moveCamera(target, target.clone().addScaledVector(view, distance), smooth);
  }

  function setPlacement(next) {
    if (placement === next || !['off', 'left', 'right'].includes(next)) return;
    placement = next;
    positionDevices();
    if (devices.sem) syncAccessory('sem').catch(onError);
  }

  function setPedals(enabled) {
    if (!devices.pedals || pedalsEnabled === enabled) return;
    pedalsEnabled = enabled;
    positionDevices();
    syncAccessory('pedals').catch(onError);
  }

  function positionDevices() {
    deskPositions = profile.deskPositions(placement, pedalsEnabled);
    for (const [device, [x, z]] of Object.entries(deskPositions)) {
      units[device].position.x = x;
      units[device].position.z = z;
    }
    closeChoices();
    if (compactMode) compact.resetLayout();
    if (active && !mounted(active.userData.device)) highlight(null, null);
    frameScope(scope, false);
  }

  function highlight(device, key) {
    const next = lookup(device, key) || null;
    if (next === active) return;
    if (active) active.material.color.setHex(0x8be2ff);
    active = next;
    if (active) active.material.color.setHex(0xffd23f);
    invalidate();
  }

  function focusControl(device, key) {
    if (!mounted(device)) return;
    const marker = sheetMarkers.get(device + '/' + key);
    if (!marker) return;
    setScope(device, true);
    autoFrame = null;
    highlight(device, key);
    const target = marker.getWorldPosition(new THREE.Vector3());
    const eye = target.clone().addScaledVector(marker.userData.facing, device === 'sem' ? 1.55 : 1.85);
    moveCamera(target, eye, true);
  }

  function aim(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((event.clientY - rect.top) / rect.height) * 2);
    ray.setFromCamera(pointer, camera);
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function nearestMarker(event, pickSurface) {
    const position = aim(event);
    let best = null;
    let bestDist = pickSurface ? 15 : 11;
    for (const marker of markers) {
      if (!marker.visible || !inScope(marker.userData.device)) continue;
      marker.getWorldPosition(point).project(camera);
      const distance = Math.hypot((point.x + 1) * width / 2 - position.x, (1 - point.y) * height / 2 - position.y);
      if (distance < bestDist) { best = marker; bestDist = distance; }
    }
    if (!pickSurface) return best;
    const hit = ray.intersectObjects(meshes.filter(m => inScope(m.userData.unit)), false)[0];
    if (!hit) return best;
    if (best && best.userData.device === hit.object.userData.unit && best.getWorldPosition(point).distanceTo(hit.point) < .17) return best;
    best = null;
    bestDist = .115;
    for (const marker of markers) {
      if (!marker.visible || marker.userData.device !== hit.object.userData.unit) continue;
      const distance = marker.getWorldPosition(point).distanceTo(hit.point);
      if (distance < bestDist) { best = marker; bestDist = distance; }
    }
    return best;
  }

  function pointerMove(event) {
    if (!pressed) canvas.toggleAttribute('data-over-control', Boolean(nearestMarker(event, false)));
    else if (event.pointerId === pressed.id && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5) {
      pressed.dragged = true;
    }
  }
  function pointerDown(event) {
    if (event.button !== 0) return;
    closeChoices();
    if (pressed) { pressed.dragged = true; return; }
    pressed = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
  }
  function pointerUp(event) {
    if (pressed?.id !== event.pointerId || event.button !== 0) return;
    const start = pressed;
    pressed = null;
    if (start.dragged || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const marker = nearestMarker(event, true);
    const { x, y } = aim(event);
    if (marker) showChoices(marker, x, y);
  }
  function zoomFromLabel(event) {
    if (!event.target.closest('.rig-compact-labels') || event.target.closest('.rig-compact-popup')) return;
    // Preserve native wheel units and trackpad pinch on labels above the canvas.
    if (!canvas.dispatchEvent(new WheelEvent('wheel', event))) event.preventDefault();
  }
  surface.addEventListener('wheel', zoomFromLabel, { passive: false });
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', event => { if (pressed?.id === event.pointerId) pressed = null; });
  surface.addEventListener('keydown', event => { if (event.key === 'Escape') closeChoices(); });
  orbit.addEventListener('change', () => { cameraChanged = true; invalidate(); });
  orbit.addEventListener('start', () => {
    animation = null; autoFrame = null; closeChoices(); invalidate();
  });
  function fontsLoaded() {
    compact.invalidateMeasurements();
    invalidate();
  }
  document.fonts.addEventListener('loadingdone', fontsLoaded);
  reducedMotion.addEventListener('change', invalidate);
  document.addEventListener('visibilitychange', syncVisibility);
  canvas.addEventListener('webglcontextlost', lostContext);
  canvas.addEventListener('webglcontextrestored', restoredContext);
  function resizeSurface() {
    const w = surface.clientWidth, h = surface.clientHeight;
    const hadArea = hasArea;
    hasArea = w > 0 && h > 0;
    if (hasArea !== hadArea) syncVisibility();
    if (!hasArea) return;
    // A larger toolbar can resize the canvas too. Preserve the last camera
    // pose for this reflow, even if the user was on a different tab.
    const keepPose = textResizePending && width > 0 && height > 0;
    textResizePending = false;
    if (w === width && h === height) return;
    if (keepPose) {
      // Perspective focal length in pixels is height / (2 * tan(fov / 2)).
      // Crop or reveal the edges as text reflows without scaling the model.
      const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      camera.fov = 2 * THREE.MathUtils.radToDeg(Math.atan(tanHalfFov * h / height));
    } else {
      camera.fov = defaultFov;
    }
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (keepPose || autoFrame === null) invalidate();
    else frameScope(scope, false);
  }
  function refreshTextLayout() {
    textResizePending = true;
    resizeSurface();
    compact.invalidateMeasurements();
    invalidate();
  }
  const resize = new ResizeObserver(resizeSurface);
  resize.observe(surface);
  const loader = new GLTFLoader();
  const accessories = new Map();
  async function readScan(device) {
    if (!scanDevices.includes(device)) return null;
    try { return (await loader.loadAsync(devices[device].model)).scene; }
    catch (error) { console.warn('Could not load optional ' + device + ' scan.', error); return null; }
  }
  function installModel(device, scan) {
    const spec = devices[device];
    const model = scan || profile.createFallback(device);
    if (scan && spec.rotationY) model.rotation.y = spec.rotationY;
    model.traverse(child => {
      if (!child.isMesh) return;
      child.userData.unit = device;
      const state = fades.get(device);
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (state.materials.has(material)) continue;
        state.materials.add(material);
        if (material.map) material.map.anisotropy = Math.min(6, renderer.capabilities.getMaxAnisotropy());
        // Soften the baked-in scuffs while keeping the colored buttons and printed legends legible.
        if (scan) material.color.multiplyScalar(.72);
        if (scan && spec.darkenPlastic) {
          // Darken the left scan's gray plastic while retaining bright legends and colored controls.
          material.onBeforeCompile = shader => {
            shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
              #include <map_fragment>
              float peak = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
              diffuseColor.rgb *= mix(0.5, 1.0, smoothstep(0.06, 0.22, peak));
            `);
          };
        }
        material.roughness = Math.max(material.roughness, .84);
        material.normalScale?.multiplyScalar(.55);
        setMaterialAlpha(material, state.alpha);
      }
      meshes.push(child);
    });
    units[device].add(model);
    if (autoFrame === device && scope === device) frameScope(device);
    invalidate();
    return model;
  }
  async function loadHand(device) {
    const scan = await readScan(device);
    if (disposed) { if (scan) disposeObject(scan); return; }
    installModel(device, scan);
  }
  async function loadHands() {
    const mirror = devices.left?.mirrorOf;
    if (!mirror || !scanDevices.includes('left') || !scanDevices.includes(mirror)) {
      return Promise.all(Object.keys(devices).filter(device => device !== 'sem' && device !== 'pedals').map(loadHand));
    }
    const scan = await readScan(mirror);
    if (disposed) { if (scan) disposeObject(scan); return; }
    if (!scan) {
      installModel(mirror, null);
      return loadHand('left');
    }
    // The ALPHA left scan is a reflection of the right, including its UVs.
    // Share geometry and textures; hand fades need independent materials.
    const reflected = scan.clone();
    reflected.traverse(child => {
      if (child.isMesh) child.material = Array.isArray(child.material)
        ? child.material.map(material => material.clone()) : child.material.clone();
    });
    reflected.scale.x *= -1;
    reflected.position.x = devices.left.mirrorOffsetX;
    const left = new THREE.Group();
    left.add(reflected);
    installModel('left', left);
    installModel(mirror, scan);
  }
  function syncAccessory(device) {
    const entry = accessories.get(device);
    if (!mounted(device)) {
      if (entry?.model) {
        entry.model.removeFromParent();
        for (let i = meshes.length - 1; i >= 0; i--) {
          if (meshes[i].userData.unit !== device) continue;
          masks.delete(meshes[i]);
          meshes.splice(i, 1);
        }
        labelGeometry.clear();
        fades.get(device).materials.clear();
        disposeObject(entry.model);
        accessories.delete(device);
      }
      return Promise.resolve();
    }
    if (entry) return entry.ready;
    const pending = {};
    accessories.set(device, pending);
    pending.ready = readScan(device).then(scan => {
      if (disposed || !mounted(device)) {
        if (scan) disposeObject(scan);
        accessories.delete(device);
      } else pending.model = installModel(device, scan);
    });
    return pending.ready;
  }
  setControls(Object.values(controlsByDevice).flat().filter(control => !control.optionalPosition));
  placement = initialPlacement;
  positionDevices();
  const initialLoads = [loadHands()];
  for (const device of ['sem', 'pedals']) {
    if (devices[device] && mounted(device)) initialLoads.push(syncAccessory(device));
  }
  Promise.all(initialLoads).then(() => {
    modelsReady = true;
    invalidate();
    if (!disposed && !contextLost) onReady();
  }).catch(error => { if (!disposed) onError(error); });

  return {
    setPlacement, setPedals, setControls, highlight, focusControl, refreshTextLayout,
    setVisible(visible) { pageVisible = visible; syncVisibility(); },
    setLabels(items = []) {
      const source = items || [];
      const nextCompact = source.some(item => item.compact);
      const nextReference = !nextCompact && source.some(item => item.reference);
      const fitChanged = nextReference !== referenceMode || nextCompact !== compactMode;
      if (compactMode !== nextCompact) blockedMarkers.clear();
      compactMode = nextCompact; referenceMode = nextReference;
      labels.set(compactMode ? [] : source);
      compact.set(compactMode ? source : []);
      if (fitChanged && autoFrame === scope) frameScope(scope, false);
      invalidate();
    },
    focus: device => frameScope(device),
    home: () => frameScope('all'),
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      document.fonts.removeEventListener('loadingdone', fontsLoaded);
      document.removeEventListener('visibilitychange', syncVisibility);
      reducedMotion.removeEventListener('change', invalidate);
      canvas.removeEventListener('webglcontextlost', lostContext);
      canvas.removeEventListener('webglcontextrestored', restoredContext);
      surface.removeEventListener('wheel', zoomFromLabel);
      orbit.dispose();
      labels.dispose();
      compact.dispose();
      masks.clear();
      disposeObject(scene);
      renderer.dispose();
      surface.remove();
    },
  };
}
