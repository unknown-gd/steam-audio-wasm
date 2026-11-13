// Node smoke test: exercises the built module end-to-end (scene → simulate → render).
//   node test/smoke.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createSteamAudioWorld,
  instantiateSteamAudio,
  loadSteamAudioWorld,
  Materials,
  paramsOcclusion,
  PARAM_HEADER,
  PARAM_STRIDE,
} from '../js/steam-audio.js';

const FRAME = 256;
const SR = 48000;

function rms(a) {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s / a.length);
}

function allFinite(a) {
  for (const v of a) if (!Number.isFinite(v)) return false;
  return true;
}

function noise(n, seed = 1) {
  const out = new Float32Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x / 2 ** 32) * 2 - 1;
  }
  return out;
}

// --- Simulating world ---
const world = await loadSteamAudioWorld({ sampleRate: SR, frameSize: FRAME, maxSources: 2 });
assert.equal(world.version, '4.8.1');
assert.equal(world.frameSize, FRAME);

world.addBox([-6, 0, -4.5], [6, 3.2, 4.5], Materials.plaster, true); // room shell
world.addBox([-0.1, 0, -4.5], [0.1, 3.2, 4.5], Materials.shell, false); // full partition
world.commitScene();
const clear = world.addSource(-3, 1.4, 2); // same side as listener
const hidden = world.addSource(3, 1.4, 0); // behind the partition
world.setListener([-3, 1.6, -2], [0, 0, 1], [0, 1, 0]);
world.simulate(true);

assert.ok(world.getOcclusion(clear) > 0.9, `clear source occlusion ${world.getOcclusion(clear)}`);
assert.ok(world.getOcclusion(hidden) < 0.1, `hidden source occlusion ${world.getOcclusion(hidden)}`);

// maxSources is enforced with a readable error (C++ exception → JS Error)
assert.throws(() => world.addSource(0, 1, 0), /maxSources/);
assert.throws(() => world.getOcclusion(42), /invalid source id/);

// Render: non-silent, finite, reverb tail continues after input stops
let energy = 0;
for (let f = 0; f < 20; f++) {
  const out = world.process(clear, noise(FRAME, f + 1));
  assert.ok(allFinite(out), 'non-finite output');
  energy += rms(out);
}
assert.ok(energy > 0.01, `output too quiet: ${energy}`);
const tail = world.process(clear, new Float32Array(FRAME));
assert.ok(rms(tail) > 0, 'expected a reverb tail');

// Zero-copy path
world.input.set(noise(FRAME, 99));
const [L, R] = world.processPlanar(clear);
assert.equal(L.length, FRAME);
assert.ok(allFinite(L) && allFinite(R));

// Reset drops the reverb tail. Steam Audio's effect resets leave ~2 frames of internal
// (binaural/direct) buffering at around -80 dB, so check the level rather than exact zero.
const beforeReset = rms(world.process(clear, new Float32Array(FRAME)));
world.resetSource(clear);
const afterReset = rms(world.process(clear, new Float32Array(FRAME)));
assert.ok(afterReset < 1e-3 && afterReset < beforeReset, `tail after reset: ${afterReset}`);
for (let f = 0; f < 3; f++) world.process(clear, new Float32Array(FRAME));
const settled = rms(world.process(clear, new Float32Array(FRAME)));
assert.ok(settled < 1e-6, `not silent after reset: ${settled}`);

// --- Params handoff to an effects-only world (Worker → AudioWorklet pattern) ---
const packet = world.exportParams();
assert.equal(packet.length, PARAM_HEADER + 2 * PARAM_STRIDE);
assert.ok(paramsOcclusion(packet, hidden) < 0.1);

const wasmModule = await WebAssembly.compile(
  await readFile(new URL('../dist/steam_audio.wasm', import.meta.url)),
);
const { default: factory } = await import('../dist/steam_audio.js');
const Module = await instantiateSteamAudio(factory, { wasmModule });
const renderer = createSteamAudioWorld(Module, {
  sampleRate: SR,
  frameSize: FRAME,
  maxSources: 2,
  enableSimulation: false,
});
assert.equal(renderer.simulationEnabled, false);
renderer.addSource(0, 0, 0);
renderer.addSource(0, 0, 0);
renderer.importParams(packet);
assert.throws(() => renderer.simulate(true), /simulation is disabled/);
const rendered = renderer.process(hidden, noise(FRAME, 7));
assert.ok(allFinite(rendered));

// Tuning round-trip
renderer.setTuning({ distanceFloor: 0.25 });
assert.ok(Math.abs(renderer.getTuning().distanceFloor - 0.25) < 1e-6);

world.destroy();
world.destroy(); // idempotent
renderer.destroy();
console.log('smoke ok');
