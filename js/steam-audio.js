/**
 * JS façade over SteamAudioWorld (scene + occlusion + parametric reflections).
 *
 *   import { loadSteamAudioWorld, Materials } from './steam-audio.js';
 *   const world = await loadSteamAudioWorld({ sampleRate: 48000, frameSize: 512 });
 *   world.addBox(min, max, Materials.plaster, true);
 *   const id = world.addSource(x, y, z);
 *   world.simulate(true);
 *   const stereo = world.process(id, monoFrame); // interleaved L/R
 *
 * Threaded use (see demo/): a world with `enableSimulation: true` runs simulate() on a
 * Worker and posts `exportParams()`; a world with `enableSimulation: false` on the
 * AudioWorklet thread calls `importParams()` and `processPlanar()`. In an AudioWorklet,
 * dynamic import() and fetch are unavailable: import the Emscripten factory statically
 * and call `instantiateSteamAudio(factory, { wasmModule })` with a precompiled
 * WebAssembly.Module posted from the main thread.
 */

/** @type {Map<string, Promise<any>>} */
const moduleCache = new Map();

// Computed lazily: `URL` does not exist in AudioWorkletGlobalScope, and this module is
// imported there too (only the synchronous helpers are used on that thread).
const defaultModuleUrl = () => new URL('../dist/steam_audio.js', import.meta.url).href;

function resolveFactory(mod) {
  const candidate =
    mod?.default ??
    mod?.createSteamAudioModule ??
    (typeof mod === 'function' ? mod : null);
  if (typeof candidate !== 'function') {
    throw new TypeError(
      'Steam Audio module did not export a factory (rebuild with -sEXPORT_ES6=1)',
    );
  }
  return candidate;
}

/**
 * Instantiate the Emscripten module from an already-imported factory.
 * @param {Function} factory  default export of dist/steam_audio.js
 * @param {object} [opts]
 * @param {WebAssembly.Module} [opts.wasmModule] precompiled module (required in AudioWorklets)
 * @param {string} [opts.wasmUrl] absolute URL of steam_audio.wasm
 */
export function instantiateSteamAudio(factory, opts = {}) {
  const config = {};
  let rejectInstantiate;
  const instantiateFailed = new Promise((_, reject) => {
    rejectInstantiate = reject;
  });
  if (opts.wasmModule) {
    // Never consulted for loading, but keeps the glue from calling `new URL()`
    // (missing in AudioWorkletGlobalScope) to compute a default .wasm path.
    config.locateFile = (path) => path;
    config.instantiateWasm = (imports, receive) => {
      WebAssembly.instantiate(opts.wasmModule, imports).then(
        (instance) => receive(instance, opts.wasmModule),
        // Emscripten would otherwise wait forever for receive().
        (err) => rejectInstantiate(err),
      );
      return {};
    };
  } else if (opts.wasmUrl) {
    config.locateFile = (path, prefix) =>
      path.endsWith('.wasm') ? opts.wasmUrl : prefix + path;
  }
  return Promise.race([factory(config), instantiateFailed]);
}

/**
 * Load (once per URL) and instantiate the Emscripten module.
 * Concurrent callers share one instance; a failed load is not cached so it can be retried.
 * @param {object} [opts]
 * @param {string} [opts.moduleUrl] URL of steam_audio.js (relative URLs resolve against the page)
 * @param {WebAssembly.Module} [opts.wasmModule]
 */
export function loadSteamAudioModule(opts = {}) {
  const base = globalThis.location?.href ?? import.meta.url;
  const url = opts.moduleUrl ? new URL(opts.moduleUrl, base).href : defaultModuleUrl();
  const key = opts.wasmModule ? null : url; // a caller-supplied wasmModule bypasses the cache
  if (key && moduleCache.has(key)) return moduleCache.get(key);

  const promise = (async () => {
    const factory = resolveFactory(await import(url));
    return instantiateSteamAudio(factory, {
      wasmModule: opts.wasmModule,
      wasmUrl: new URL('steam_audio.wasm', url).href,
    });
  })();
  if (key) {
    moduleCache.set(key, promise);
    promise.catch(() => moduleCache.delete(key));
  }
  return promise;
}

/**
 * Acoustic material bands for Steam Audio's IPLMaterial:
 *   bands = [absLow, absMid, absHigh, scattering, txLow, txMid, txHigh]
 * All values are 0–1.
 *
 * `SteamAudioMaterials` are the presets shipped with Valve's Unity plugin
 * (physically based; use these for realistic results).
 */
export const SteamAudioMaterials = {
  generic: [0.10, 0.20, 0.30, 0.05, 0.100, 0.050, 0.030],
  brick: [0.03, 0.04, 0.07, 0.05, 0.015, 0.015, 0.015],
  concrete: [0.05, 0.07, 0.08, 0.05, 0.015, 0.002, 0.001],
  ceramic: [0.01, 0.01, 0.02, 0.05, 0.060, 0.044, 0.011],
  gravel: [0.60, 0.70, 0.80, 0.05, 0.031, 0.012, 0.008],
  carpet: [0.24, 0.69, 0.73, 0.05, 0.020, 0.005, 0.003],
  glass: [0.06, 0.03, 0.02, 0.05, 0.060, 0.044, 0.011],
  plaster: [0.12, 0.06, 0.04, 0.05, 0.056, 0.056, 0.004],
  rock: [0.13, 0.20, 0.24, 0.05, 0.015, 0.002, 0.001],
  wood: [0.11, 0.07, 0.06, 0.05, 0.070, 0.014, 0.005],
  metal: [0.20, 0.07, 0.06, 0.05, 0.200, 0.025, 0.010],
};

/**
 * Demo-tuned materials. Absorption mostly follows the Steam Audio presets, but
 * transmission is deliberately 3–10× higher so occluded sources stay audible
 * ("muffled, not muted") in the demo. Prefer `SteamAudioMaterials` for realism.
 */
export const MaterialInfo = {
  plaster: {
    name: 'Plaster',
    bands: [0.12, 0.06, 0.04, 0.05, 0.18, 0.12, 0.07],
    note: 'Hard room shell — bright reflections, moderate bleed',
  },
  wood: {
    name: 'Wood',
    bands: [0.11, 0.07, 0.06, 0.05, 0.22, 0.14, 0.08],
    note: 'Doors / partitions — warmer, more transmission than plaster',
  },
  carpet: {
    name: 'Carpet',
    bands: [0.24, 0.69, 0.73, 0.05, 0.04, 0.02, 0.01],
    note: 'Floor — strong mid/high absorption, little transmission',
  },
  glass: {
    name: 'Glass',
    bands: [0.06, 0.03, 0.02, 0.05, 0.35, 0.28, 0.18],
    note: 'Hard & bright — reflective, more transmission',
  },
  marble: {
    name: 'Marble',
    // Empty reflective chambers — very low absorption, long reverb tails
    bands: [0.01, 0.012, 0.015, 0.02, 0.03, 0.02, 0.012],
    note: 'Polished reflective chamber — almost no absorption',
  },
  /** Hide-behind walls: muffles direct path without muting (shell stays ≈0). */
  occluder: {
    name: 'Occluder',
    bands: [0.08, 0.07, 0.06, 0.08, 0.2, 0.14, 0.09],
    note: 'Interior baffle — muffles when hiding, still audible',
  },
  concrete: {
    name: 'Concrete',
    // Interior structure (columns / piers) — reflective, moderate bleed
    bands: [0.04, 0.05, 0.07, 0.04, 0.12, 0.08, 0.05],
    note: 'Interior structure — reflective, some transmission',
  },
  exterior: {
    name: 'Exterior',
    // True outside face (if used) — opaque
    bands: [0.02, 0.03, 0.04, 0.02, 0.0005, 0.0003, 0.0001],
    note: 'Outside face — transmission ≈ 0',
  },
  shell: {
    name: 'Sealed plaster',
    // Room-facing outer walls: interior plaster look, still opaque to the outdoors
    bands: [0.12, 0.06, 0.04, 0.05, 0.0005, 0.0003, 0.0001],
    note: 'Interior finish on outer walls — reflective plaster, no bleed outside',
  },
};

/** Convenience: MaterialInfo.*.bands keyed by id */
export const Materials = Object.fromEntries(
  Object.entries(MaterialInfo).map(([id, m]) => [id, m.bands]),
);

export function materialIdFromBands(bands) {
  if (!bands) return null;
  for (const [id, info] of Object.entries(MaterialInfo)) {
    if (info.bands.length === bands.length && info.bands.every((v, i) => v === bands[i])) {
      return id;
    }
  }
  return null;
}

export function formatMaterialBands(bands) {
  if (!bands || bands.length < 7) return '—';
  const [aL, aM, aH, sc, tL, tM, tH] = bands;
  return `abs ${aL.toFixed(2)}/${aM.toFixed(2)}/${aH.toFixed(2)}  sc ${sc.toFixed(2)}  tx ${tL.toFixed(2)}/${tM.toFixed(2)}/${tH.toFixed(2)}`;
}

/** Packed-parameter layout of exportParams()/importParams() (mirrors the C++ constants). */
export const PARAM_HEADER = 10;
export const PARAM_STRIDE = 15;

/** Occlusion (0 = blocked, 1 = clear) of source `id` from an exportParams() packet. */
export function paramsOcclusion(packet, id) {
  return packet[PARAM_HEADER + PARAM_STRIDE * id + 5];
}

/** Convert a thrown C++ exception (WebAssembly.Exception) into a readable Error. */
function toError(Module, e) {
  if (
    typeof WebAssembly.Exception === 'function' &&
    e instanceof WebAssembly.Exception &&
    typeof Module.getExceptionMessage === 'function'
  ) {
    const [type, message] = Module.getExceptionMessage(e);
    Module.decrementExceptionRefcount?.(e);
    return new Error(`Steam Audio: ${message || type}`);
  }
  return e;
}

/**
 * Wrap an instantiated module in a world. Synchronous, so it can be used on an
 * AudioWorklet thread once the module is ready.
 * @param {any} Module  result of loadSteamAudioModule()/instantiateSteamAudio()
 * @param {object} [opts]  WorldConfig fields (sampleRate, frameSize, maxSources,
 *   enableSimulation, enableReflections, reflectionDuration, numRays, numBounces,
 *   numDiffuseSamples, numOcclusionSamples, numTransmissionRays) plus `tuning`
 *   (partial Tuning, see setTuning()).
 */
export function createSteamAudioWorld(Module, opts = {}) {
  const guard = (fn) => {
    try {
      return fn();
    } catch (e) {
      throw toError(Module, e);
    }
  };

  const defaults = Module.defaultWorldConfig();
  const config = {};
  for (const key of Object.keys(defaults)) {
    config[key] = opts[key] ?? defaults[key];
  }
  const native = guard(() => new Module.SteamAudioWorld(config));
  let destroyed = false;
  let input = native.inputView();
  let outLeft = null;
  let outRight = null;

  const refreshViews = () => {
    // Views detach (length 0) when wasm memory grows.
    if (input.length === 0) input = native.inputView();
    if (!outLeft || outLeft.length === 0) {
      outLeft = native.outputChannelView(0);
      outRight = native.outputChannelView(1);
    }
  };

  const world = {
    version: native.version(),
    sampleRate: native.sampleRate(),
    frameSize: native.frameSize(),
    maxSources: native.maxSources(),
    simulationEnabled: native.simulationEnabled(),

    /** Current tuning (see bindings/steam_audio_bind.cpp `Tuning`). */
    getTuning() {
      return native.getTuning();
    },

    /** Merge `partial` into the current tuning. */
    setTuning(partial) {
      guard(() => native.setTuning({ ...native.getTuning(), ...partial }));
    },

    /**
     * Axis-aligned box collider / acoustic surface.
     * @param {[number,number,number]} min
     * @param {[number,number,number]} max
     * @param {number[]} material 7-band material (see Materials)
     * @param {boolean} [inward=false] room shell normals face inward
     */
    addBox(min, max, material, inward = false) {
      if (!material || material.length !== 7) {
        throw new TypeError('addBox: material must have 7 bands (see Materials)');
      }
      const m = material;
      guard(() => native.addBox(
        min[0], min[1], min[2],
        max[0], max[1], max[2],
        m[0], m[1], m[2], m[3], m[4], m[5], m[6],
        !!inward,
      ));
    },

    commitScene() {
      guard(() => native.commitScene());
    },

    /** @returns {number} source id */
    addSource(x, y, z) {
      return guard(() => native.addSource(x, y, z));
    },

    setListener(pos, ahead, up = [0, 1, 0]) {
      native.setListener(pos[0], pos[1], pos[2], ahead[0], ahead[1], ahead[2], up[0], up[1], up[2]);
    },

    setSourcePosition(id, x, y, z) {
      guard(() => native.setSourcePosition(id, x, y, z));
    },

    /** Inactive sources are skipped by simulate(). */
    setSourceActive(id, active) {
      guard(() => native.setSourceActive(id, !!active));
    },

    /** Clear effect tails and smoothing (call before un-muting a source). */
    resetSource(id) {
      guard(() => native.resetSource(id));
    },

    /** @param {boolean} [runReflections=true] */
    simulate(runReflections = true) {
      guard(() => native.simulate(!!runReflections));
    },

    /** Occlusion factor 0=fully occluded, 1=clear (Steam Audio convention). */
    getOcclusion(id) {
      return guard(() => native.getOcclusion(id));
    },

    /** Copy of the packed listener + source parameters (transferable). */
    exportParams() {
      return guard(() => native.exportParams().slice());
    },

    /** Apply a packet from another world's exportParams(). */
    importParams(packet) {
      guard(() => native.importParams(packet));
    },

    /**
     * Mono input frame (wasm memory view, frameSize floats). Write into it, then call
     * processPlanar(id) / process(id). Re-read this property after each call; it may be
     * replaced if wasm memory grows.
     */
    get input() {
      refreshViews();
      return input;
    },

    /**
     * Render `world.input` for one source. Returns [left, right] views into wasm memory,
     * valid until the next call. Allocation-free: safe on the audio thread.
     */
    processPlanar(id) {
      guard(() => native.process(id));
      refreshViews();
      return [outLeft, outRight];
    },

    /**
     * Convenience: copy `mono` in, render, return interleaved stereo.
     * @param {number} id
     * @param {Float32Array|number[]} [mono] frameSize samples (omit if you wrote world.input)
     * @param {Float32Array} [out] reused interleaved stereo buffer
     * @returns {Float32Array} interleaved stereo
     */
    process(id, mono, out) {
      if (mono) {
        if (mono.length !== world.frameSize) {
          throw new RangeError(`process: mono frame must have ${world.frameSize} samples`);
        }
        refreshViews();
        input.set(mono);
      }
      guard(() => native.process(id));
      const view = native.outputView();
      if (!out || out.length !== view.length) {
        out = new Float32Array(view.length);
      }
      out.set(view);
      return out;
    },

    /** Idempotent. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      native.destroy();
      native.delete();
    },
  };

  if (opts.tuning) world.setTuning(opts.tuning);
  return world;
}

/**
 * @param {object} [opts]  see createSteamAudioWorld(); plus moduleUrl / wasmModule
 */
export async function loadSteamAudioWorld(opts = {}) {
  const Module = await loadSteamAudioModule(opts);
  return createSteamAudioWorld(Module, opts);
}

/** @deprecated use loadSteamAudioWorld */
export async function loadSteamAudio(opts) {
  return loadSteamAudioWorld(opts);
}
