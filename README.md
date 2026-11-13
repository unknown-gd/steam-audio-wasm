# Steam Audio WASM

Build [Steam Audio SDK 4.8.1](https://github.com/ValveSoftware/steam-audio/releases/tag/v4.8.1) for WebAssembly with Emscripten and use it from JavaScript.

Valve added experimental Emscripten support in 4.6.0 but does not ship prebuilt `.wasm` binaries. This repo builds `libphonon.a` from source and wraps it with Embind: HRTF binaural rendering plus scene simulation (distance / air absorption / volumetric occlusion / transmission and parametric reflections).

## Prerequisites

- [Nix](https://nixos.org/) with flakes — `nix develop` provides Emscripten, **CMake 3.31** (not 4.x), Python, Node (x86_64/aarch64 Linux, Apple Silicon macOS)
- Or: `emcc` / `emcmake`, **CMake 3.17–3.31** (CMake 4 rejects Steam Audio's older dep `cmake_minimum_required`), Python 3, GNU patch, Make, Git

Steam Audio is a flake input (`github:ValveSoftware/steam-audio/v4.8.1`), locked to an exact commit in `flake.lock`. `nix develop` copies it into `vendor/steam-audio` if missing and applies `patches/` via `scripts/apply-patches.sh`. An existing `vendor/steam-audio` that doesn't match the lock is left alone with a warning — delete it yourself to refresh.

> Nix only sees git-tracked files: `git add flake.nix flake.lock` (at least) before the first `nix develop`.

Without Nix, clone the source yourself: `git clone --depth 1 --branch v4.8.1 https://github.com/ValveSoftware/steam-audio.git vendor/steam-audio` (the build scripts apply the patches).

## Build

```bash
nix develop
./scripts/build-all.sh   # SDK + Embind module
node test/smoke.mjs      # end-to-end check of the built module
```

Or step by step:

```bash
./scripts/build-sdk.sh        # patches + deps + libphonon.a
./scripts/build-bindings.sh   # dist/steam_audio.{js,wasm}
```

Artifacts:

| Path | Description |
|------|-------------|
| `vendor/steam-audio/core/bin/lib/wasm/libphonon.a` | Static Steam Audio library |
| `dist/steam_audio.js` / `dist/steam_audio.wasm` | Embind ES module (web, worker, AudioWorklet, Node) |

Both are built with native Wasm exceptions (`-fwasm-exceptions`, override with `EXCEPTION_FLAGS=…`; both builds must match). Upstream builds wasm without exception support, which turns every internal Steam Audio error into an `abort()`; with it, errors come back as `IPLerror` codes and reach JS as normal `Error`s with a message.

## CI

GitHub Actions (`.github/workflows/ci.yml`):

1. **Check JS** — `node --check` on `js/`, `demo/`, `test/`
2. **Build WASM** — `nix develop` + `./scripts/build-all.sh`, verifies `phonon_version.h` is 4.8.1, runs `test/smoke.mjs`, uploads `dist/` as an artifact

## JavaScript API

```js
import { loadSteamAudioWorld, Materials, SteamAudioMaterials } from './js/steam-audio.js';

const world = await loadSteamAudioWorld({ sampleRate: audioCtx.sampleRate, frameSize: 512 });
world.addBox([-6, 0, -4.5], [6, 3.2, 4.5], SteamAudioMaterials.plaster, true); // room shell
world.addBox([-0.1, 0, -2], [0.1, 2.5, 2], SteamAudioMaterials.wood);          // partition
world.commitScene();
const id = world.addSource(-3, 1.4, -1);
world.setListener([0, 1.6, 3], [0, 0, -1], [0, 1, 0]);
world.simulate(true); // direct + parametric reflections
const stereo = world.process(id, monoFloat32); // interleaved L/R
```

Coordinates: **+x right, +y up, −z forward** (Steam Audio / OpenGL-style).

**Config** (passed to `loadSteamAudioWorld`, fixed for the world's lifetime): `sampleRate`, `frameSize`, `maxSources` (default 8; `addSource` throws beyond it — Steam Audio would otherwise silently drop reflections), `enableSimulation`, `enableReflections`, `reflectionDuration` (default 2 s; must cover the longest RT60 you expect), `numRays`, `numBounces`, `numDiffuseSamples`, `numOcclusionSamples`, `numTransmissionRays`.

**Tuning** (`opts.tuning` or `world.setTuning(partial)`, any time). Defaults are physically neutral; floors and boosts are opt-in:

| Field | Default | Effect |
|---|---|---|
| `minDistance` | 1 | inverse-distance reference distance (m) |
| `occlusionRadius` | 0.5 | volumetric occlusion source radius (m) |
| `distanceFloor`, `airFloorLow/Mid/High`, `transmissionFloor` | 0 | lower bounds on direct-path gains |
| `freqIndependentTransmission` | false | single-gain transmission (muffled-but-audible feel) |
| `reflectionsGain` | 1 | wet input gain |
| `reflectionsFollowDistance`, `reflectionsDistanceFloor` | false, 0 | scale wet input by direct distance attenuation (non-physical: the simulation already includes propagation) |
| `occludedWetBoost` | 0 | wet × (1 + (1 − occlusion) × boost) |
| `reverbTimeFloor` | 0 | lower bound on RT60 (s) |
| `reverbDecorrelationMs` | 8 | right-ear delay of the (mono) parametric reverb; 0 = mono |
| `directSmoothing`, `occlusionSmoothing`, `reverbSmoothing` | 0.05, 0.12, 0.08 | one-pole time constants (s), frame-size independent |

**Other methods**: `setSourcePosition`, `setSourceActive(id, bool)` (inactive sources skip ray tracing), `resetSource(id)` (clear tails/smoothing before un-muting), `getOcclusion`, `destroy()` (idempotent).

**Zero-copy / audio thread**: write into `world.input` (a `Float32Array` view of wasm memory) and call `world.processPlanar(id)` → `[left, right]` views. No allocations; re-read `world.input` after each call (views are replaced if wasm memory grows).

**Threaded use**: run a simulating world on a Worker and an effects-only world (`enableSimulation: false`) on the AudioWorklet. Post `world.exportParams()` (a transferable `Float32Array`) from the worker and call `importParams()` on the renderer. Inside an AudioWorklet there is no `fetch`, dynamic `import()` or `URL`, so import `dist/steam_audio.js` statically and pass a precompiled `WebAssembly.Module`:

```js
import createSteamAudioModule from '../dist/steam_audio.js';
import { instantiateSteamAudio, createSteamAudioWorld } from '../js/steam-audio.js';
const Module = await instantiateSteamAudio(createSteamAudioModule, { wasmModule });
const renderer = createSteamAudioWorld(Module, { sampleRate, frameSize: 128, enableSimulation: false });
```

**Materials**: `SteamAudioMaterials` are Valve's physically based presets (from the Unity plugin). `Materials` / `MaterialInfo` are the demo's tuned set — similar absorption, but 3–10× more transmission so occluded sources stay audible.

## Demo

Five connected rooms (carpeted hall and vault, three reflective marble/glass chambers) with baffles and four looping sources, one per side room. Walk around to hear distance loss, occlusion behind baffles, and reverb differences between rooms. Sources are isolated per room (doorways have clear line of sight, so the demo mutes other rooms, with short fades).

Architecture: main thread renders (three.js) and posts the listener pose; `demo/sim-worker.js` owns the scene and runs direct simulation (~60 Hz) and reflections (every 120 ms) for active sources only; `demo/worklet.js` renders audio at the 128-frame render quantum from parameters it receives directly from the worker. Audio runs at the device's sample rate.

```bash
npx --yes serve -p 4173 .
# open http://localhost:4173/demo/  (click to start + capture pointer, WASD to move)
```

AudioWorklet requires a secure context (`https://` or `localhost`). `globalThis.steamAudioDemo` exposes the audio graph for debugging.

## Notes

- Experimental upstream support: SIMD128 + Neon flags, static library only, no pthreads.
- Embree / Radeon Rays / TrueAudio Next are disabled on wasm; Steam Audio's built-in ray tracer is used. It is double-sided, so triangle winding (`inward`) doesn't affect results.
- Reflections use **parametric** reverb (RT60 per band, order-0 energy field). It's mono, so the bindings skip the ambisonic decode and add a short decorrelation delay. Convolution / hybrid reverb is available in the C API if you extend the bindings.
- When linking `libphonon.a` yourself, also link `libpffft`, `libmysofa`, and `libz` from `core/deps/*/lib/wasm/release/`, and use the same exception flags.
- Local fixes in `patches/` (applied idempotently by `scripts/apply-patches.sh`, which fails on conflicts instead of leaving `.rej` files):
  - `steam-audio-flatbuffers-linux-warnings.patch` — FlatBuffers host build on Linux GCC
  - `flatbuffers-1.12-deleted-assign.patch` — FlatBuffers 1.12 + modern Clang
  - `steam-audio-wasm-sync-threadpool.patch` — run reflection jobs synchronously (no pthreads)
- Steam Audio's effect `reset()` functions leave ~2 frames of internal buffering (≈ −80 dB) — not an issue in practice.
- Source tree: `vendor/steam-audio` at tag `v4.8.1` (Apache-2.0), gitignored.
