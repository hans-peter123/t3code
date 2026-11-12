#!/usr/bin/env bash
# Spielt die neuesten Änderungen aus pingdotgg/t3code ein und legt die Fork-Commits wieder obenauf.
# Danach werden Abhängigkeiten installiert, Typecheck, knip und Sprach-Tests ausgeführt und der
# Fork gepusht.
#
#   fork/sync-upstream.sh            nur Sync + Push
#   fork/sync-upstream.sh --release  danach Windows, macOS und iOS bauen (fork/release.sh)
#
# Nach gelösten Konflikten einfach erneut starten; es macht dort weiter.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
[ -f "$HOME/.config/vite-plus/env" ] && . "$HOME/.config/vite-plus/env"

release=0
[ "${1:-}" = "--release" ] && release=1

if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  echo "Ein Rebase läuft noch. Konflikte lösen, git add <dateien> && git rebase --continue," >&2
  echo "dann dieses Skript erneut starten." >&2
  exit 1
fi

branch="$(git branch --show-current)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Es gibt uncommittete Änderungen. Bitte zuerst committen oder stashen." >&2
  exit 1
fi

git remote get-url upstream >/dev/null 2>&1 ||
  git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch upstream main
git fetch origin "$branch"

if git merge-base --is-ancestor upstream/main HEAD &&
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ]; then
  echo "Nichts Neues: $branch enthält upstream/main ($(git rev-parse --short upstream/main)) und ist gepusht."
  exit 0
fi

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

if ! git merge-base --is-ancestor upstream/main HEAD; then
  backup="backup/${branch}-$(date +%Y%m%d-%H%M%S)"
  git branch "$backup"
  echo "Sicherung des alten Stands: $backup"
  echo "Neu im Original: $(git rev-list --count HEAD..upstream/main) Commits."
fi

if git merge-base --is-ancestor upstream/main HEAD; then
  : # Schon auf dem neuesten Stand, etwa nach von Hand gelösten Konflikten.
elif ! git rebase upstream/main; then
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

# Upstream ändert gern Schnittstellen, die Fork-Code nutzt; daher alle Pakete mit Fork-Code prüfen.
for package in packages/contracts packages/client-runtime apps/server apps/web apps/desktop apps/mobile; do
  echo "Typecheck $package"
  (cd "$package" && vp run typecheck)
done
vp run knip:check
vp test run packages/client-runtime/src/speech packages/client-runtime/src/voice-input
(cd apps/mobile && vp test run --project unit src/features/speech src/features/handsfree src/features/voice-input)

git push --force-with-lease origin "$branch"
echo "Gepusht. $(git rev-list --count upstream/main..HEAD) Fork-Commits liegen auf upstream/main ($(git rev-parse --short upstream/main))."

if [ "$release" = 1 ]; then exec fork/release.sh; fi
