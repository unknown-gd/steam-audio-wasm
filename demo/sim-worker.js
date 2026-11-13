// Simulation worker: owns the Steam Audio scene + simulator and runs ray tracing off the
// main thread. Publishes packed parameters to the AudioWorklet (MessagePort) and, at a
// lower rate, to the main thread for the HUD.
import createSteamAudioModule from '../dist/steam_audio.js';
import { createSteamAudioWorld, instantiateSteamAudio } from '../js/steam-audio.js';

const DIRECT_INTERVAL_MS = 16;
const REFLECT_INTERVAL_MS = 120;
const HUD_INTERVAL_MS = 100;

let world = null;
let audioPort = null;
let pose = null;
let active = null;
let activeChanged = false;
let lastReflect = -Infinity;
let lastHud = -Infinity;

function step() {
  if (world && pose) {
    try {
      world.setListener(pose.pos, pose.ahead, pose.up);
      if (activeChanged) {
        active.forEach((on, i) => world.setSourceActive(i, on));
      }
      const now = performance.now();
      // Newly audible sources need fresh reverb times right away.
      const doReflect = activeChanged || now - lastReflect >= REFLECT_INTERVAL_MS;
      activeChanged = false;
      world.simulate(doReflect);
      if (doReflect) lastReflect = now;

      const packet = world.exportParams();
      if (now - lastHud >= HUD_INTERVAL_MS) {
        lastHud = now;
        postMessage({ type: 'params', packet: packet.slice() });
      }
      audioPort.postMessage(packet, [packet.buffer]);
    } catch (e) {
      postMessage({ type: 'error', message: String(e?.message ?? e) });
      return;
    }
  }
  setTimeout(step, DIRECT_INTERVAL_MS);
}

async function init(msg) {
  audioPort = msg.port;
  const Module = await instantiateSteamAudio(createSteamAudioModule, { wasmModule: msg.wasmModule });
  world = createSteamAudioWorld(Module, {
    sampleRate: msg.sampleRate,
    frameSize: msg.frameSize,
    maxSources: msg.sources.length,
    reflectionDuration: msg.reflectionDuration,
    tuning: msg.tuning,
  });
  for (const b of msg.boxes) world.addBox(b.min, b.max, b.material, b.inward);
  world.commitScene();
  for (const p of msg.sources) world.addSource(...p);
  postMessage({ type: 'ready', version: world.version });
  step();
}

onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      init(msg).catch((e) => postMessage({ type: 'error', message: String(e?.message ?? e) }));
      break;
    case 'listener':
      // Only the latest pose matters; step() picks it up on its own schedule, so a slow
      // reflection pass never builds a backlog of stale poses.
      pose = msg;
      break;
    case 'active':
      active = msg.active;
      activeChanged = true;
      break;
    case 'tuning':
      world?.setTuning(msg.tuning);
      break;
  }
};
