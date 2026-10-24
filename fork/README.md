# Persönlicher Fork: T3 Code mit Vorlesen (TTS)

Dieser Fork ergänzt die iOS-App um **Vorlesen** von Assistenten-Nachrichten:

- Lautsprecher-Knopf neben „Kopieren“ unter jeder Antwort; während der Wiedergabe: −15 s, Pause/Weiter, +15 s, Stopp, Zeit.
- Wiedergabe läuft im Hintergrund weiter und erscheint auf dem Sperrbildschirm / im Kontrollzentrum (Play/Pause, ±15 s, Scrubben).
- Provider in **Einstellungen → Read aloud**: OpenAI, ElevenLabs oder ein eigener OpenAI-kompatibler Server
  (z. B. Kokoro-FastAPI im NetBird-Netz). API-Keys liegen im iOS-Schlüsselbund.
- Code: `apps/mobile/src/features/speech/`.

## Branches

- `main` = `upstream/main` + Fork-Commits (wird bei Updates rebased, daher `--force-with-lease`).
- Sicherungen vor jedem Update: `backup/main-<datum>`.

## Updates vom Original übernehmen

```bash
fork/sync-upstream.sh
```

Holt `pingdotgg/t3code`, legt die Fork-Commits oben drauf, löst Konflikte in `pnpm-lock.yaml` automatisch,
installiert, führt Typecheck + TTS-Tests aus und pusht. Bei echten Konflikten stoppt das Skript und listet
die Dateien – dann den Agenten bitten, sie zu lösen.

## iOS bauen und zu TestFlight hochladen

```bash
fork/build-ios.sh             # bauen + hochladen
fork/build-ios.sh --no-upload # nur bauen
```

Voraussetzungen (einmalig):

- `.env.local` im Repo-Root (nicht eingecheckt):
  ```
  T3CODE_IOS_BUNDLE_ID=de.nirod.t3code
  T3CODE_APPLE_TEAM_ID=R8GFE8WGGA
  T3CODE_MOBILE_APP_NAME=T3 Code+
  T3CODE_MOBILE_UPDATES_ENABLED=0
  ```
- Xcode mit dem Developer-Account angemeldet.
- App in App Store Connect angelegt (Bundle-ID `de.nirod.t3code`).
- App-ID `de.nirod.t3code.sharing` hat im Developer-Portal die App Group `group.de.nirod.t3code`.

`T3CODE_MOBILE_UPDATES_ENABLED=0` ist wichtig: sonst könnte die App offizielle OTA-Updates laden, die den
Fork-Code ersetzen.

## Bekannte Grenzen eigener Builds

- Login mit T3 Connect: GitHub/E-Mail über Clerk; Passkeys und nativer „Sign in with Apple“ funktionieren nur
  in den offiziellen Apps. Alternativ direkt per LAN/NetBird/Tailscale mit dem Server koppeln.
- Push-Benachrichtigungen und Live-Activity-Updates verschickt der offizielle Relay mit T3s APNs-Schlüssel nur
  an die offiziellen Bundle-IDs. Widgets und Share-Extension funktionieren lokal.
