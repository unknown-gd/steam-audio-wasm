// Embind wrapper: binaural + scene simulation (occlusion / transmission / parametric reflections).
//
// A SteamAudioWorld can run in two roles:
//   * simulation enabled (default): owns a scene + simulator; simulate() produces per-source
//     parameters that process() uses directly.
//   * simulation disabled: effects only. Parameters come from another instance via
//     exportParams() → importParams(). This lets the expensive ray tracing run on a Worker
//     while the AudioWorklet thread only renders.
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <phonon.h>

using namespace emscripten;

namespace {

// Packed parameter layout shared by exportParams()/importParams().
constexpr int kParamHeader = 10;  // numSources, listener origin[3], ahead[3], up[3]
constexpr int kParamStride = 15;  // active, pos[3], distAtt, occlusion, air[3], transmission[3], reverbTimes[3]

[[noreturn]] void fail(IPLerror err, const char* what) {
    throw std::runtime_error(std::string(what) + " failed with code " +
                             std::to_string(static_cast<int>(err)));
}

void check(IPLerror err, const char* what) {
    if (err != IPL_STATUS_SUCCESS) {
        fail(err, what);
    }
}

IPLVector3 cross(const IPLVector3& a, const IPLVector3& b) {
    return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}

float length(const IPLVector3& v) { return std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }

bool normalize(IPLVector3& v) {
    const float len = length(v);
    if (!(len > 1e-8f) || !std::isfinite(len)) {
        return false;
    }
    v.x /= len;
    v.y /= len;
    v.z /= len;
    return true;
}

IPLCoordinateSpace3 makeCoords(IPLVector3 origin, IPLVector3 ahead, IPLVector3 up) {
    if (!normalize(ahead)) ahead = {0, 0, -1};
    if (!normalize(up)) up = {0, 1, 0};
    IPLCoordinateSpace3 c{};
    c.origin = origin;
    c.ahead = ahead;
    // right = ahead × up (Steam Audio right-handed); re-orthogonalize up.
    c.right = cross(ahead, up);
    if (!normalize(c.right)) {
        // ahead ∥ up: pick any perpendicular.
        c.right = std::fabs(ahead.y) < 0.9f ? cross(ahead, IPLVector3{0, 1, 0}) : cross(ahead, IPLVector3{1, 0, 0});
        normalize(c.right);
    }
    c.up = cross(c.right, ahead);
    return c;
}

// One-pole smoothing coefficient for a time constant (seconds) at a given update period.
float smoothingAlpha(float tau, float period) {
    if (!(tau > 0.0f)) return 1.0f;
    return 1.0f - std::exp(-period / tau);
}

void lerpToward(float& cur, float target, float t) { cur += (target - cur) * t; }

}  // namespace

// Construction-time settings. Defaults suit a handful of sources in room-scale scenes.
struct WorldConfig {
    int sampleRate = 48000;
    int frameSize = 512;
    int maxSources = 8;
    bool enableSimulation = true;
    bool enableReflections = true;
    float reflectionDuration = 2.0f;  // seconds of energy field; must cover the longest RT60 you expect
    int numRays = 768;
    int numBounces = 8;
    int numDiffuseSamples = 32;
    int numOcclusionSamples = 16;
    int numTransmissionRays = 8;
};

// Runtime-tunable rendering. Defaults are physically neutral (no floors, no boosts);
// the demo opts into its "game feel" values explicitly.
struct Tuning {
    // Simulation
    float minDistance = 1.0f;        // inverse-distance model reference distance (m)
    float occlusionRadius = 0.5f;    // volumetric occlusion source radius (m)
    // Direct path
    float distanceFloor = 0.0f;      // lower bound on distance attenuation
    float airFloorLow = 0.0f;        // lower bound on air absorption per band
    float airFloorMid = 0.0f;
    float airFloorHigh = 0.0f;
    float transmissionFloor = 0.0f;  // lower bound on transmission per band
    bool freqIndependentTransmission = false;
    // Reflections
    float reflectionsGain = 1.0f;
    bool reflectionsFollowDistance = false;  // scale wet input by direct distance attenuation
    float reflectionsDistanceFloor = 0.0f;   // floor for the above
    float occludedWetBoost = 0.0f;           // wet *= 1 + (1 - occlusion) * boost
    float reverbTimeFloor = 0.0f;            // lower bound on RT60 per band (s)
    float reverbDecorrelationMs = 8.0f;      // right-ear delay of the mono reverb (0 = mono)
    // Smoothing time constants (seconds, 0 = off). Applied per audio frame.
    float directSmoothing = 0.05f;
    float occlusionSmoothing = 0.12f;
    float reverbSmoothing = 0.08f;
};

namespace {

struct SimParams {
    float distanceAttenuation = 1.0f;
    float occlusion = 1.0f;
    float air[3] = {1.0f, 1.0f, 1.0f};
    float transmission[3] = {1.0f, 1.0f, 1.0f};
    float reverbTimes[3] = {0.0f, 0.0f, 0.0f};
};

struct SourceState {
    IPLSource handle = nullptr;  // only with simulation enabled
    IPLDirectEffect direct = nullptr;
    IPLReflectionEffect reflection = nullptr;
    IPLBinauralEffect binaural = nullptr;
    IPLVector3 position{};
    bool active = true;
    SimParams params;   // latest simulation result (own sim or imported)
    SimParams smooth;   // per-frame smoothed version used for rendering
    bool smoothInit = false;
    std::vector<float> decorrelation;  // ring buffer for the right-ear reverb delay
    size_t decorrelationIndex = 0;
};

}  // namespace

class SteamAudioWorld {
public:
    explicit SteamAudioWorld(const WorldConfig& config) : config_(config) {
        if (config_.sampleRate <= 0 || config_.frameSize <= 0) {
            throw std::runtime_error("sampleRate and frameSize must be positive");
        }
        if (config_.maxSources <= 0) {
            throw std::runtime_error("maxSources must be positive");
        }
        try {
            init();
        } catch (...) {
            destroy();
            throw;
        }
    }

    ~SteamAudioWorld() { destroy(); }

    SteamAudioWorld(const SteamAudioWorld&) = delete;
    SteamAudioWorld& operator=(const SteamAudioWorld&) = delete;

    int sampleRate() const { return config_.sampleRate; }
    int frameSize() const { return config_.frameSize; }
    int maxSources() const { return config_.maxSources; }
    int numSources() const { return static_cast<int>(sources_.size()); }
    bool simulationEnabled() const { return simulator_ != nullptr; }
    std::string version() const {
        return std::to_string(STEAMAUDIO_VERSION_MAJOR) + "." +
               std::to_string(STEAMAUDIO_VERSION_MINOR) + "." +
               std::to_string(STEAMAUDIO_VERSION_PATCH);
    }

    Tuning getTuning() const { return tuning_; }
    void setTuning(const Tuning& t) {
        tuning_ = t;
        for (SourceState& src : sources_) {
            resizeDecorrelation(src);
        }
    }

    // Add an axis-aligned box. Steam Audio's default ray tracer is double-sided (hit normals
    // are flipped toward the incoming ray), so winding / "inward" only matters for other
    // ray tracers; kept for API compatibility.
    void addBox(float minX, float minY, float minZ, float maxX, float maxY, float maxZ,
                float absL, float absM, float absH, float scatter,
                float txL, float txM, float txH, bool inward) {
        ensureAlive();
        requireSimulation("addBox");

        IPLMaterial mat{};
        mat.absorption[0] = absL;
        mat.absorption[1] = absM;
        mat.absorption[2] = absH;
        mat.scattering = scatter;
        mat.transmission[0] = txL;
        mat.transmission[1] = txM;
        mat.transmission[2] = txH;

        const IPLVector3 v[8] = {
            {minX, minY, minZ}, {maxX, minY, minZ}, {maxX, maxY, minZ}, {minX, maxY, minZ},
            {minX, minY, maxZ}, {maxX, minY, maxZ}, {maxX, maxY, maxZ}, {minX, maxY, maxZ},
        };
        // a-b-c-d counter-clockwise when viewed along the outward normal
        const int faces[6][4] = {
            {0, 3, 2, 1},  // -Z
            {4, 5, 6, 7},  // +Z
            {0, 4, 7, 3},  // -X
            {1, 2, 6, 5},  // +X
            {0, 1, 5, 4},  // -Y
            {3, 7, 6, 2},  // +Y
        };

        IPLVector3 vertices[24];
        IPLTriangle triangles[12];
        IPLint32 materialIndices[12] = {};
        for (int f = 0; f < 6; ++f) {
            const int base = f * 4;
            for (int k = 0; k < 4; ++k) vertices[base + k] = v[faces[f][k]];
            if (inward) {
                triangles[f * 2] = IPLTriangle{{base + 0, base + 2, base + 1}};
                triangles[f * 2 + 1] = IPLTriangle{{base + 0, base + 3, base + 2}};
            } else {
                triangles[f * 2] = IPLTriangle{{base + 0, base + 1, base + 2}};
                triangles[f * 2 + 1] = IPLTriangle{{base + 0, base + 2, base + 3}};
            }
        }

        IPLStaticMeshSettings meshSettings{};
        meshSettings.numVertices = 24;
        meshSettings.numTriangles = 12;
        meshSettings.numMaterials = 1;
        meshSettings.vertices = vertices;
        meshSettings.triangles = triangles;
        meshSettings.materialIndices = materialIndices;
        meshSettings.materials = &mat;

        IPLStaticMesh mesh = nullptr;
        check(iplStaticMeshCreate(scene_, &meshSettings, &mesh), "iplStaticMeshCreate");
        iplStaticMeshAdd(mesh, scene_);
        meshes_.push_back(mesh);
        sceneDirty_ = true;
    }

    void commitScene() {
        ensureAlive();
        if (scene_ && sceneDirty_) {
            iplSceneCommit(scene_);
            sceneDirty_ = false;
        }
    }

    int addSource(float x, float y, float z) {
        ensureAlive();
        if (static_cast<int>(sources_.size()) >= config_.maxSources) {
            // Steam Audio silently drops reflections for sources beyond maxNumSources.
            throw std::runtime_error("addSource: maxSources (" + std::to_string(config_.maxSources) +
                                     ") reached; raise WorldConfig.maxSources");
        }
        commitScene();

        sources_.emplace_back();
        SourceState& src = sources_.back();
        try {
            src.position = {x, y, z};
            if (simulator_) {
                IPLSourceSettings sourceSettings{};
                sourceSettings.flags = simFlags();
                check(iplSourceCreate(simulator_, &sourceSettings, &src.handle), "iplSourceCreate");
                iplSourceAdd(src.handle, simulator_);
                iplSimulatorCommit(simulator_);
            }

            IPLDirectEffectSettings directSettings{};
            directSettings.numChannels = 1;
            check(iplDirectEffectCreate(context_, &audioSettings_, &directSettings, &src.direct),
                  "iplDirectEffectCreate");

            if (config_.enableReflections) {
                // Parametric reverb is mono-in / mono-out: it only writes channel 0.
                IPLReflectionEffectSettings reflectSettings{};
                reflectSettings.type = IPL_REFLECTIONEFFECTTYPE_PARAMETRIC;
                reflectSettings.irSize = irSize();
                reflectSettings.numChannels = 1;
                check(iplReflectionEffectCreate(context_, &audioSettings_, &reflectSettings, &src.reflection),
                      "iplReflectionEffectCreate");
            }

            IPLBinauralEffectSettings binauralSettings{};
            binauralSettings.hrtf = hrtf_;
            check(iplBinauralEffectCreate(context_, &audioSettings_, &binauralSettings, &src.binaural),
                  "iplBinauralEffectCreate");

            resizeDecorrelation(src);
        } catch (...) {
            releaseSource(src);
            sources_.pop_back();
            throw;
        }
        return static_cast<int>(sources_.size()) - 1;
    }

    void setListener(float x, float y, float z,
                     float aheadX, float aheadY, float aheadZ,
                     float upX, float upY, float upZ) {
        ensureAlive();
        listener_ = makeCoords({x, y, z}, {aheadX, aheadY, aheadZ}, {upX, upY, upZ});
    }

    void setSourcePosition(int id, float x, float y, float z) {
        ensureAlive();
        sourceAt(id).position = {x, y, z};
    }

    // Inactive sources are skipped by simulate() (no ray tracing cost) and should not be
    // processed. Call resetSource() before processing it again to avoid stale tails.
    void setSourceActive(int id, bool active) {
        ensureAlive();
        sourceAt(id).active = active;
    }

    bool isSourceActive(int id) {
        ensureAlive();
        return sourceAt(id).active;
    }

    // Clear effect history and smoothing state (e.g. after a source was muted for a while).
    void resetSource(int id) {
        ensureAlive();
        SourceState& src = sourceAt(id);
        if (src.direct) iplDirectEffectReset(src.direct);
        if (src.reflection) iplReflectionEffectReset(src.reflection);
        if (src.binaural) iplBinauralEffectReset(src.binaural);
        std::fill(src.decorrelation.begin(), src.decorrelation.end(), 0.0f);
        src.decorrelationIndex = 0;
        src.smoothInit = false;
    }

    // Run physics sims. Reflections are heavier — call less often from JS if needed.
    void simulate(bool runReflections) {
        ensureAlive();
        requireSimulation("simulate");
        commitScene();
        const bool reflections = runReflections && config_.enableReflections;

        for (SourceState& src : sources_) {
            IPLSimulationInputs inputs{};
            inputs.flags = src.active ? simFlags() : static_cast<IPLSimulationFlags>(0);
            inputs.directFlags = src.active
                ? static_cast<IPLDirectSimulationFlags>(
                      IPL_DIRECTSIMULATIONFLAGS_DISTANCEATTENUATION |
                      IPL_DIRECTSIMULATIONFLAGS_AIRABSORPTION |
                      IPL_DIRECTSIMULATIONFLAGS_OCCLUSION |
                      IPL_DIRECTSIMULATIONFLAGS_TRANSMISSION)
                : static_cast<IPLDirectSimulationFlags>(0);
            inputs.source = makeCoords(src.position, {0, 0, -1}, {0, 1, 0});
            inputs.distanceAttenuationModel.type = IPL_DISTANCEATTENUATIONTYPE_INVERSEDISTANCE;
            inputs.distanceAttenuationModel.minDistance = tuning_.minDistance;
            inputs.airAbsorptionModel.type = IPL_AIRABSORPTIONTYPE_DEFAULT;
            inputs.occlusionType = IPL_OCCLUSIONTYPE_VOLUMETRIC;
            inputs.occlusionRadius = tuning_.occlusionRadius;
            inputs.numOcclusionSamples = config_.numOcclusionSamples;
            inputs.numTransmissionRays = config_.numTransmissionRays;
            inputs.reverbScale[0] = inputs.reverbScale[1] = inputs.reverbScale[2] = 1.0f;
            iplSourceSetInputs(src.handle, simFlags(), &inputs);
        }

        IPLSimulationSharedInputs shared{};
        shared.listener = listener_;
        shared.numRays = config_.numRays;
        shared.numBounces = config_.numBounces;
        shared.duration = config_.reflectionDuration;
        shared.order = 0;
        shared.irradianceMinDistance = 1.0f;
        iplSimulatorSetSharedInputs(simulator_, simFlags(), &shared);

        iplSimulatorRunDirect(simulator_);
        if (reflections) {
            iplSimulatorRunReflections(simulator_);
        }

        for (SourceState& src : sources_) {
            if (!src.active) continue;
            IPLSimulationOutputs outputs{};
            iplSourceGetOutputs(src.handle, simFlags(), &outputs);
            src.params.distanceAttenuation = outputs.direct.distanceAttenuation;
            src.params.occlusion = outputs.direct.occlusion;
            for (int i = 0; i < 3; ++i) {
                src.params.air[i] = outputs.direct.airAbsorption[i];
                src.params.transmission[i] = outputs.direct.transmission[i];
            }
            if (reflections) {
                for (int i = 0; i < 3; ++i) src.params.reverbTimes[i] = outputs.reflections.reverbTimes[i];
            }
        }
    }

    float getOcclusion(int id) {
        ensureAlive();
        return sourceAt(id).params.occlusion;
    }

    // Packed snapshot of listener + per-source parameters (see kParamHeader / kParamStride).
    // The returned view aliases wasm memory: copy it (e.g. .slice()) before the next call.
    val exportParams() {
        ensureAlive();
        packed_.assign(kParamHeader + kParamStride * sources_.size(), 0.0f);
        float* p = packed_.data();
        p[0] = static_cast<float>(sources_.size());
        const IPLVector3 l[3] = {listener_.origin, listener_.ahead, listener_.up};
        for (int k = 0; k < 3; ++k) {
            p[1 + k * 3] = l[k].x;
            p[2 + k * 3] = l[k].y;
            p[3 + k * 3] = l[k].z;
        }
        for (size_t s = 0; s < sources_.size(); ++s) {
            const SourceState& src = sources_[s];
            float* q = p + kParamHeader + kParamStride * s;
            q[0] = src.active ? 1.0f : 0.0f;
            q[1] = src.position.x;
            q[2] = src.position.y;
            q[3] = src.position.z;
            q[4] = src.params.distanceAttenuation;
            q[5] = src.params.occlusion;
            for (int i = 0; i < 3; ++i) {
                q[6 + i] = src.params.air[i];
                q[9 + i] = src.params.transmission[i];
                q[12 + i] = src.params.reverbTimes[i];
            }
        }
        return val(typed_memory_view(packed_.size(), packed_.data()));
    }

    // Apply a snapshot produced by exportParams() on another instance. Sources are matched
    // by id; extra entries are ignored. Activity flags are not imported (the renderer owns
    // its own mute state).
    void importParams(val packed) {
        ensureAlive();
        packed_ = convertJSArrayToNumberVector<float>(packed);
        if (packed_.size() < static_cast<size_t>(kParamHeader)) {
            throw std::runtime_error("importParams: packet too short");
        }
        const float* p = packed_.data();
        const size_t n = std::min(static_cast<size_t>(std::max(p[0], 0.0f)), sources_.size());
        if (packed_.size() < kParamHeader + kParamStride * n) {
            throw std::runtime_error("importParams: packet too short for its source count");
        }
        listener_ = makeCoords({p[1], p[2], p[3]}, {p[4], p[5], p[6]}, {p[7], p[8], p[9]});
        for (size_t s = 0; s < n; ++s) {
            SourceState& src = sources_[s];
            const float* q = p + kParamHeader + kParamStride * s;
            src.position = {q[1], q[2], q[3]};
            src.params.distanceAttenuation = q[4];
            src.params.occlusion = q[5];
            for (int i = 0; i < 3; ++i) {
                src.params.air[i] = q[6 + i];
                src.params.transmission[i] = q[9 + i];
                src.params.reverbTimes[i] = q[12 + i];
            }
        }
    }

    // Mono input frame for process(). Write frameSize samples into it, then call process().
    // NOTE: views detach if wasm memory grows; re-fetch when byteLength becomes 0.
    val inputView() {
        ensureAlive();
        return val(typed_memory_view(static_cast<size_t>(config_.frameSize), monoIn_.data[0]));
    }

    // Interleaved stereo result of the last process() call (2 * frameSize floats).
    val outputView() {
        ensureAlive();
        return val(typed_memory_view(interleaved_.size(), interleaved_.data()));
    }

    // Planar result of the last process() call; channel 0 = left, 1 = right.
    val outputChannelView(int channel) {
        ensureAlive();
        if (channel < 0 || channel > 1) throw std::runtime_error("channel must be 0 or 1");
        return val(typed_memory_view(static_cast<size_t>(config_.frameSize), mixStereo_.data[channel]));
    }

    // Render the frame in inputView() for one source → outputView() / outputChannelView().
    void process(int id) {
        ensureAlive();
        SourceState& src = sourceAt(id);
        const int n = config_.frameSize;
        const float period = static_cast<float>(n) / static_cast<float>(config_.sampleRate);

        // --- Smooth simulation results per frame (raw updates zipper otherwise) ---
        if (!src.smoothInit) {
            src.smooth = src.params;
            src.smoothInit = true;
        } else {
            const float aDir = smoothingAlpha(tuning_.directSmoothing, period);
            const float aOcc = smoothingAlpha(tuning_.occlusionSmoothing, period);
            const float aRev = smoothingAlpha(tuning_.reverbSmoothing, period);
            lerpToward(src.smooth.distanceAttenuation, src.params.distanceAttenuation, aDir);
            lerpToward(src.smooth.occlusion, src.params.occlusion, aOcc);
            for (int i = 0; i < 3; ++i) {
                lerpToward(src.smooth.air[i], src.params.air[i], aDir);
                lerpToward(src.smooth.transmission[i], src.params.transmission[i], aDir);
                lerpToward(src.smooth.reverbTimes[i], src.params.reverbTimes[i], aRev);
            }
        }
        const SimParams& sp = src.smooth;

        // --- Direct path ---
        IPLDirectEffectParams directParams{};
        directParams.flags = static_cast<IPLDirectEffectFlags>(
            IPL_DIRECTEFFECTFLAGS_APPLYDISTANCEATTENUATION |
            IPL_DIRECTEFFECTFLAGS_APPLYAIRABSORPTION |
            IPL_DIRECTEFFECTFLAGS_APPLYOCCLUSION |
            IPL_DIRECTEFFECTFLAGS_APPLYTRANSMISSION);
        directParams.transmissionType = tuning_.freqIndependentTransmission
            ? IPL_TRANSMISSIONTYPE_FREQINDEPENDENT
            : IPL_TRANSMISSIONTYPE_FREQDEPENDENT;
        directParams.distanceAttenuation = std::max(sp.distanceAttenuation, tuning_.distanceFloor);
        directParams.occlusion = sp.occlusion;
        const float airFloor[3] = {tuning_.airFloorLow, tuning_.airFloorMid, tuning_.airFloorHigh};
        for (int i = 0; i < 3; ++i) {
            directParams.airAbsorption[i] = std::max(sp.air[i], airFloor[i]);
            directParams.transmission[i] = std::max(sp.transmission[i], tuning_.transmissionFloor);
        }
        iplDirectEffectApply(src.direct, &directParams, &monoIn_, &directMono_);

        IPLBinauralEffectParams binauralParams{};
        binauralParams.direction = relativeDirection(src.position);
        binauralParams.interpolation = IPL_HRTFINTERPOLATION_BILINEAR;
        binauralParams.spatialBlend = 1.0f;
        binauralParams.hrtf = hrtf_;
        binauralParams.peakDelays = nullptr;
        iplBinauralEffectApply(src.binaural, &binauralParams, &directMono_, &mixStereo_);

        // --- Reflections (parametric, mono) → both ears, decorrelated ---
        if (src.reflection) {
            float wetIn = tuning_.reflectionsGain;
            if (tuning_.reflectionsFollowDistance) {
                wetIn *= std::max(sp.distanceAttenuation, tuning_.reflectionsDistanceFloor);
            }
            const float wetOut = 1.0f + (1.0f - sp.occlusion) * tuning_.occludedWetBoost;
            const float* in = monoIn_.data[0];
            float* rin = reflectIn_.data[0];
            for (int i = 0; i < n; ++i) rin[i] = in[i] * wetIn;

            IPLReflectionEffectParams reflectParams{};
            reflectParams.type = IPL_REFLECTIONEFFECTTYPE_PARAMETRIC;
            reflectParams.numChannels = 1;
            reflectParams.irSize = irSize();
            for (int i = 0; i < 3; ++i) {
                reflectParams.reverbTimes[i] = std::max(sp.reverbTimes[i], tuning_.reverbTimeFloor);
                reflectParams.eq[i] = 1.0f;  // only used by hybrid
            }
            iplReflectionEffectApply(src.reflection, &reflectParams, &reflectIn_, &reflectOut_, nullptr);

            const float* wet = reflectOut_.data[0];
            float* L = mixStereo_.data[0];
            float* R = mixStereo_.data[1];
            std::vector<float>& ring = src.decorrelation;
            if (ring.empty()) {
                for (int i = 0; i < n; ++i) {
                    L[i] += wet[i] * wetOut;
                    R[i] += wet[i] * wetOut;
                }
            } else {
                size_t idx = src.decorrelationIndex;
                const size_t len = ring.size();
                for (int i = 0; i < n; ++i) {
                    const float delayed = ring[idx];
                    ring[idx] = wet[i];
                    idx = (idx + 1 == len) ? 0 : idx + 1;
                    L[i] += wet[i] * wetOut;
                    R[i] += delayed * wetOut;
                }
                src.decorrelationIndex = idx;
            }
        }

        iplAudioBufferInterleave(context_, &mixStereo_, interleaved_.data());
    }

    void destroy() {
        if (!context_) {
            return;
        }
        for (SourceState& src : sources_) {
            releaseSource(src);
        }
        sources_.clear();
        if (simulator_) {
            iplSimulatorCommit(simulator_);
        }

        for (IPLAudioBuffer* b : {&monoIn_, &directMono_, &reflectIn_, &reflectOut_, &mixStereo_}) {
            if (b->data) {
                iplAudioBufferFree(context_, b);
                *b = {};
            }
        }

        for (IPLStaticMesh& m : meshes_) {
            if (m) {
                iplStaticMeshRemove(m, scene_);
                iplStaticMeshRelease(&m);
            }
        }
        meshes_.clear();
        if (simulator_) iplSimulatorRelease(&simulator_);
        if (scene_) iplSceneRelease(&scene_);
        if (hrtf_) iplHRTFRelease(&hrtf_);
        iplContextRelease(&context_);
        simulator_ = nullptr;
        scene_ = nullptr;
        hrtf_ = nullptr;
        context_ = nullptr;
    }

    bool isDestroyed() const { return context_ == nullptr; }

private:
    void init() {
        IPLContextSettings contextSettings{};
        contextSettings.version = STEAMAUDIO_VERSION;
        check(iplContextCreate(&contextSettings, &context_), "iplContextCreate");

        audioSettings_ = {config_.sampleRate, config_.frameSize};

        IPLHRTFSettings hrtfSettings{};
        hrtfSettings.type = IPL_HRTFTYPE_DEFAULT;
        hrtfSettings.volume = 1.0f;
        check(iplHRTFCreate(context_, &audioSettings_, &hrtfSettings, &hrtf_), "iplHRTFCreate");

        if (config_.enableSimulation) {
            IPLSceneSettings sceneSettings{};
            sceneSettings.type = IPL_SCENETYPE_DEFAULT;
            check(iplSceneCreate(context_, &sceneSettings, &scene_), "iplSceneCreate");

            IPLSimulationSettings simSettings{};
            simSettings.flags = simFlags();
            simSettings.sceneType = IPL_SCENETYPE_DEFAULT;
            // Parametric reverb: much cheaper than convolution on WASM, and only needs RT60s,
            // so order 0 (mono energy field) is sufficient.
            simSettings.reflectionType = IPL_REFLECTIONEFFECTTYPE_PARAMETRIC;
            simSettings.maxNumOcclusionSamples = config_.numOcclusionSamples;
            simSettings.maxNumRays = config_.numRays;
            simSettings.numDiffuseSamples = config_.numDiffuseSamples;
            simSettings.maxDuration = config_.reflectionDuration;
            simSettings.maxOrder = 0;
            simSettings.maxNumSources = config_.maxSources;
            simSettings.numThreads = 1;  // no pthreads; see patches/steam-audio-wasm-sync-threadpool.patch
            simSettings.samplingRate = config_.sampleRate;
            simSettings.frameSize = config_.frameSize;
            check(iplSimulatorCreate(context_, &simSettings, &simulator_), "iplSimulatorCreate");

            iplSimulatorSetScene(simulator_, scene_);
            iplSimulatorCommit(simulator_);
        }

        const int n = config_.frameSize;
        check(iplAudioBufferAllocate(context_, 1, n, &monoIn_), "alloc monoIn");
        check(iplAudioBufferAllocate(context_, 1, n, &directMono_), "alloc directMono");
        check(iplAudioBufferAllocate(context_, 1, n, &reflectIn_), "alloc reflectIn");
        check(iplAudioBufferAllocate(context_, 1, n, &reflectOut_), "alloc reflectOut");
        check(iplAudioBufferAllocate(context_, 2, n, &mixStereo_), "alloc mixStereo");
        std::memset(monoIn_.data[0], 0, sizeof(float) * n);
        interleaved_.assign(static_cast<size_t>(2 * n), 0.0f);

        listener_ = makeCoords({0, 1.6f, 0}, {0, 0, -1}, {0, 1, 0});
    }

    IPLSimulationFlags simFlags() const {
        return static_cast<IPLSimulationFlags>(
            IPL_SIMULATIONFLAGS_DIRECT | (config_.enableReflections ? IPL_SIMULATIONFLAGS_REFLECTIONS : 0));
    }

    IPLint32 irSize() const {
        return static_cast<IPLint32>(std::ceil(config_.reflectionDuration * config_.sampleRate));
    }

    IPLVector3 relativeDirection(const IPLVector3& position) const {
        const IPLVector3 d{position.x - listener_.origin.x, position.y - listener_.origin.y,
                           position.z - listener_.origin.z};
        if (!(length(d) > 1e-4f)) {
            return {0, 0, -1};  // source at the listener: avoid a NaN direction
        }
        IPLVector3 dir = iplCalculateRelativeDirection(context_, position, listener_.origin,
                                                       listener_.ahead, listener_.up);
        if (!normalize(dir)) dir = {0, 0, -1};
        return dir;
    }

    void resizeDecorrelation(SourceState& src) {
        const auto len = static_cast<size_t>(
            std::max(0.0f, tuning_.reverbDecorrelationMs) * 1e-3f * config_.sampleRate);
        if (len != src.decorrelation.size()) {
            src.decorrelation.assign(len, 0.0f);
            src.decorrelationIndex = 0;
        }
    }

    void releaseSource(SourceState& src) {
        if (src.binaural) iplBinauralEffectRelease(&src.binaural);
        if (src.reflection) iplReflectionEffectRelease(&src.reflection);
        if (src.direct) iplDirectEffectRelease(&src.direct);
        if (src.handle) {
            iplSourceRemove(src.handle, simulator_);
            iplSourceRelease(&src.handle);
        }
    }

    void ensureAlive() const {
        if (!context_) {
            throw std::runtime_error("SteamAudioWorld has been destroyed");
        }
    }

    void requireSimulation(const char* what) const {
        if (!simulator_) {
            throw std::runtime_error(std::string(what) + ": simulation is disabled for this world");
        }
    }

    SourceState& sourceAt(int id) {
        if (id < 0 || id >= static_cast<int>(sources_.size())) {
            throw std::runtime_error("invalid source id " + std::to_string(id));
        }
        return sources_[static_cast<size_t>(id)];
    }

    WorldConfig config_;
    Tuning tuning_;
    bool sceneDirty_ = false;
    IPLContext context_ = nullptr;
    IPLHRTF hrtf_ = nullptr;
    IPLScene scene_ = nullptr;
    IPLSimulator simulator_ = nullptr;
    IPLAudioSettings audioSettings_{};
    IPLCoordinateSpace3 listener_{};
    IPLAudioBuffer monoIn_{};
    IPLAudioBuffer directMono_{};
    IPLAudioBuffer reflectIn_{};
    IPLAudioBuffer reflectOut_{};
    IPLAudioBuffer mixStereo_{};
    std::vector<float> interleaved_;
    std::vector<float> packed_;
    std::vector<IPLStaticMesh> meshes_;
    std::vector<SourceState> sources_;  // deque-like growth is fine: SourceState holds only handles
};

EMSCRIPTEN_BINDINGS(steam_audio) {
    constant("PARAM_HEADER", kParamHeader);
    constant("PARAM_STRIDE", kParamStride);

    value_object<WorldConfig>("WorldConfig")
        .field("sampleRate", &WorldConfig::sampleRate)
        .field("frameSize", &WorldConfig::frameSize)
        .field("maxSources", &WorldConfig::maxSources)
        .field("enableSimulation", &WorldConfig::enableSimulation)
        .field("enableReflections", &WorldConfig::enableReflections)
        .field("reflectionDuration", &WorldConfig::reflectionDuration)
        .field("numRays", &WorldConfig::numRays)
        .field("numBounces", &WorldConfig::numBounces)
        .field("numDiffuseSamples", &WorldConfig::numDiffuseSamples)
        .field("numOcclusionSamples", &WorldConfig::numOcclusionSamples)
        .field("numTransmissionRays", &WorldConfig::numTransmissionRays);

    value_object<Tuning>("Tuning")
        .field("minDistance", &Tuning::minDistance)
        .field("occlusionRadius", &Tuning::occlusionRadius)
        .field("distanceFloor", &Tuning::distanceFloor)
        .field("airFloorLow", &Tuning::airFloorLow)
        .field("airFloorMid", &Tuning::airFloorMid)
        .field("airFloorHigh", &Tuning::airFloorHigh)
        .field("transmissionFloor", &Tuning::transmissionFloor)
        .field("freqIndependentTransmission", &Tuning::freqIndependentTransmission)
        .field("reflectionsGain", &Tuning::reflectionsGain)
        .field("reflectionsFollowDistance", &Tuning::reflectionsFollowDistance)
        .field("reflectionsDistanceFloor", &Tuning::reflectionsDistanceFloor)
        .field("occludedWetBoost", &Tuning::occludedWetBoost)
        .field("reverbTimeFloor", &Tuning::reverbTimeFloor)
        .field("reverbDecorrelationMs", &Tuning::reverbDecorrelationMs)
        .field("directSmoothing", &Tuning::directSmoothing)
        .field("occlusionSmoothing", &Tuning::occlusionSmoothing)
        .field("reverbSmoothing", &Tuning::reverbSmoothing);

    function("defaultWorldConfig", +[]() { return WorldConfig{}; });
    function("defaultTuning", +[]() { return Tuning{}; });

    class_<SteamAudioWorld>("SteamAudioWorld")
        .constructor<const WorldConfig&>()
        .function("sampleRate", &SteamAudioWorld::sampleRate)
        .function("frameSize", &SteamAudioWorld::frameSize)
        .function("maxSources", &SteamAudioWorld::maxSources)
        .function("numSources", &SteamAudioWorld::numSources)
        .function("simulationEnabled", &SteamAudioWorld::simulationEnabled)
        .function("version", &SteamAudioWorld::version)
        .function("getTuning", &SteamAudioWorld::getTuning)
        .function("setTuning", &SteamAudioWorld::setTuning)
        .function("addBox", &SteamAudioWorld::addBox)
        .function("commitScene", &SteamAudioWorld::commitScene)
        .function("addSource", &SteamAudioWorld::addSource)
        .function("setListener", &SteamAudioWorld::setListener)
        .function("setSourcePosition", &SteamAudioWorld::setSourcePosition)
        .function("setSourceActive", &SteamAudioWorld::setSourceActive)
        .function("isSourceActive", &SteamAudioWorld::isSourceActive)
        .function("resetSource", &SteamAudioWorld::resetSource)
        .function("simulate", &SteamAudioWorld::simulate)
        .function("getOcclusion", &SteamAudioWorld::getOcclusion)
        .function("exportParams", &SteamAudioWorld::exportParams)
        .function("importParams", &SteamAudioWorld::importParams)
        .function("inputView", &SteamAudioWorld::inputView)
        .function("outputView", &SteamAudioWorld::outputView)
        .function("outputChannelView", &SteamAudioWorld::outputChannelView)
        .function("process", &SteamAudioWorld::process)
        .function("destroy", &SteamAudioWorld::destroy)
        .function("isDestroyed", &SteamAudioWorld::isDestroyed);
}
