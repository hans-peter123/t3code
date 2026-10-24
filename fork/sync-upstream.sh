#!/usr/bin/env bash
# Spielt die neuesten Änderungen aus pingdotgg/t3code ein und legt die Fork-Commits wieder obenauf.
# Danach werden Abhängigkeiten installiert, Typecheck + TTS-Tests ausgeführt und der Fork gepusht.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
[ -f "$HOME/.config/vite-plus/env" ] && . "$HOME/.config/vite-plus/env"

branch="$(git branch --show-current)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Es gibt uncommittete Änderungen. Bitte zuerst committen oder stashen." >&2
  exit 1
fi

git remote get-url upstream >/dev/null 2>&1 ||
  git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch upstream main

backup="backup/${branch}-$(date +%Y%m%d-%H%M%S)"
git branch "$backup"
echo "Sicherung des alten Stands: $backup"

# pnpm-lock.yaml wird nicht von Hand gemergt: Upstream-Version nehmen und neu erzeugen.
resolve_lockfile_only() {
  local conflicts
  conflicts="$(git diff --name-only --diff-filter=U)"
  [ "$conflicts" = "pnpm-lock.yaml" ] || return 1
  git checkout --ours pnpm-lock.yaml # bei einem Rebase ist "ours" die Upstream-Seite
  vp i
  git add pnpm-lock.yaml
  GIT_EDITOR=true git rebase --continue
}

if ! git rebase upstream/main; then
  while [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; do
    if ! resolve_lockfile_only; then
      echo
      echo "Konflikte, die von Hand (oder vom Agenten) gelöst werden müssen:" >&2
      git diff --name-only --diff-filter=U >&2
      echo "Danach: git add <dateien> && git rebase --continue, dann dieses Skript erneut starten." >&2
      echo "Abbrechen: git rebase --abort (Sicherung: $backup)" >&2
      exit 1
    fi
  done
fi

vp i
if ! git diff --quiet pnpm-lock.yaml; then
  git commit -m "chore(fork): refresh lockfile" pnpm-lock.yaml
fi

if ! grep -q "preferredIntervals = \[15.0\]" apps/mobile/node_modules/expo-audio/ios/MediaController.swift; then
  echo "WARNUNG: Der expo-audio-Patch für 15-Sekunden-Sprünge auf dem Sperrbildschirm greift nicht mehr." >&2
  echo "         Vermutlich hat Upstream expo-audio aktualisiert; patches/expo-audio@*.patch prüfen." >&2
fi

(cd apps/mobile && vp run typecheck && vp test run --project unit src/features/speech)

git push --force-with-lease origin "$branch"
echo "Fertig. $(git rev-list --count upstream/main..HEAD) Fork-Commits liegen auf upstream/main ($(git rev-parse --short upstream/main))."
