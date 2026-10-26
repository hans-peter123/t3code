#!/usr/bin/env bash
# Baut die Desktop-App des Forks auf einem TeamCity-Agenten (teamcity.muntean.cloud, Projekt T3Code).
#
#   fork/ci-desktop.sh win    # Windows x64 (NSIS), cross-gebaut auf Linux wie upstream
#   fork/ci-desktop.sh linux  # Linux x64 (AppImage)
#   fork/ci-desktop.sh mac    # macOS arm64 (DMG), unsigniert
#
# Ergebnis liegt in release/. Ohne Update-Feed: die Builds suchen nicht nach offiziellen Updates.
set -euo pipefail

platform="${1:?Plattform fehlt: win, linux oder mac}"
cd "$(dirname "$0")/.."

# Vite+ liegt agent-lokal, damit der Build keine Installation des Nutzers anfasst. Es wählt
# Node aus engines.node in package.json.
export VP_HOME="${VP_HOME:-${AGENT_TOOLS_DIR:-$HOME/.cache}/t3code-vite-plus}"
export VP_NODE_MANAGER=yes CI=true
if [ ! -x "$VP_HOME/bin/vp" ]; then
  curl -fsSL https://vite.plus | bash
fi
export PATH="$VP_HOME/bin:$PATH"
vp env install
eval "$(vp env print)"
node --version

[ -f .env ] || cp .env.example .env
unset T3CODE_DESKTOP_UPDATE_REPOSITORY GITHUB_REPOSITORY
rm -rf release

vp install --filter=@t3tools/desktop... --filter=t3... --filter=@t3tools/scripts...

case "$platform" in
  win)
    # Wie release-desktop.yml: Resource-Monitor per cargo-xwin, NSIS über electron-builders
    # Linux-makensis. Ohne Wine und ohne Signatur.
    rustup target add x86_64-pc-windows-msvc
    command -v cargo-xwin >/dev/null || cargo install --locked cargo-xwin@0.23.1
    cargo xwin build --locked --release --manifest-path native/resource-monitor/Cargo.toml \
      --target x86_64-pc-windows-msvc
    T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
      node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64
    ;;
  linux)
    rustup target add x86_64-unknown-linux-gnu
    node scripts/build-desktop-artifact.ts --platform linux --target AppImage --arch x64
    ;;
  mac)
    # Native modules (node-pty) must link with Xcode's toolchain; the Command Line Tools linker
    # can lag behind their SDK.
    if [ -d /Applications/Xcode.app ]; then
      export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
      SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
      export SDKROOT
    fi
    node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64
    ;;
  *)
    echo "Unbekannte Plattform: $platform" >&2
    exit 1
    ;;
esac

ls -la release
