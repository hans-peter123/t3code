#!/usr/bin/env bash
# Baut die iOS-App des Forks als signierten Release und lädt sie zu TestFlight hoch.
#
#   fork/build-ios.sh            Archiv bauen und zu TestFlight hochladen
#   fork/build-ios.sh --no-upload  nur das Archiv bauen (zum Prüfen)
#
# Erwartet .env.local im Repo-Root mit T3CODE_IOS_BUNDLE_ID und T3CODE_APPLE_TEAM_ID
# sowie ein in Xcode angemeldetes Apple-Developer-Konto.
set -euo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"
# shellcheck disable=SC1091
[ -f "$HOME/.config/vite-plus/env" ] && . "$HOME/.config/vite-plus/env"

upload=1
[ "${1:-}" = "--no-upload" ] && upload=0

env_value() { grep -E "^$1=" .env.local 2>/dev/null | tail -1 | cut -d= -f2-; }
team="$(env_value T3CODE_APPLE_TEAM_ID)"
bundle="$(env_value T3CODE_IOS_BUNDLE_ID)"
if [ -z "$team" ] || [ -z "$bundle" ]; then
  echo ".env.local braucht T3CODE_IOS_BUNDLE_ID und T3CODE_APPLE_TEAM_ID." >&2
  exit 1
fi
if [ "$(env_value T3CODE_MOBILE_UPDATES_ENABLED)" != "0" ]; then
  echo "WARNUNG: T3CODE_MOBILE_UPDATES_ENABLED=0 fehlt; offizielle OTA-Updates könnten den Fork überschreiben." >&2
fi
[ -f .env ] || cp .env.example .env

build_number="$(date +%Y%m%d%H%M)"
build_dir="$root/apps/mobile/ios/build"
archive="$build_dir/T3Code.xcarchive"

cd apps/mobile
APP_VARIANT=production EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform ios
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' ios/T3Code/Info.plist)"
for plist in ios/T3Code/Info.plist ios/ExpoWidgetsTarget/Info.plist; do
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$plist"
done

cd ios
rm -rf "$archive"
xcodebuild \
  -workspace T3Code.xcworkspace \
  -scheme T3Code \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$team" \
  CODE_SIGN_STYLE=Automatic \
  CURRENT_PROJECT_VERSION="$build_number" \
  MARKETING_VERSION="$version" \
  archive | tee "$build_dir/archive.log" | grep -E "error:|warning: .*[Ss]ign|ARCHIVE (SUCCEEDED|FAILED)" || true
[ -d "$archive" ] || { echo "Archiv fehlgeschlagen, Details: $build_dir/archive.log" >&2; exit 1; }
echo "Archiv: $archive (Version $version, Build $build_number)"

[ "$upload" = 1 ] || exit 0

options="$build_dir/ExportOptions.plist"
cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$team</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><true/>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$archive" \
  -exportOptionsPlist "$options" \
  -exportPath "$build_dir/export" \
  -allowProvisioningUpdates
echo "Hochgeladen. Der Build erscheint nach der Verarbeitung (ca. 5–15 Min.) in TestFlight."
