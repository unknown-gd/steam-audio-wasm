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

EMSCRIPTEN_KEEPALIVE int sa_frame_size(SteamAudioWorld* world) { return world->frameSize(); }
EMSCRIPTEN_KEEPALIVE int sa_sample_rate(SteamAudioWorld* world) { return world->sampleRate(); }
EMSCRIPTEN_KEEPALIVE int sa_num_sources(SteamAudioWorld* world) { return world->numSources(); }

}  // extern "C"
