#!/usr/bin/env bash
# Schickt eine E-Mail über die Mail-App dieses Macs an T3CODE_FORK_MAIL_TO aus .env.local.
#
#   fork/send-mail.sh "<Betreff>" <datei-mit-text>
set -euo pipefail

cd "$(dirname "$0")/.."
subject="${1:?Betreff fehlt}"
body_file="${2:?Textdatei fehlt}"
to="$({ grep -E '^T3CODE_FORK_MAIL_TO=' .env.local 2>/dev/null || true; } | tail -1 | cut -d= -f2-)"
[ -n "$to" ] || { echo "T3CODE_FORK_MAIL_TO fehlt in .env.local." >&2; exit 1; }

osascript - "$to" "$subject" "$body_file" <<'APPLESCRIPT'
on run argv
  set {recipientAddress, mailSubject, bodyPath} to argv
  set mailBody to read POSIX file bodyPath as «class utf8»
  tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:mailSubject, content:mailBody, visible:false}
    tell newMessage to make new to recipient at end of to recipients with properties {address:recipientAddress}
    send newMessage
  end tell
end run
APPLESCRIPT
echo "E-Mail an $to verschickt."
