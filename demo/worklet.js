// AudioWorklet renderer: effects-only Steam Audio world (no scene / ray tracing here).
// Parameters arrive from sim-worker.js over a MessagePort; sample playback, gain ramps
// and mixing all happen on the audio thread, so main-thread jank no longer causes dropouts.
//
// Worklets cannot fetch or use dynamic import(), so the factory is imported statically and
// the compiled WebAssembly.Module comes from the main thread via processorOptions.
import createSteamAudioModule from '../dist/steam_audio.js';
import { createSteamAudioWorld, instantiateSteamAudio } from '../js/steam-audio.js';

const RAMP_SECONDS = 0.06; // fade for room isolation changes
const LOOP_FADE = 256; // crossfade length at the sample loop point

class SteamAudioRenderer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions;
    this.numSources = opts.numSources;
    this.frameSize = opts.frameSize;
    this.world = null;
    this.samples = new Array(this.numSources).fill(null);
    this.cursors = new Float64Array(this.numSources);
    this.gain = new Float32Array(this.numSources); // current
    this.target = new Float32Array(this.numSources); // 0 or 1
    this.sourceGain = Float32Array.from(opts.sourceGains ?? new Array(this.numSources).fill(1));
    this.rampStep = this.frameSize / (RAMP_SECONDS * sampleRate);
    this.pendingParams = null;
    this.warnedSize = false;

    this.port.onmessage = (ev) => this.onMessage(ev.data);

    instantiateSteamAudio(createSteamAudioModule, { wasmModule: opts.wasmModule })
      .then((Module) => {
        const world = createSteamAudioWorld(Module, {
          sampleRate,
          frameSize: this.frameSize,
          maxSources: this.numSources,
          enableSimulation: false,
          reflectionDuration: opts.reflectionDuration,
          tuning: opts.tuning,
        });
        for (let i = 0; i < this.numSources; i++) world.addSource(0, 0, 0);
        if (this.pendingParams) world.importParams(this.pendingParams);
        this.world = world;
        this.port.postMessage({ type: 'ready', version: world.version });
      })
      .catch((e) => this.port.postMessage({ type: 'error', message: String(e?.message ?? e) }));
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'paramsPort':
        msg.port.onmessage = (ev) => {
          if (this.world) this.world.importParams(ev.data);
          else this.pendingParams = ev.data;
        };
        break;
      case 'sample':
        this.samples[msg.index] = msg.data;
        this.cursors[msg.index] = 0;
        break;
      case 'active':
        for (let i = 0; i < this.numSources; i++) this.target[i] = msg.active[i] ? 1 : 0;
        break;
      case 'tuning':
        this.world?.setTuning(msg.tuning);
        break;
    }
  }

  /** Copy one frame of looping sample `s` into dst, crossfading the loop point. */
  fill(dst, s) {
    const buf = this.samples[s];
    const n = buf.length;
    const fade = Math.min(LOOP_FADE, n >> 2);
    const loopLen = n - fade; // the tail is only ever heard inside the crossfade
    let c = this.cursors[s];
    for (let i = 0; i < dst.length; i++) {
      let v = buf[c];
      if (c < fade) {
        const t = c / fade;
        v = v * t + buf[loopLen + c] * (1 - t);
      }
      dst[i] = v * this.sourceGain[s];
      c = c + 1 === loopLen ? 0 : c + 1;
    }
    this.cursors[s] = c;
  }

  skip(s, frames) {
    const buf = this.samples[s];
    const loopLen = buf.length - Math.min(LOOP_FADE, buf.length >> 2);
    this.cursors[s] = (this.cursors[s] + frames) % loopLen;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] ?? out[0];
    outL.fill(0);
    outR.fill(0);
    const world = this.world;
    if (!world) return true;
    if (outL.length !== this.frameSize) {
      if (!this.warnedSize) {
        this.warnedSize = true;
        this.port.postMessage({ type: 'error', message: `render quantum ${outL.length} ≠ ${this.frameSize}` });
      }
      return true;
    }

    for (let s = 0; s < this.numSources; s++) {
      if (!this.samples[s]) continue;
      const from = this.gain[s];
      const to = this.target[s];
      if (from === 0 && to === 0) {
        this.skip(s, this.frameSize); // keep time moving while muted
        continue;
      }
      if (from === 0) {
        // Resuming after a mute: drop stale tails and smoothing state first.
        world.resetSource(s);
      }
      const next = to > from ? Math.min(to, from + this.rampStep) : Math.max(to, from - this.rampStep);
      this.gain[s] = next;

      this.fill(world.input, s);
      const [L, R] = world.processPlanar(s);
      const n = this.frameSize;
      const dg = (next - from) / n;
      let g = from;
      for (let i = 0; i < n; i++) {
        g += dg;
        outL[i] += L[i] * g;
        outR[i] += R[i] * g;
      }
    }

    // Gentle soft clip for summed sources.
    for (let i = 0; i < outL.length; i++) {
      outL[i] = Math.tanh(outL[i] * 1.15);
      outR[i] = Math.tanh(outR[i] * 1.15);
    }
    return true;
  }
}

registerProcessor('steam-audio-renderer', SteamAudioRenderer);
