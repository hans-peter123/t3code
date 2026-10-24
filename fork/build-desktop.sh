#!/usr/bin/env bash
# Baut die macOS-Desktop-App des Forks (Apple Silicon) als DMG und öffnet sie im Finder.
#
# Der Build ist unsigniert: lokal gebaut hat er kein Quarantäne-Attribut und startet auf diesem
# Mac direkt. Ohne Update-Feed sucht die App nicht nach offiziellen Updates, die den Fork
# überschreiben würden.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
[ -f "$HOME/.config/vite-plus/env" ] && . "$HOME/.config/vite-plus/env"
[ -f .env ] || cp .env.example .env

unset T3CODE_DESKTOP_UPDATE_REPOSITORY GITHUB_REPOSITORY
# Native modules (node-pty) must link with Xcode's toolchain; the Command Line Tools linker
# can lag behind their SDK.
if [ -d /Applications/Xcode.app ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
  export SDKROOT
fi
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64

dmg="$(ls -t release/*.dmg 2>/dev/null | head -1 || true)"
[ -n "$dmg" ] || { echo "Kein DMG gefunden." >&2; exit 1; }
echo "Fertig: $dmg"
open -R "$dmg"
