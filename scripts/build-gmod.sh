#!/usr/bin/env bash
# Garry's Mod build: plain C ABI module (bindings/steam_audio_capi.cpp) for Chromium 86.
#
# GMod's embedded Chromium 86 has no Wasm SIMD128 (Chrome 91), no native Wasm exceptions
# (Chrome 95) and no reference types (Chrome 96). Everything is rebuilt for the MVP feature
# set + sign-ext / non-trapping float-to-int / bulk memory / mutable globals:
#   * Steam Audio with the scalar float4 (patches/steam-audio-wasm-scalar-float4.patch)
#   * pffft, zlib and mysofa without -msimd128 (the get_dependencies.py builds use it)
# There are no C++ exceptions: an internal Steam Audio error traps the module.
#
# Needs the dependency sources fetched by scripts/build-sdk.sh (fetched here when missing).
# Output: dist/gmod/steam_audio_gmod.wasm (standalone, WASI-style imports only).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/vendor/steam-audio/core"
OUT="$ROOT/build/gmod"
DIST="$ROOT/dist/gmod"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
FEATURES="-mcpu=mvp -msign-ext -mnontrapping-fptoint -mbulk-memory -mmutable-globals"

if ! command -v emcc >/dev/null || ! command -v emcmake >/dev/null; then
  echo "error: emcc/emcmake not on PATH. Run: nix develop" >&2
  exit 1
fi

EMSCRIPTEN_ROOT="$(dirname "$(dirname "$(readlink -f "$(command -v emcc)")")")/share/emscripten"
SHIM="$ROOT/tools/emsdk-shim"
mkdir -p "$SHIM/upstream"
ln -sfn "$EMSCRIPTEN_ROOT" "$SHIM/upstream/emscripten"
export EMSDK="$SHIM"
export EM_CACHE="${EM_CACHE:-$ROOT/.emscripten_cache}"
mkdir -p "$EM_CACHE" "$OUT" "$DIST"

"$ROOT/scripts/apply-patches.sh"

ZLIB_SRC="$CORE/deps-build/zlib/src/zlib"
MYSOFA_SRC="$CORE/deps-build/mysofa/src/mysofa/src"
PFFFT_SRC="$CORE/deps-build/pffft/src/pffft"
if [[ ! -f "$ZLIB_SRC/zlib.h" || ! -f "$MYSOFA_SRC/hrtf/mysofa.h" || ! -f "$PFFFT_SRC/pffft.c" \
      || ! -f "$CORE/deps-build/mysofa/build/wasm/src/config.h" ]]; then
  echo "==> Fetching dependency sources (get_dependencies.py)"
  (cd "$CORE/build" && python3 get_dependencies.py --platform wasm --emsdk "$EMSDK")
  "$ROOT/scripts/apply-patches.sh"
fi

# compile <out.o> <flags...> <source.c>
compile() {
  local out="$1"; shift
  emcc -O3 -DNDEBUG $FEATURES "$@" -c -o "$out"
}

echo "==> pffft / zlib / mysofa (no SIMD)"
rm -rf "$OUT/obj"
mkdir -p "$OUT/obj/pffft" "$OUT/obj/zlib" "$OUT/obj/mysofa"

for f in pffft pffft_common; do
  compile "$OUT/obj/pffft/$f.o" -DPFFFT_SIMD_DISABLE "$PFFFT_SRC/$f.c" &
done
for f in adler32 compress crc32 deflate gzclose gzlib gzread gzwrite inflate infback inftrees inffast trees uncompr zutil; do
  compile "$OUT/obj/zlib/$f.o" -D_LARGEFILE64_SOURCE=1 -I"$CORE/deps-build/zlib/build/wasm" -I"$ZLIB_SRC" "$ZLIB_SRC/$f.c" &
done
for f in hrtf/reader hdf/superblock hdf/dataobject hdf/btree hdf/fractalhead hdf/gunzip hdf/gcol hrtf/check \
         hrtf/spherical hrtf/lookup hrtf/tools hrtf/kdtree hrtf/neighbors hrtf/interpolate hrtf/resample \
         hrtf/loudness hrtf/minphase hrtf/easy hrtf/cache resampler/speex_resampler; do
  compile "$OUT/obj/mysofa/$(basename "$f").o" -std=gnu99 -D__linux__ \
    -I"$CORE/deps-build/mysofa/build/wasm/src" -I"$CORE/deps/zlib/include" -I"$MYSOFA_SRC/hrtf" "$MYSOFA_SRC/$f.c" &
done
wait

for lib in pffft zlib mysofa; do
  rm -f "$OUT/lib$lib.a"
  emar rcs "$OUT/lib$lib.a" "$OUT/obj/$lib"/*.o
done

echo "==> Steam Audio (scalar float4)"
mkdir -p "$CORE/build/wasm-gmod"
cd "$CORE/build/wasm-gmod"
emcmake cmake ../.. \
  -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  "-DCMAKE_C_FLAGS=$FEATURES" \
  "-DCMAKE_CXX_FLAGS=$FEATURES -DIPL_SCALAR_FLOAT4" \
  -DSTEAMAUDIO_WASM_SCALAR=TRUE \
  -DBUILD_SHARED_LIBS=FALSE \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH \
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
  -DEMSCRIPTEN_SYSTEM_PROCESSOR=arm \
  -DCMAKE_INSTALL_PREFIX="$OUT/sdk" \
  -DSTEAMAUDIO_BUILD_TESTS=FALSE \
  -DSTEAMAUDIO_BUILD_ITESTS=FALSE \
  -DSTEAMAUDIO_BUILD_BENCHMARKS=FALSE \
  -DSTEAMAUDIO_BUILD_SAMPLES=FALSE \
  -DSTEAMAUDIO_BUILD_DOCS=FALSE \
  -DSTEAMAUDIO_ENABLE_IPP=FALSE \
  -DSTEAMAUDIO_ENABLE_EMBREE=FALSE \
  -DSTEAMAUDIO_ENABLE_RADEONRAYS=FALSE \
  -DSTEAMAUDIO_ENABLE_TRUEAUDIONEXT=FALSE
cmake --build . --parallel "$JOBS" --target phonon
cmake --install .

echo "==> Linking dist/gmod/steam_audio_gmod.wasm"
em++ -O3 -std=c++17 $FEATURES -DIPL_SCALAR_FLOAT4 \
  -I"$CORE/src/core" -I"$OUT/sdk/include" -I"$CORE/build/wasm-gmod/src/core" \
  "$ROOT/bindings/steam_audio_capi.cpp" \
  "$OUT/sdk/lib/wasm/libphonon.a" "$OUT/libpffft.a" "$OUT/libmysofa.a" "$OUT/libzlib.a" \
  -sSTANDALONE_WASM=1 --no-entry \
  -sMIN_CHROME_VERSION=86 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -o "$DIST/steam_audio_gmod.wasm"

echo "==> Checking for post-Chromium-86 features"
if command -v wasm-objdump >/dev/null; then
  simd="$(wasm-objdump -d "$DIST/steam_audio_gmod.wasm" | grep -cE '\b(v128|[if](8|16|32|64)x[0-9]+)\.' || true)"
  eh="$(wasm-objdump -h "$DIST/steam_audio_gmod.wasm" | grep -c ' Tag ' || true)"
  if [[ "$simd" != 0 || "$eh" != 0 ]]; then
    echo "error: module uses SIMD ($simd instructions) or exception tags ($eh sections)" >&2
    exit 1
  fi
  echo "ok: no SIMD instructions, no exception tags"
else
  echo "warning: wasm-objdump (wabt) not found, skipping feature check" >&2
fi

ls -lh "$DIST/steam_audio_gmod.wasm"
