{
  description = "Steam Audio SDK 4.8.1 WebAssembly build + JS bindings";

  inputs = {
    # Current unstable for emscripten / node / etc.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # CMake 4.x rejects cmake_minimum_required < 3.5 used by Steam Audio's
    # pinned flatbuffers/zlib/pffft. Pin CMake 3.31.7 for dep + SDK builds.
    nixpkgs-cmake3.url = "github:NixOS/nixpkgs/f4b140d5b253f5e2a1ff4e5506edbf8267724bde";
    # Steam Audio source, locked to an exact commit in flake.lock (tags can move).
    steam-audio = {
      url = "github:ValveSoftware/steam-audio/v4.8.1";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, nixpkgs-cmake3, steam-audio }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        pkgs = import nixpkgs { inherit system; };
        pkgsCmake3 = import nixpkgs-cmake3 { inherit system; };
      });
      steamAudioTag = "v4.8.1";
    in {
      devShells = forAllSystems ({ pkgs, pkgsCmake3 }: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            emscripten
            pkgsCmake3.cmake
            ninja
            python3
            git
            gnumake
            gnupatch
            nodejs_22
          ];

          shellHook = ''
            ROOT="$(pwd)"

            # --- vendor/steam-audio: writable copy of the locked flake input ---
            # The build writes into the source tree (deps/, build/, bin/), so it can't
            # run from the read-only store path directly.
            VENDOR="$ROOT/vendor/steam-audio"
            SRC="${steam-audio}"
            STAMP="$VENDOR/.flake-source"
            if [[ ! -f "$VENDOR/core/CMakeLists.txt" ]]; then
              echo "==> Copying Steam Audio ${steamAudioTag} (${steam-audio.shortRev}) into vendor/steam-audio"
              mkdir -p "$VENDOR"
              cp -R "$SRC/." "$VENDOR/"
              chmod -R u+w "$VENDOR"
              echo "$SRC" > "$STAMP"
            elif [[ "$(cat "$STAMP" 2>/dev/null)" == "$SRC" ]]; then
              :
            elif [[ ! -f "$STAMP" && "$(git -C "$VENDOR" rev-parse HEAD 2>/dev/null)" == "${steam-audio.rev}" ]]; then
              # Pre-existing git clone of the same commit: adopt it.
              echo "$SRC" > "$STAMP"
            else
              echo "warning: vendor/steam-audio does not match the locked ${steamAudioTag} (${steam-audio.shortRev})." >&2
              echo "         Not touching it. To refresh: rm -rf vendor/steam-audio && exit, then re-enter nix develop" >&2
            fi
            if [[ -f "$VENDOR/core/CMakeLists.txt" ]]; then
              "$ROOT/scripts/apply-patches.sh" || echo "warning: patches failed to apply (see above)" >&2
            fi

            # Valve's get_dependencies.py expects an EMSDK layout; scripts/build-sdk.sh
            # creates the same shim, this just makes $EMSDK usable interactively.
            EMSCRIPTEN_ROOT="$(dirname "$(dirname "$(readlink -f "$(command -v emcc)")")")/share/emscripten"
            SHIM="$ROOT/tools/emsdk-shim"
            mkdir -p "$SHIM/upstream"
            ln -sfn "$EMSCRIPTEN_ROOT" "$SHIM/upstream/emscripten"
            export EMSDK="$SHIM"
            export EM_CACHE="''${EM_CACHE:-$ROOT/.emscripten_cache}"
            mkdir -p "$EM_CACHE"
            echo "Steam Audio WASM shell ready (emcc $(emcc --version | head -1))"
            echo "  cmake $(cmake --version | head -1)"
            echo "  EMSDK=$EMSDK"
            echo "  vendor=$VENDOR (${steamAudioTag} @ ${steam-audio.shortRev})"
          '';
        };
      });
    };
}
