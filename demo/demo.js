import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import {
  MaterialInfo,
  materialIdFromBands,
  formatMaterialBands,
  paramsOcclusion,
} from '../js/steam-audio.js';

const FRAME = 128; // AudioWorklet render quantum
const REFLECTION_DURATION = 2.0; // s — marble rooms ring longer than 1 s

/**
 * "Game feel" tuning for this large map. The library defaults are physically neutral;
 * these floors and boosts keep far / occluded sources audible.
 */
const TUNING = {
  minDistance: 10, // gentler inverse-distance (room-scale reference)
  occlusionRadius: 0.4,
  distanceFloor: 0.18, // far wings stay audible
  airFloorLow: 0.55,
  airFloorMid: 0.4,
  airFloorHigh: 0.28,
  transmissionFloor: 1e-4, // don't floor transmission: sealed walls must be able to kill sound
  freqIndependentTransmission: true, // muffled, not silent, when occluded
  reflectionsFollowDistance: true,
  reflectionsDistanceFloor: 0.22,
  occludedWetBoost: 1.35, // bounced energy replaces the missing direct path
  reverbTimeFloor: 0.35,
};
const H = 6.2; // tall vaults
const T = 0.5; // massive wall thickness
const DOOR_W = 2.6;
const DOOR_H = 3.4;
const EYE_Y = 1.7;

const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const startBtn = document.getElementById('start');
const canvas = document.getElementById('view');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x12141a);
scene.fog = new THREE.Fog(0x12141a, 38, 110);

const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.08, 160);
camera.position.set(0, EYE_Y, 6);

const hemi = new THREE.HemisphereLight(0xc9d6e2, 0x3a3228, 0.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 1.05);
sun.position.set(18, 28, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -55;
sun.shadow.camera.right = 55;
sun.shadow.camera.top = 55;
sun.shadow.camera.bottom = -55;
sun.shadow.camera.far = 120;
scene.add(sun);

function boxMesh(min, max, color, opacity = 1) {
  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    metalness: 0.05,
    transparent: opacity < 1,
    opacity,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(center);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Massive cross complex (~72×66 m, 6.2 m vaults).
 * empty: true → no columns / inner props; floor+ceiling use reflective mats.
 */
const rooms = [
  {
    name: 'Grand hall',
    min: [-12, -12],
    max: [12, 12],
    floor: 0x5a5248,
    floorMat: 'carpet',
    ceilMat: 'plaster',
    empty: false,
  },
  {
    name: 'West vault',
    min: [-36, -12],
    max: [-12, 12],
    floor: 0x3d4a52,
    floorMat: 'carpet',
    ceilMat: 'plaster',
    empty: false,
  },
  {
    name: 'East wing',
    min: [12, -12],
    max: [36, 12],
    floor: 0x9aa0a8,
    floorMat: 'marble',
    ceilMat: 'glass',
    empty: true,
  },
  {
    name: 'North nave',
    min: [-12, 12],
    max: [12, 36],
    floor: 0x8e949c,
    floorMat: 'marble',
    ceilMat: 'marble',
    empty: true,
  },
  {
    name: 'South court',
    min: [-12, -32],
    max: [12, -12],
    floor: 0x7a8894,
    floorMat: 'glass',
    ceilMat: 'marble',
    empty: true,
  },
];

/** Door walls between rooms (wide arched openings). */
const interiorWalls = [
  { a: [-12, -12], b: [-12, 12], axis: 'z', doorAt: 0.5 }, // hall ↔ west
  { a: [12, -12], b: [12, 12], axis: 'z', doorAt: 0.5 }, // hall ↔ east
  { a: [-12, 12], b: [12, 12], axis: 'x', doorAt: 0.5 }, // hall ↔ north
  { a: [-12, -12], b: [12, -12], axis: 'x', doorAt: 0.5 }, // hall ↔ south
];

/** Room AABB containing (x,z), or null if outside the complex. */
function roomAt(x, z) {
  return rooms.find(
    (r) => x >= r.min[0] && x <= r.max[0] && z >= r.min[1] && z <= r.max[1],
  ) ?? null;
}

const acousticBoxes = [];
/** Solid XZ AABBs the player cannot walk through (doors omitted; lintels ignored). */
const colliders = [];
const PLAYER_R = 0.38;

function resolveMaterial(materialOrId) {
  if (typeof materialOrId === 'string') {
    const info = MaterialInfo[materialOrId];
    if (!info) throw new Error(`Unknown material: ${materialOrId}`);
    return { id: materialOrId, bands: info.bands, info };
  }
  const id = materialIdFromBands(materialOrId) ?? 'custom';
  return {
    id,
    bands: materialOrId,
    info: MaterialInfo[id] ?? { name: 'Custom', bands: materialOrId, note: '' },
  };
}

function normalizeAABB(min, max) {
  return {
    min: [
      Math.min(min[0], max[0]),
      Math.min(min[1], max[1]),
      Math.min(min[2], max[2]),
    ],
    max: [
      Math.max(min[0], max[0]),
      Math.max(min[1], max[1]),
      Math.max(min[2], max[2]),
    ],
  };
}

/**
 * @param {number[]} min
 * @param {number[]} max
 * @param {number} color
 * @param {string|number[]} materialOrId
 * @param {boolean} inward
 * @param {number} [opacity]
 * @param {boolean} [collide]
 * @param {string} [kind]
 */
function addVisualAndAcoustic(
  min,
  max,
  color,
  materialOrId,
  inward,
  opacity = 1,
  collide = false,
  kind = 'surface',
) {
  const mat = resolveMaterial(materialOrId);
  const aabb = normalizeAABB(min, max);
  // Degenerate / paper-thin boxes break raytracing and Steam Audio meshes
  const eps = 1e-4;
  for (let i = 0; i < 3; i++) {
    if (aabb.max[i] - aabb.min[i] < eps) {
      aabb.max[i] = aabb.min[i] + eps;
    }
  }
  scene.add(boxMesh(
    new THREE.Vector3(...aabb.min),
    new THREE.Vector3(...aabb.max),
    color,
    opacity,
  ));
  acousticBoxes.push({
    min: aabb.min,
    max: aabb.max,
    material: mat.bands,
    materialId: mat.id,
    materialName: mat.info.name,
    inward,
    kind,
  });
  if (collide) {
    colliders.push({
      minX: aabb.min[0],
      maxX: aabb.max[0],
      minZ: aabb.min[2],
      maxZ: aabb.max[2],
    });
  }
}

/** @param {number} [extend] lengthen both ends (closes the notch at perimeter corners) */
function addWallSegment(x0, z0, x1, z1, color, materialOrId, extend = 0) {
  let min;
  let max;
  if (Math.abs(x1 - x0) < 1e-6) {
    min = [x0 - T / 2, 0, Math.min(z0, z1) - extend];
    max = [x0 + T / 2, H, Math.max(z0, z1) + extend];
  } else if (Math.abs(z1 - z0) < 1e-6) {
    min = [Math.min(x0, x1) - extend, 0, z0 - T / 2];
    max = [Math.max(x0, x1) + extend, H, z0 + T / 2];
  } else {
    // Diagonal segments not supported — axis-align by thickening both
    min = [Math.min(x0, x1) - T / 2, 0, Math.min(z0, z1) - T / 2];
    max = [Math.max(x0, x1) + T / 2, H, Math.max(z0, z1) + T / 2];
  }
  addVisualAndAcoustic(min, max, color, materialOrId, false, 0.95, true, 'wall');
}

/** Full-height or partial solid partition (blocks walking + audio). */
function addPartition(min, max, color, materialOrId, opacity = 0.92) {
  addVisualAndAcoustic(min, max, color, materialOrId, false, opacity, true, 'partition');
}

function addDoorWall(x0, z0, x1, z1, axis, color, materialOrId, doorAt = 0.5) {
  // Split wall into two segments leaving a doorway; lintel above (no collide).
  if (axis === 'z') {
    const x = x0;
    const zMin = Math.min(z0, z1);
    const zMax = Math.max(z0, z1);
    const mid = zMin + (zMax - zMin) * doorAt;
    const gap0 = mid - DOOR_W / 2;
    const gap1 = mid + DOOR_W / 2;
    if (gap0 > zMin + 0.05) addWallSegment(x, zMin, x, gap0, color, materialOrId);
    if (gap1 < zMax - 0.05) addWallSegment(x, gap1, x, zMax, color, materialOrId);
    addVisualAndAcoustic(
      [x - T / 2, DOOR_H, gap0],
      [x + T / 2, H, gap1],
      color,
      materialOrId,
      false,
      0.95,
      false,
      'lintel',
    );
  } else {
    const z = z0;
    const xMin = Math.min(x0, x1);
    const xMax = Math.max(x0, x1);
    const mid = xMin + (xMax - xMin) * doorAt;
    const gap0 = mid - DOOR_W / 2;
    const gap1 = mid + DOOR_W / 2;
    if (gap0 > xMin + 0.05) addWallSegment(xMin, z, gap0, z, color, materialOrId);
    if (gap1 < xMax - 0.05) addWallSegment(gap1, z, xMax, z, color, materialOrId);
    addVisualAndAcoustic(
      [gap0, DOOR_H, z - T / 2],
      [gap1, H, z + T / 2],
      color,
      materialOrId,
      false,
      0.95,
      false,
      'lintel',
    );
  }
}

/** Ray vs AABB (slab). Returns { t, normal } or null. */
function raycastBox(origin, dir, boxMin, boxMax) {
  let tmin = 0;
  let tmax = Infinity;
  let hitAxis = 0;
  let hitSign = 1;
  for (let i = 0; i < 3; i++) {
    const o = origin.getComponent(i);
    const d = dir.getComponent(i);
    const minB = boxMin[i];
    const maxB = boxMax[i];
    if (Math.abs(d) < 1e-8) {
      if (o < minB || o > maxB) return null;
      continue;
    }
    let t1 = (minB - o) / d;
    let t2 = (maxB - o) / d;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    } else {
      sign = -1;
    }
    if (t1 > tmin) {
      tmin = t1;
      hitAxis = i;
      hitSign = sign;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Ignore hits at/behind the eye (inside-volume or grazing)
  if (!(tmin > 1e-3) || !Number.isFinite(tmin)) return null;
  const normal = [0, 0, 0];
  normal[hitAxis] = hitSign;
  return { t: tmin, normal };
}

function aimPick(origin, dir) {
  let best = null;
  for (const box of acousticBoxes) {
    const hit = raycastBox(origin, dir, box.min, box.max);
    if (!hit) continue;
    if (!best || hit.t < best.t) {
      best = { ...hit, box };
    }
  }
  if (!best) return null;
  const point = origin.clone().addScaledVector(dir, best.t);
  // Flip normal to face the ray (outward from surface toward viewer)
  const n = new THREE.Vector3(...best.normal);
  if (n.dot(dir) > 0) n.negate();
  return {
    distance: best.t,
    point,
    normal: n,
    materialId: best.box.materialId,
    materialName: best.box.materialName,
    bands: best.box.material,
    kind: best.box.kind,
    inward: best.box.inward,
  };
}

function hitsCollider(x, z) {
  const r2 = PLAYER_R * PLAYER_R;
  for (const c of colliders) {
    const cx = Math.max(c.minX, Math.min(x, c.maxX));
    const cz = Math.max(c.minZ, Math.min(z, c.maxZ));
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

function moveListener(dx, dz) {
  const p = controls.object.position;
  const nx = p.x + dx;
  const nz = p.z + dz;
  // Axis-separated so you can slide along walls
  if (!hitsCollider(nx, p.z)) p.x = nx;
  if (!hitsCollider(p.x, nz)) p.z = nz;
  p.y = EYE_Y;
}

const CONCRETE_COLOR = 0x6e716c;
const WOOD_COLOR = 0x6b4f35;

function addColumn(x, z, half = 0.85, mat = 'concrete', color = CONCRETE_COLOR) {
  addPartition([x - half, 0, z - half], [x + half, H, z + half], color, mat);
}

function addButtress(min, max, mat = 'concrete', color = CONCRETE_COLOR) {
  addPartition(min, max, color, mat, 0.96);
}

// Floors + ceilings (empty rooms → reflective mats for long reverb)
const FLOOR_Y = 0.12;
const CEIL_T = 0.14;
for (const r of rooms) {
  addVisualAndAcoustic(
    [r.min[0], 0, r.min[1]],
    [r.max[0], FLOOR_Y, r.max[1]],
    r.floor,
    r.floorMat,
    true,
    1,
    false,
    'floor',
  );
  addVisualAndAcoustic(
    [r.min[0], H - CEIL_T, r.min[1]],
    [r.max[0], H, r.max[1]],
    r.empty ? 0x3a4250 : 0x2a2e38,
    r.ceilMat ?? 'plaster',
    true,
    1,
    false,
    'ceiling',
  );
}

// Room-facing outer walls: sealed plaster (interior look, tx≈0 so sound can't leave).
// Between-room walls stay wood with doors — never use exterior material inside rooms.
const SHELL_COLOR = 0x8a8378;
const perimeter = [
  // west vault (N / W / S) — interior shell, not "exterior" material
  [-36, -12, -36, 12],
  [-36, 12, -12, 12],
  [-36, -12, -12, -12],
  // east wing
  [36, -12, 36, 12],
  [12, 12, 36, 12],
  [12, -12, 36, -12],
  // north nave
  [-12, 36, 12, 36],
  [-12, 12, -12, 36],
  [12, 12, 12, 36],
  // south court
  [-12, -32, 12, -32],
  [-12, -32, -12, -12],
  [12, -32, 12, -12],
];
for (const [x0, z0, x1, z1] of perimeter) {
  addWallSegment(x0, z0, x1, z1, SHELL_COLOR, 'shell', T / 2);
}

// Walls BETWEEN rooms — sealed like the outer shell so solid segments don't bleed.
// Open doorways still have LOS; room isolation (below) mutes cross-room sources.
for (const w of interiorWalls) {
  addDoorWall(w.a[0], w.a[1], w.b[0], w.b[1], w.axis, SHELL_COLOR, 'shell', w.doorAt ?? 0.5);
}

// Hall / west structure
for (const [cx, cz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) {
  addColumn(cx, cz, 1.0);
}
addColumn(-30, -7, 0.9);
addColumn(-30, 7, 0.9);
addButtress([-11.2, 0, 8], [-10.2, 4.5, 11.2], 'concrete', CONCRETE_COLOR);
addButtress([10.2, 0, -11.2], [11.2, 4.5, -8], 'concrete', CONCRETE_COLOR);

/**
 * Inner test walls — hide behind for occlusion, walk around for reflections.
 * Gaps left so rooms stay traversable; sources sit on the far side of each baffle.
 * Use `occluder` (not marble): marble tx≈0 made the east wing sound dead from the door.
 */
const OCC_H = 3.6; // tall enough to fully hide behind
const OCC_COLOR = 0x7a756c;

// West vault: baffle between hall door (x=-12) and music
addPartition([-21.2, 0, -6], [-20.5, OCC_H, 6], WOOD_COLOR, 'occluder');
addPartition([-32, 0, 3.5], [-22, 2.8, 4.1], WOOD_COLOR, 'wood'); // side reflector

// East wing: split baffle with a walk-around gap (z±) so door→piano isn't a solid mute wall
addPartition([20.5, 0, -9], [21.2, OCC_H, -2.2], OCC_COLOR, 'occluder');
addPartition([20.5, 0, 2.2], [21.2, OCC_H, 9], OCC_COLOR, 'occluder');
addPartition([26, 0, -8], [33, 3.2, -7.3], 0xb0c0d0, 'glass');

// North nave (reflective): cross baffle south of source — side gap to walk around
addPartition([-9, 0, 19.5], [-2.2, OCC_H, 20.2], OCC_COLOR, 'occluder');
addPartition([2.2, 0, 19.5], [9, OCC_H, 20.2], OCC_COLOR, 'occluder');
addPartition([-8, 0, 26], [-7.3, OCC_H, 33], OCC_COLOR, 'occluder');

// South court (reflective): cross baffle north of source
addPartition([-9, 0, -20.2], [-2.2, OCC_H, -19.5], 0xb0c0d0, 'glass');
addPartition([2.2, 0, -20.2], [9, OCC_H, -19.5], 0xb0c0d0, 'glass');
addPartition([7.3, 0, -28], [8, OCC_H, -21], OCC_COLOR, 'occluder');

// Sources on the far side of baffles (never inside wall volumes).
// Each source is audible only while the listener is in the same room.
const sourceDefs = [
  {
    name: 'Music · west',
    pos: [-28, 1.5, 0], // west of baffle at x≈-21
    color: 0x3d9b8f,
    url: './music.mp3',
    gain: 1,
  },
  {
    name: 'Piano · east',
    pos: [30, 1.5, 0], // east of baffle at x≈21
    color: 0xd4a05a,
    url: './samples/piano.mp3',
    gain: 1,
  },
  {
    name: 'Metronome · north',
    pos: [0, 1.6, 30], // north of baffle at z≈20
    color: 0x7aa2d6,
    url: './samples/metronome.mp3',
    gain: 1,
  },
  {
    name: 'Organ · south',
    pos: [0, 1.5, -26], // south of baffle at z≈-20
    color: 0xc47a8a,
    url: './samples/organ.mp3',
    gain: 1,
  },
].map((s) => {
  const room = roomAt(s.pos[0], s.pos[2]);
  if (!room) console.warn(`source "${s.name}" is outside all rooms`, s.pos);
  return { ...s, room: room?.name ?? null };
});

const sourceMeshes = sourceDefs.map((s) => {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 24, 16),
    new THREE.MeshStandardMaterial({ color: s.color, emissive: s.color, emissiveIntensity: 0.55 }),
  );
  m.position.set(...s.pos);
  m.castShadow = true;
  scene.add(m);
  const light = new THREE.PointLight(s.color, 0.9, 16);
  light.position.copy(m.position);
  scene.add(light);
  return m;
});

// Room labels
for (const r of rooms) {
  const cx = (r.min[0] + r.max[0]) / 2;
  const cz = (r.min[1] + r.max[1]) / 2;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 512, 96);
  ctx.font = '42px IBM Plex Sans, sans-serif';
  ctx.fillStyle = '#c8c2b6';
  ctx.textAlign = 'center';
  ctx.fillText(r.empty ? `${r.name} · reflective` : r.name, 256, 58);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.position.set(cx, 4.4, cz);
  sprite.scale.set(8, 1.3, 1);
  scene.add(sprite);
}

const controls = new PointerLockControls(camera, document.body);
scene.add(controls.object);

// Physical key codes, so WASD works on AZERTY / Dvorak etc.
const KEY_CODES = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd' };
const keys = { w: false, a: false, s: false, d: false };
addEventListener('keydown', (e) => {
  const k = KEY_CODES[e.code];
  if (k) keys[k] = true;
});
addEventListener('keyup', (e) => {
  const k = KEY_CODES[e.code];
  if (k) keys[k] = false;
});
addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

startBtn.addEventListener('click', () => {
  // Create/resume the AudioContext inside the click (user activation), not in the
  // async pointer-lock event.
  startAudio().catch((e) => {
    console.error(e);
    statusEl.textContent = `Audio failed: ${e.message || e}`;
  });
  controls.lock();
});
controls.addEventListener('lock', () => {
  startBtn.hidden = true;
});
controls.addEventListener('unlock', () => {
  startBtn.hidden = false;
});

function normalizePeak(mono, target = 0.85) {
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const a = Math.abs(mono[i]);
    if (a > peak) peak = a;
  }
  if (!(peak > 1e-6)) return mono;
  const g = target / peak;
  for (let i = 0; i < mono.length; i++) mono[i] *= g;
  return mono;
}

/** Fetch + decode to mono at the context's rate (decodeAudioData resamples for us). */
async function decodeSampleMono(ctx, relativeUrl) {
  const res = await fetch(new URL(relativeUrl, import.meta.url));
  if (!res.ok) throw new Error(`Failed to fetch ${relativeUrl} (${res.status})`);
  const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
  const n = decoded.length;
  const mono = new Float32Array(n);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < n; i++) mono[i] += data[i];
  }
  const inv = 1 / decoded.numberOfChannels;
  for (let i = 0; i < n; i++) mono[i] *= inv;
  // Downloaded samples vary wildly in loudness (piano ≪ music)
  return normalizePeak(mono, 1);
}

const WASM_URL = new URL('../dist/steam_audio.wasm', import.meta.url);
/** Compiled once on the main thread, then shared with the worker and the worklet. */
let wasmModulePromise = null;
function compileWasm() {
  wasmModulePromise ??= (async () => {
    try {
      return await WebAssembly.compileStreaming(fetch(WASM_URL));
    } catch {
      // Wrong MIME type from the dev server, etc.
      const res = await fetch(WASM_URL);
      if (!res.ok) throw new Error(`Failed to fetch steam_audio.wasm (${res.status})`);
      return WebAssembly.compile(await res.arrayBuffer());
    }
  })();
  wasmModulePromise.catch(() => {
    wasmModulePromise = null;
  });
  return wasmModulePromise;
}

let audioCtx = null;
let simWorker = null;
let rendererNode = null;
/** Latest exportParams() packet from the worker (HUD only). */
let lastParams = null;
let startPromise = null;
let lastActiveKey = '';
const listenerPose = { pos: [0, EYE_Y, 6], ahead: [0, 0, -1], up: [0, 1, 0] };

function validateGeometry() {
  const counts = {};
  let bad = 0;
  for (const b of acousticBoxes) {
    counts[b.materialId] = (counts[b.materialId] ?? 0) + 1;
    for (let i = 0; i < 3; i++) {
      if (!(b.max[i] > b.min[i])) bad++;
    }
    if (!b.material || b.material.length !== 7) bad++;
  }
  if (bad) console.warn(`geometry: ${bad} invalid box field(s)`);
  if (hitsCollider(0, 6)) console.warn('geometry: spawn point blocked by collider');
  for (const s of sourceDefs) {
    if (hitsCollider(s.pos[0], s.pos[2])) {
      console.warn(`geometry: source "${s.name}" inside collider at`, s.pos);
    }
  }
  console.info('geometry materials', counts, `surfaces=${acousticBoxes.length} colliders=${colliders.length}`);
  return counts;
}

function boot() {
  statusEl.textContent = 'Loading Steam Audio WASM…';
  const matCounts = validateGeometry();
  compileWasm().then(
    () => {
      statusEl.textContent =
        `Steam Audio WASM ready · ${acousticBoxes.length} surfaces · shell×${matCounts.shell ?? 0}`;
      startBtn.hidden = false;
    },
    (e) => {
      console.error(e);
      statusEl.textContent = `Failed: ${e.message || e}`;
    },
  );
}

function waitForReady(target, label) {
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      if (ev.data?.type === 'ready') resolve(ev.data);
      else if (ev.data?.type === 'error') reject(new Error(`${label}: ${ev.data.message}`));
    };
    target.addEventListener('message', onMessage);
    if (target.start) target.start();
  });
}

/** Sources audible from the listener's room (doorways have clear LOS, so isolate per room). */
function sendActiveSources() {
  const room = roomAt(listenerPose.pos[0], listenerPose.pos[2])?.name ?? null;
  const active = sourceDefs.map((d) => room !== null && d.room === room);
  const key = active.join();
  if (key === lastActiveKey) return;
  lastActiveKey = key;
  simWorker?.postMessage({ type: 'active', active });
  rendererNode?.port.postMessage({ type: 'active', active });
}

/** Idempotent: concurrent clicks share one start. */
function startAudio() {
  if (startPromise) return startPromise;
  if (typeof AudioWorkletNode !== 'function') {
    return Promise.reject(new Error('AudioWorklet unavailable (needs a secure context: https or localhost)'));
  }
  // Synchronous part runs inside the click handler → allowed to start audio.
  audioCtx ??= new AudioContext({ latencyHint: 'interactive' });
  const resumed = audioCtx.resume();

  startPromise = (async () => {
    await resumed;
    const sampleRate = audioCtx.sampleRate; // DSP runs at the device rate; no pitch shift
    statusEl.textContent = 'Compiling / decoding…';
    const [wasmModule, ...samples] = await Promise.all([
      compileWasm(),
      ...sourceDefs.map((d) => decodeSampleMono(audioCtx, d.url)),
    ]);

    await audioCtx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    rendererNode = new AudioWorkletNode(audioCtx, 'steam-audio-renderer', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: {
        wasmModule,
        frameSize: FRAME,
        numSources: sourceDefs.length,
        sourceGains: sourceDefs.map((d) => d.gain ?? 1),
        reflectionDuration: REFLECTION_DURATION,
        tuning: TUNING,
      },
    });
    const rendererReady = waitForReady(rendererNode.port, 'renderer');

    simWorker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
    const simReady = waitForReady(simWorker, 'simulation');
    simWorker.addEventListener('message', (ev) => {
      if (ev.data.type === 'params') lastParams = ev.data.packet;
      else if (ev.data.type === 'error') statusEl.textContent = `Simulation error: ${ev.data.message}`;
    });
    simWorker.addEventListener('error', (ev) => {
      statusEl.textContent = `Simulation worker failed: ${ev.message}`;
    });

    // Worker → worklet parameter channel (bypasses the main thread entirely).
    const { port1, port2 } = new MessageChannel();
    rendererNode.port.postMessage({ type: 'paramsPort', port: port2 }, [port2]);
    simWorker.postMessage({
      type: 'init',
      wasmModule,
      port: port1,
      sampleRate,
      frameSize: FRAME,
      reflectionDuration: REFLECTION_DURATION,
      tuning: TUNING,
      boxes: acousticBoxes.map((b) => ({ min: b.min, max: b.max, material: b.material, inward: b.inward })),
      sources: sourceDefs.map((d) => d.pos),
    }, [port1]);

    samples.forEach((data, index) => {
      rendererNode.port.postMessage({ type: 'sample', index, data }, [data.buffer]);
    });
    lastActiveKey = '';
    sendActiveSources();

    const [{ version }] = await Promise.all([rendererReady, simReady]);
    rendererNode.connect(audioCtx.destination);
    // Debug handle (console / automated browser checks).
    globalThis.steamAudioDemo = { audioCtx, rendererNode, simWorker, camera };
    statusEl.textContent = `Playing · Steam Audio ${version} · ${sampleRate} Hz · AudioWorklet + Worker`;
  })();
  startPromise.catch(() => {
    // Allow another click to retry from scratch.
    simWorker?.terminate();
    simWorker = null;
    rendererNode?.disconnect();
    rendererNode = null;
    startPromise = null;
  });
  return startPromise;
}

const clock = new THREE.Clock();
const aheadTmp = new THREE.Vector3();
const aimOrigin = new THREE.Vector3();
let hudTimer = 0;

function fmtVec(v, digits = 2) {
  return `(${v.x.toFixed(digits)}, ${v.y.toFixed(digits)}, ${v.z.toFixed(digits)})`;
}

function updateHud(pos) {
  const room = roomAt(pos.x, pos.z);
  const roomName = room?.name ?? '—';

  aimOrigin.copy(pos);
  const aim = aimPick(aimOrigin, aheadTmp);
  const aimDir = `aim ${fmtVec(aheadTmp)}`;
  let aimBlock = `${aimDir}\nlook: (nothing in range)`;
  if (aim) {
    const info = MaterialInfo[aim.materialId];
    const note = info?.note ? `\n  ${info.note}` : '';
    aimBlock =
      `${aimDir}\n` +
      `look: ${aim.materialName} · ${aim.kind}` +
      ` · ${aim.distance.toFixed(2)} m` +
      `\n  hit ${fmtVec(aim.point)}  n ${fmtVec(aim.normal)}` +
      `\n  ${formatMaterialBands(aim.bands)}` +
      note;
  }

  let occ = '';
  if (lastParams) {
    occ = '\n' + sourceDefs
      .map((def, i) => {
        const live = room && def.room === room.name;
        const tag = live ? `ON occ=${paramsOcclusion(lastParams, i).toFixed(2)}` : 'muted';
        return `${def.name}: ${tag}`;
      })
      .join('\n');
  }

  statsEl.textContent = `Room: ${roomName} · isolated\n${aimBlock}${occ}`;
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (controls.isLocked) {
    const speed = 6.5;
    const forward = Number(keys.w) - Number(keys.s);
    const right = Number(keys.d) - Number(keys.a);
    // Compute intended delta without applying, then collide
    const before = controls.object.position.clone();
    controls.moveForward(forward * speed * dt);
    controls.moveRight(right * speed * dt);
    const after = controls.object.position;
    const dx = after.x - before.x;
    const dz = after.z - before.z;
    after.copy(before);
    moveListener(dx, dz);
  }

  const pos = controls.object.position;
  camera.getWorldDirection(aheadTmp);
  listenerPose.pos = [pos.x, pos.y, pos.z];
  listenerPose.ahead = [aheadTmp.x, aheadTmp.y, aheadTmp.z];

  if (simWorker) {
    simWorker.postMessage({ type: 'listener', ...listenerPose });
    sendActiveSources();
  }

  hudTimer += dt;
  if (hudTimer >= 0.08) {
    hudTimer = 0;
    updateHud(pos);
  }

  for (const m of sourceMeshes) m.rotation.y += dt * 0.8;
  renderer.render(scene, camera);
}
tick();

boot();
