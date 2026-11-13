cmake_minimum_required(VERSION 3.17)
project(steam_audio_js LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if (NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
    message(FATAL_ERROR "Configure with emcmake (Emscripten toolchain required).")
endif()

set(STEAMAUDIO_CORE_ROOT "${CMAKE_SOURCE_DIR}/../vendor/steam-audio/core" CACHE PATH "Steam Audio core root")
set(STEAMAUDIO_INCLUDE_DIR "${STEAMAUDIO_CORE_ROOT}/src/core")
set(STEAMAUDIO_BIN_DIR "${STEAMAUDIO_CORE_ROOT}/bin")

# Absolute paths — Emscripten's toolchain sets FIND_ROOT_PATH_MODE_LIBRARY=ONLY,
# which hides host-tree deps unless we bypass find_library entirely.
set(PHONON_LIB "${STEAMAUDIO_BIN_DIR}/lib/wasm/libphonon.a")
if (NOT EXISTS "${PHONON_LIB}")
    set(PHONON_LIB "${STEAMAUDIO_CORE_ROOT}/build/wasm-release/src/core/libphonon.a")
endif()
set(PFFFT_LIB "${STEAMAUDIO_CORE_ROOT}/deps/pffft/lib/wasm/release/libpffft.a")
set(MYSOFA_LIB "${STEAMAUDIO_CORE_ROOT}/deps/mysofa/lib/wasm/release/libmysofa.a")
set(ZLIB_LIB "${STEAMAUDIO_CORE_ROOT}/deps/zlib/lib/wasm/release/libz.a")

foreach(_lib PHONON_LIB PFFFT_LIB MYSOFA_LIB ZLIB_LIB)
    if (NOT EXISTS "${${_lib}}")
        message(FATAL_ERROR "Missing ${_lib}: ${${_lib}} (run ./scripts/build-sdk.sh first)")
    endif()
endforeach()

# Generated phonon_version.h lives in the SDK build tree.
set(PHONON_VERSION_INCLUDE "${STEAMAUDIO_CORE_ROOT}/build/wasm-release/src/core")
if (EXISTS "${STEAMAUDIO_BIN_DIR}/include/phonon_version.h")
    set(PHONON_VERSION_INCLUDE "${STEAMAUDIO_BIN_DIR}/include")
endif()

add_executable(steam_audio steam_audio_bind.cpp)
target_include_directories(steam_audio PRIVATE
    "${STEAMAUDIO_INCLUDE_DIR}"
    "${PHONON_VERSION_INCLUDE}"
)

# Exception mode must match libphonon.a (see scripts/build-sdk.sh). Native Wasm EH is
# zero-cost on the non-throwing path, which matters on the audio thread.
set(STEAMAUDIO_EXCEPTION_FLAGS "-fwasm-exceptions" CACHE STRING "Exception flags (must match libphonon.a)")

target_compile_options(steam_audio PRIVATE -msimd128 ${STEAMAUDIO_EXCEPTION_FLAGS})
target_link_libraries(steam_audio PRIVATE
    "${PHONON_LIB}"
    "${PFFFT_LIB}"
    "${MYSOFA_LIB}"
    "${ZLIB_LIB}"
)

target_link_options(steam_audio PRIVATE
    "SHELL:-sALLOW_MEMORY_GROWTH=1"
    "SHELL:-sMODULARIZE=1"
    "SHELL:-sEXPORT_ES6=1"
    "SHELL:-sEXPORT_NAME=createSteamAudioModule"
    # 'shell' covers AudioWorkletGlobalScope (no window/WorkerGlobalScope); the wasm binary
    # is then supplied via instantiateWasm, see js/steam-audio.js.
    "SHELL:-sENVIRONMENT=web,webview,worker,node,shell"
    "SHELL:-sFILESYSTEM=0"
    # Lets JS turn a thrown C++ exception into a readable Error (getExceptionMessage).
    "SHELL:-sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount"
    ${STEAMAUDIO_EXCEPTION_FLAGS}
    -lembind
    -O3
)

set_target_properties(steam_audio PROPERTIES
    OUTPUT_NAME "steam_audio"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../dist"
    SUFFIX ".js"
)

install(FILES
    "${CMAKE_SOURCE_DIR}/../dist/steam_audio.js"
    "${CMAKE_SOURCE_DIR}/../dist/steam_audio.wasm"
    DESTINATION .
    OPTIONAL
)
