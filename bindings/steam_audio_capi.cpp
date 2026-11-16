// Plain C ABI over SteamAudioWorld, for hosts that load the .wasm without the Emscripten JS glue
// (Garry's Mod: dreamwork std.WASM inside Chromium 86). Built by scripts/build-gmod.sh.
//
// Every function takes the world pointer returned by sa_create. Failures return -1 (NaN for
// sa_get_occlusion) and leave a message in sa_last_error() / sa_last_error_length(), but only
// when exceptions are enabled: the GMod build has no Wasm exception support (Chromium 86), so
// there a failed call traps (RuntimeError: unreachable) instead.
#define STEAMAUDIO_CAPI 1
#include "steam_audio_bind.cpp"

#include <emscripten/emscripten.h>

namespace {

std::string gLastError;

}  // namespace

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS)
#define SA_GUARD(failure, ...)                                   \
    try {                                                        \
        __VA_ARGS__                                              \
    } catch (const std::exception& e) {                          \
        gLastError = e.what();                                   \
        return failure;                                          \
    } catch (...) {                                              \
        gLastError = "unknown error";                            \
        return failure;                                          \
    }
#else
#define SA_GUARD(failure, ...) __VA_ARGS__
#endif

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* sa_last_error() { return gLastError.c_str(); }
EMSCRIPTEN_KEEPALIVE int sa_last_error_length() { return static_cast<int>(gLastError.size()); }

// Returns nullptr on failure.
EMSCRIPTEN_KEEPALIVE SteamAudioWorld* sa_create(int sampleRate, int frameSize, int maxSources,
                                                int enableSimulation, int enableReflections) {
    SA_GUARD(nullptr, {
        WorldConfig config;
        config.sampleRate = sampleRate;
        config.frameSize = frameSize;
        config.maxSources = maxSources;
        config.enableSimulation = enableSimulation != 0;
        config.enableReflections = enableReflections != 0;
        return new SteamAudioWorld(config);
    })
}

EMSCRIPTEN_KEEPALIVE void sa_free(SteamAudioWorld* world) { delete world; }

EMSCRIPTEN_KEEPALIVE int sa_add_box(SteamAudioWorld* world,
                                    float minX, float minY, float minZ, float maxX, float maxY, float maxZ,
                                    float absL, float absM, float absH, float scatter,
                                    float txL, float txM, float txH, int inward) {
    SA_GUARD(-1, {
        world->addBox(minX, minY, minZ, maxX, maxY, maxZ, absL, absM, absH, scatter, txL, txM, txH, inward != 0);
        return 0;
    })
}

// vertices: numVertices xyz float triples, triangles: numTriangles int index triples,
// materialIndices: one int per triangle, materials: numMaterials × 7 floats
// (absorption low/mid/high, scattering, transmission low/mid/high). Copied, may be freed after.
EMSCRIPTEN_KEEPALIVE int sa_add_mesh(SteamAudioWorld* world, const float* vertices, int numVertices,
                                     const int* triangles, int numTriangles, const int* materialIndices,
                                     const float* materials, int numMaterials) {
    SA_GUARD(-1, {
        world->addMesh(vertices, numVertices, triangles, numTriangles, materialIndices, materials, numMaterials);
        return 0;
    })
}

EMSCRIPTEN_KEEPALIVE int sa_commit_scene(SteamAudioWorld* world) {
    SA_GUARD(-1, {
        world->commitScene();
        return 0;
    })
}

// Returns the source id.
EMSCRIPTEN_KEEPALIVE int sa_add_source(SteamAudioWorld* world, float x, float y, float z) {
    SA_GUARD(-1, { return world->addSource(x, y, z); })
}

EMSCRIPTEN_KEEPALIVE int sa_set_listener(SteamAudioWorld* world, float x, float y, float z,
                                         float aheadX, float aheadY, float aheadZ,
                                         float upX, float upY, float upZ) {
    SA_GUARD(-1, {
        world->setListener(x, y, z, aheadX, aheadY, aheadZ, upX, upY, upZ);
        return 0;
    })
}

EMSCRIPTEN_KEEPALIVE int sa_set_source_position(SteamAudioWorld* world, int id, float x, float y, float z) {
    SA_GUARD(-1, {
        world->setSourcePosition(id, x, y, z);
        return 0;
    })
}

EMSCRIPTEN_KEEPALIVE int sa_set_source_active(SteamAudioWorld* world, int id, int active) {
    SA_GUARD(-1, {
        world->setSourceActive(id, active != 0);
        return 0;
    })
}

EMSCRIPTEN_KEEPALIVE int sa_reset_source(SteamAudioWorld* world, int id) {
    SA_GUARD(-1, {
        world->resetSource(id);
        return 0;
    })
}

EMSCRIPTEN_KEEPALIVE int sa_simulate(SteamAudioWorld* world, int runReflections) {
    SA_GUARD(-1, {
        world->simulate(runReflections != 0);
        return 0;
    })
}

EMSCRIPTEN_KEEPALIVE float sa_get_occlusion(SteamAudioWorld* world, int id) {
    SA_GUARD(NAN, { return world->getOcclusion(id); })
}

// Renders the frame at sa_input() through source `id` into sa_output().
EMSCRIPTEN_KEEPALIVE int sa_process(SteamAudioWorld* world, int id) {
    SA_GUARD(-1, {
        world->process(id);
        return 0;
    })
}

// frameSize mono floats; write the next input frame here.
EMSCRIPTEN_KEEPALIVE float* sa_input(SteamAudioWorld* world) { return world->inputData(); }

// 2 * frameSize interleaved stereo floats of the last sa_process().
EMSCRIPTEN_KEEPALIVE const float* sa_output(SteamAudioWorld* world) { return world->outputData(); }

// Tuning as a flat float array (booleans are 0 / 1), in this order:
//   0 minDistance, 1 occlusionRadius, 2 distanceFloor, 3 airFloorLow, 4 airFloorMid, 5 airFloorHigh,
//   6 transmissionFloor, 7 freqIndependentTransmission, 8 reflectionsGain, 9 reflectionsFollowDistance,
//   10 reflectionsDistanceFloor, 11 occludedWetBoost, 12 reverbTimeFloor, 13 reverbDecorrelationMs,
//   14 directSmoothing, 15 occlusionSmoothing, 16 reverbSmoothing, 17 reflectionsFollowOcclusion,
//   18 reflectionsOcclusionFloor, 19 reverbTimeMax, 20 normalizeDistance
#define SA_TUNING_FIELDS(X)                                                                         \
    X(minDistance) X(occlusionRadius) X(distanceFloor) X(airFloorLow) X(airFloorMid) X(airFloorHigh) \
    X(transmissionFloor) X(freqIndependentTransmission) X(reflectionsGain) X(reflectionsFollowDistance) \
    X(reflectionsDistanceFloor) X(occludedWetBoost) X(reverbTimeFloor) X(reverbDecorrelationMs)      \
    X(directSmoothing) X(occlusionSmoothing) X(reverbSmoothing) X(reflectionsFollowOcclusion)        \
    X(reflectionsOcclusionFloor) X(reverbTimeMax) X(normalizeDistance)

// Number of tuning values.
EMSCRIPTEN_KEEPALIVE int sa_tuning_size() {
    int n = 0;
#define SA_COUNT(field) ++n;
    SA_TUNING_FIELDS(SA_COUNT)
#undef SA_COUNT
    return n;
}

// Writes sa_tuning_size() floats to `out`.
EMSCRIPTEN_KEEPALIVE int sa_get_tuning(SteamAudioWorld* world, float* out) {
    const Tuning t = world->getTuning();
    int i = 0;
#define SA_GET(field) out[i++] = static_cast<float>(t.field);
    SA_TUNING_FIELDS(SA_GET)
#undef SA_GET
    return i;
}

#define SA_SET(field) if (i < count) { t.field = static_cast<decltype(t.field)>(values[i]); } ++i;

// Reads `count` floats (a prefix of the order above is fine, the rest keeps its value).
EMSCRIPTEN_KEEPALIVE int sa_set_tuning(SteamAudioWorld* world, const float* values, int count) {
    SA_GUARD(-1, {
        Tuning t = world->getTuning();
        int i = 0;
        SA_TUNING_FIELDS(SA_SET)
        world->setTuning(t);
        return 0;
    })
}

#undef SA_SET

EMSCRIPTEN_KEEPALIVE int sa_frame_size(SteamAudioWorld* world) { return world->frameSize(); }
EMSCRIPTEN_KEEPALIVE int sa_sample_rate(SteamAudioWorld* world) { return world->sampleRate(); }
EMSCRIPTEN_KEEPALIVE int sa_num_sources(SteamAudioWorld* world) { return world->numSources(); }

}  // extern "C"
