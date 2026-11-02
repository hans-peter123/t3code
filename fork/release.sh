#!/usr/bin/env bash
# Baut den gepushten Stand von main für Windows und macOS (TeamCity) und iOS (TestFlight).
#
#   fork/release.sh             alle drei
#   fork/release.sh --no-ios    nur die Desktop-Builds in TeamCity
#
# TeamCity ist nur über NetBird/WireGuard erreichbar (interne Adresse, die SSO der
# öffentlichen Adresse blockt Tokens). Das Token kommt aus TEAMCITY_TOKEN, .env.local
# oder ~/Herd/notes/.env.
set -euo pipefail

cd "$(dirname "$0")/.."

ios=1
[ "${1:-}" = "--no-ios" ] && ios=0

tc_url="${TEAMCITY_URL:-http://10.1.1.211:8111}"
token_from() { grep -E '^TEAMCITY_TOKEN=' "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' "; }
token="${TEAMCITY_TOKEN:-$(token_from .env.local)}"
[ -n "$token" ] || token="$(token_from "$HOME/Herd/notes/.env")"
[ -n "$token" ] || { echo "Kein TEAMCITY_TOKEN gefunden." >&2; exit 1; }

revision="$(git rev-parse --short HEAD)"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main 2>/dev/null)" ]; then
  echo "HEAD ($revision) ist nicht origin/main. Erst pushen, TeamCity baut den Remote-Stand." >&2
  exit 1
fi

tc() { curl -fsS --max-time 20 -H "Authorization: Bearer $token" -H "Accept: application/json" "$@"; }
json_field() { python3 -c "import sys,json;print(json.load(sys.stdin,strict=False).get('$1',''))"; }

tc -o /dev/null "$tc_url/app/rest/server" ||
  { echo "TeamCity unter $tc_url nicht erreichbar (NetBird an?)." >&2; exit 1; }

builds=()
for type in T3Code_DesktopWindows T3Code_DesktopMacos; do
  id="$(tc -X POST -H "Content-Type: application/json" "$tc_url/app/rest/buildQueue" \
    -d "{\"buildType\":{\"id\":\"$type\"},\"comment\":{\"text\":\"fork/release.sh $revision\"}}" |
    json_field id)"
  echo "TeamCity $type: https://teamcity.muntean.cloud/build/$id"
  builds+=("$id")
done

ios_status=0
if [ "$ios" = 1 ]; then
  # Nicht unter apps/mobile/ios: der Prebuild löscht das Verzeichnis.
  log="${TMPDIR:-/tmp}/t3code-build-ios.log"
  echo "iOS-Build läuft, Log: $log"
  fork/build-ios.sh >"$log" 2>&1 || ios_status=$?
  if [ "$ios_status" = 0 ]; then
    grep -E "^Archiv:|^Hochgeladen" "$log" || true
  else
    echo "iOS-Build fehlgeschlagen:" >&2
    tail -20 "$log" >&2
  fi
fi

desktop_status=0
for id in "${builds[@]}"; do
  while :; do
    build="$(tc "$tc_url/app/rest/builds/id:$id?fields=buildTypeId,state,status,statusText")"
    [ "$(printf '%s' "$build" | json_field state)" = finished ] && break
    sleep 30
  done
  status="$(printf '%s' "$build" | json_field status)"
  echo "$(printf '%s' "$build" | json_field buildTypeId): $status — https://teamcity.muntean.cloud/build/$id"
  [ "$status" = SUCCESS ] || desktop_status=1
done

[ "$ios_status" = 0 ] && [ "$desktop_status" = 0 ] && echo "Alle Builds fertig ($revision)."
exit $((ios_status != 0 || desktop_status != 0))
