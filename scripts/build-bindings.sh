#!/usr/bin/env bash
# Link Embind JS module against the WASM-built Steam Audio static library.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

if ! command -v emcmake >/dev/null; then
  echo "error: emcmake not on PATH. Run: nix develop" >&2
  exit 1
fi

export EM_CACHE="${EM_CACHE:-$ROOT/.emscripten_cache}"
mkdir -p "$EM_CACHE" "$ROOT/dist" "$ROOT/build/bindings"

cd "$ROOT/build/bindings"
emcmake cmake "$ROOT/bindings" -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release \
  "-DSTEAMAUDIO_EXCEPTION_FLAGS=${EXCEPTION_FLAGS:--fwasm-exceptions}"
cmake --build . --parallel "$JOBS"

echo "==> JS module:"
ls -lh "$ROOT/dist"/steam_audio.js "$ROOT/dist"/steam_audio.wasm 2>/dev/null || ls -lh "$ROOT/dist"/
