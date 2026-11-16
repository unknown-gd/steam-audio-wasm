// Node smoke test of the GMod build (C ABI, no Emscripten glue):
//   node test/smoke-gmod.mjs [dist/gmod/steam_audio_gmod.wasm]
// Imports are the same stubs a host without WASI has to provide.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FRAME = 256;
const SR = 48000;
const path = process.argv[2] ?? new URL('../dist/gmod/steam_audio_gmod.wasm', import.meta.url);

const imports = {
  env: { emscripten_notify_memory_growth() {} },
  wasi_snapshot_preview1: {
    clock_time_get: () => 0,
    fd_write: () => 8, // EBADF
    fd_read: () => 8,
    fd_close: () => 8,
    fd_seek: () => 8,
  },
};

const { instance } = await WebAssembly.instantiate(await readFile(path), imports);
const sa = instance.exports;
sa._initialize();

const world = sa.sa_create(SR, FRAME, 2, 1, 1);
assert.ok(world > 0, 'sa_create');
assert.equal(sa.sa_frame_size(world), FRAME);
assert.equal(sa.sa_sample_rate(world), SR);

// room shell + full partition (Materials.plaster / Materials.shell-like values)
assert.equal(sa.sa_add_box(world, -6, 0, -4.5, 6, 3.2, 4.5, 0.1, 0.1, 0.1, 0.05, 0.1, 0.1, 0.1, 1), 0);
assert.equal(sa.sa_add_box(world, -0.1, 0, -4.5, 0.1, 3.2, 4.5, 0.1, 0.1, 0.1, 0.05, 0, 0, 0, 0), 0);
assert.equal(sa.sa_commit_scene(world), 0);

const clear = sa.sa_add_source(world, -3, 1.4, 2);
const hidden = sa.sa_add_source(world, 3, 1.4, 0);
assert.equal(sa.sa_num_sources(world), 2);
assert.equal(sa.sa_set_listener(world, -3, 1.6, -2, 0, 0, 1, 0, 1, 0), 0);
assert.equal(sa.sa_simulate(world, 1), 0);

assert.ok(sa.sa_get_occlusion(world, clear) > 0.9, 'clear source is not occluded');
assert.ok(sa.sa_get_occlusion(world, hidden) < 0.1, 'hidden source is occluded');

const input = new Float32Array(sa.memory.buffer, sa.sa_input(world), FRAME);
for (let i = 0; i < FRAME; i++) input[i] = Math.sin(i / 5);
assert.equal(sa.sa_process(world, clear), 0);

const output = new Float32Array(sa.memory.buffer, sa.sa_output(world), 2 * FRAME);
let energy = 0;
for (const v of output) {
  assert.ok(Number.isFinite(v), 'finite output');
  energy += v * v;
}
assert.ok(energy > 0, 'non-silent output');
const rms = Math.sqrt(energy / output.length); // views detach once memory grows

// Tuning round trip (flat float array, see steam_audio_capi.cpp)
const tuningSize = sa.sa_tuning_size();
assert.equal(tuningSize, 21);
const tuningPtr = sa.malloc(tuningSize * 4);
assert.equal(sa.sa_get_tuning(world, tuningPtr), tuningSize);
const tuning = new Float32Array(sa.memory.buffer, tuningPtr, tuningSize);
assert.equal(tuning[8], 1); // reflectionsGain
assert.equal(tuning[19], 0); // reverbTimeMax
tuning[8] = 0.25;
tuning[17] = 1; // reflectionsFollowOcclusion
tuning[19] = 1.5;
assert.equal(sa.sa_set_tuning(world, tuningPtr, tuningSize), 0);
new Float32Array(sa.memory.buffer, tuningPtr, tuningSize).fill(-1);
sa.sa_get_tuning(world, tuningPtr);
const back = new Float32Array(sa.memory.buffer, tuningPtr, tuningSize);
assert.deepEqual([back[8], back[17], back[19]], [0.25, 1, 1.5]);
assert.equal(sa.sa_process(world, hidden), 0); // occluded source renders with the new tuning
sa.free(tuningPtr);

// normalizeDistance: minDistance becomes a reference distance (full level inside it)
const distWorld = sa.sa_create(SR, FRAME, 1, 1, 0);
const far = sa.sa_add_source(distWorld, 0, 1.6, -4); // 4 m in front
sa.sa_set_listener(distWorld, 0, 1.6, 0, 0, 0, -1, 0, 1, 0);
const level = (normalize, minDistance) => {
  const p = sa.malloc(sa.sa_tuning_size() * 4);
  sa.sa_get_tuning(distWorld, p);
  const t = new Float32Array(sa.memory.buffer, p, sa.sa_tuning_size());
  t[0] = minDistance; t[14] = 0; t[15] = 0; t[20] = normalize; // no smoothing
  sa.sa_set_tuning(distWorld, p, t.length);
  sa.free(p);
  sa.sa_simulate(distWorld, 0);
  sa.sa_reset_source(distWorld, far);
  let e = 0;
  for (let k = 0; k < 4; k++) {
    const inp = new Float32Array(sa.memory.buffer, sa.sa_input(distWorld), FRAME);
    for (let i = 0; i < FRAME; i++) inp[i] = Math.sin(i / 5);
    sa.sa_process(distWorld, far);
    if (k < 2) continue;
    for (const v of new Float32Array(sa.memory.buffer, sa.sa_output(distWorld), 2 * FRAME)) e += v * v;
  }
  return Math.sqrt(e);
};
const plain = level(0, 1), normalized = level(1, 8), capped = level(0, 8);
assert.ok(normalized > plain * 2, `normalized (min 8 m) ${normalized} louder than plain 1/4 m ${plain}`);
assert.ok(capped < plain, `unnormalized minDistance 8 m ${capped} quieter than 1/4 m ${plain}`);
sa.sa_free(distWorld);

sa.sa_free(world);

// Same scene, partition as a triangle mesh (sa_add_mesh) instead of a box
const meshWorld = sa.sa_create(SR, FRAME, 2, 1, 0);
assert.equal(sa.sa_add_box(meshWorld, -6, 0, -4.5, 6, 3.2, 4.5, 0.1, 0.1, 0.1, 0.05, 0.1, 0.1, 0.1, 1), 0);
const quad = new Float32Array([0, 0, -4.5, 0, 3.2, -4.5, 0, 3.2, 4.5, 0, 0, 4.5]);
const tris = new Int32Array([0, 1, 2, 0, 2, 3]);
const matIdx = new Int32Array([0, 0]);
const mats = new Float32Array([0.1, 0.1, 0.1, 0.05, 0, 0, 0]);
const bytes = quad.byteLength + tris.byteLength + matIdx.byteLength + mats.byteLength;
const ptr = sa.malloc(bytes);
let off = ptr;
for (const arr of [quad, tris, matIdx, mats]) {
  new Uint8Array(sa.memory.buffer, off, arr.byteLength).set(new Uint8Array(arr.buffer));
  off += arr.byteLength;
}
assert.equal(sa.sa_add_mesh(meshWorld, ptr, 4, ptr + quad.byteLength, 2,
  ptr + quad.byteLength + tris.byteLength, ptr + quad.byteLength + tris.byteLength + matIdx.byteLength, 1), 0);
sa.free(ptr);
assert.equal(sa.sa_commit_scene(meshWorld), 0);
const meshClear = sa.sa_add_source(meshWorld, -3, 1.4, 2);
const meshHidden = sa.sa_add_source(meshWorld, 3, 1.4, 0);
sa.sa_set_listener(meshWorld, -3, 1.6, -2, 0, 0, 1, 0, 1, 0);
assert.equal(sa.sa_simulate(meshWorld, 0), 0);
assert.ok(sa.sa_get_occlusion(meshWorld, meshClear) > 0.9, 'mesh: clear source is not occluded');
assert.ok(sa.sa_get_occlusion(meshWorld, meshHidden) < 0.1, 'mesh: hidden source is occluded');
sa.sa_free(meshWorld);
console.log(`gmod smoke ok (rms ${rms.toFixed(6)})`);
