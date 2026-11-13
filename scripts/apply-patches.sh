#!/usr/bin/env bash
# Apply local patches to vendor/steam-audio (and its downloaded deps) idempotently.
#
# Each patch is either: already applied (reverse dry-run succeeds) → skipped,
# cleanly applicable (forward dry-run succeeds) → applied, or neither → hard error.
# This avoids `patch -N ... || true`, which silently leaves .rej files behind and
# hides real conflicts after an upstream bump.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/steam-audio"
PATCHES="$ROOT/patches"

apply_patch() {
  local dir="$1" file="$2" name
  name="$(basename "$file")"
  if patch -p1 -R -s -f --dry-run -d "$dir" < "$file" >/dev/null 2>&1; then
    return 0  # already applied
  fi
  if patch -p1 -s -f --dry-run -d "$dir" < "$file" >/dev/null 2>&1; then
    echo "==> Applying $name"
    patch -p1 -s -f --no-backup-if-mismatch -d "$dir" < "$file"
    return 0
  fi
  echo "error: $name neither applies nor is already applied in $dir" >&2
  echo "       (upstream changed? refresh the patch)" >&2
  return 1
}

if [[ ! -f "$VENDOR/core/CMakeLists.txt" ]]; then
  echo "error: $VENDOR is missing (run: nix develop)" >&2
  exit 1
fi

# Patches against the Steam Audio tree.
apply_patch "$VENDOR" "$PATCHES/steam-audio-flatbuffers-linux-warnings.patch"
apply_patch "$VENDOR" "$PATCHES/steam-audio-wasm-sync-threadpool.patch"

# Patches against dependencies fetched by get_dependencies.py (only once present).
FB_DIR="$VENDOR/core/deps/flatbuffers"
if [[ -f "$FB_DIR/include/flatbuffers/flatbuffers.h" ]]; then
  apply_patch "$FB_DIR" "$PATCHES/flatbuffers-1.12-deleted-assign.patch"
fi
