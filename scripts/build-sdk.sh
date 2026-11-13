#!/usr/bin/env bash
# Build Steam Audio core (libphonon.a) for WebAssembly with Emscripten.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/vendor/steam-audio/core"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
# Must match the exception mode used by bindings/CMakeLists.txt.
EXCEPTION_FLAGS="${EXCEPTION_FLAGS:--fwasm-exceptions}"

if ! command -v emcc >/dev/null || ! command -v emcmake >/dev/null; then
  echo "error: emcc/emcmake not on PATH. Enter the nix flake shell first:" >&2
  echo "  nix develop" >&2
  exit 1
fi

# Steam Audio's API layer catches its internal C++ exceptions and turns them into
# IPLerror codes. Upstream builds wasm *without* exception support, which makes
# every internal `throw` an abort() of the whole module. Enable native Wasm EH.

# Shim EMSDK layout for Valve scripts that expect:
#   $EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake
EMSCRIPTEN_ROOT="$(dirname "$(dirname "$(readlink -f "$(command -v emcc)")")")/share/emscripten"
SHIM="$ROOT/tools/emsdk-shim"
mkdir -p "$SHIM/upstream"
ln -sfn "$EMSCRIPTEN_ROOT" "$SHIM/upstream/emscripten"
export EMSDK="$SHIM"
export EM_CACHE="${EM_CACHE:-$ROOT/.emscripten_cache}"
mkdir -p "$EM_CACHE"

TOOLCHAIN="$EMSCRIPTEN_ROOT/cmake/Modules/Platform/Emscripten.cmake"
if [[ ! -f "$TOOLCHAIN" ]]; then
  echo "error: Emscripten.cmake not found at $TOOLCHAIN" >&2
  exit 1
fi

echo "==> Fetching / building WASM dependencies (flatbuffers host tool + pffft/zlib/mysofa)"
if [[ ! -f "$CORE/build/dependencies.json" ]]; then
  echo "error: missing $CORE/build/dependencies.json (is vendor/steam-audio checked out?)" >&2
  exit 1
fi
# Patch dependencies.json etc. before fetching (idempotent; fails loudly on conflicts)
"$ROOT/scripts/apply-patches.sh"

# get_dependencies.py must be started from core/build/ — it immediately chdirs to ..
cd "$CORE/build"
python3 get_dependencies.py --platform wasm --emsdk "$EMSDK"

# Re-run for patches against freshly downloaded deps (FlatBuffers 1.12 deleted
# assignment operator vs modern Clang).
"$ROOT/scripts/apply-patches.sh"

BUILD_DIR="$CORE/build/wasm-release"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

echo "==> Configuring Steam Audio with emcmake"
emcmake cmake ../.. \
  -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  "-DCMAKE_CXX_FLAGS=$EXCEPTION_FLAGS" \
  -DBUILD_SHARED_LIBS=FALSE \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH \
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
  -DEMSCRIPTEN_SYSTEM_PROCESSOR=arm \
  -DCMAKE_INSTALL_PREFIX="$CORE/bin" \
  -DSTEAMAUDIO_BUILD_TESTS=FALSE \
  -DSTEAMAUDIO_BUILD_ITESTS=FALSE \
  -DSTEAMAUDIO_BUILD_BENCHMARKS=FALSE \
  -DSTEAMAUDIO_BUILD_SAMPLES=FALSE \
  -DSTEAMAUDIO_BUILD_DOCS=FALSE \
  -DSTEAMAUDIO_ENABLE_IPP=FALSE \
  -DSTEAMAUDIO_ENABLE_EMBREE=FALSE \
  -DSTEAMAUDIO_ENABLE_RADEONRAYS=FALSE \
  -DSTEAMAUDIO_ENABLE_TRUEAUDIONEXT=FALSE

echo "==> Building phonon"
cmake --build . --parallel "$JOBS" --target phonon

echo "==> Installing headers + lib into core/bin"
cmake --install .

echo "==> SDK artifacts:"
find "$CORE/bin" -type f \( -name '*.a' -o -name '*.h' -o -name '*.js' -o -name '*.wasm' \) 2>/dev/null | sort || true
ls -la "$BUILD_DIR/src/core/"*.a 2>/dev/null || ls -la "$BUILD_DIR"/src/core/libphonon* 2>/dev/null || true

echo "Steam Audio WASM SDK build complete."
