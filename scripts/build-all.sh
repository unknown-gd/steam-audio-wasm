#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/build-sdk.sh"
"$ROOT/scripts/build-bindings.sh"
echo "All done. Artifacts in dist/ and vendor/steam-audio/core/bin/lib/wasm/"
