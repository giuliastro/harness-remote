#!/usr/bin/env bash
# Launch the Harness Remote desktop (Electron) app for the Bug 3 manual test:
# on startup, with machines already present, the app must go straight into Sessions and must NOT
# auto-open the Machines manager over an empty-looking list.
#
# It builds the desktop renderer + main, then runs Electron with a throwaway user-data directory and
# project root, so it never reads or writes your daily desktop profiles, window state or projects.
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
  shift
fi
if (($#)); then
  echo "Usage: $0 [--check]" >&2
  exit 2
fi

for required in node npm; do
  command -v "$required" >/dev/null || { echo "Missing required command: $required" >&2; exit 1; }
done
[[ -x "$ROOT_DIR/web/node_modules/.bin/electron" ]] || { echo "Electron is missing; run npm install in web/ first." >&2; exit 1; }

STATE_ROOT="${HARNESS_REMOTE_ELECTRON_TEST_DIR:-/tmp/opencode/harness-remote-electron-test}"
USER_DATA="$STATE_ROOT/user-data"
SANDBOX="$STATE_ROOT/sandbox"
mkdir -p "$USER_DATA" "$SANDBOX"
if [[ ! -d "$SANDBOX/.git" ]]; then
  git -C "$SANDBOX" init -q
  git -C "$SANDBOX" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm 'Initialize desktop test project'
fi

echo "Building the desktop app…"
npm --prefix "$ROOT_DIR/web" run build:desktop

if ((CHECK_ONLY)); then
  echo "--check passed: desktop build produced $ROOT_DIR/web/dist-electron/electron/main.js"
  exit 0
fi

cat <<EOF
Launching Harness Remote (desktop) in an isolated test state.

User data:    $USER_DATA
Project root: $SANDBOX

Checklist (Bug 3):
1. On startup the app must open directly on the Session list, not on the Machines manager.
2. The local "This computer" machine is resolved a moment after the first paint: while it is pending,
   the pane must show a loading state - never "add your first machine", and never a manager popup.
3. Open Machines manually, then close it: it must stay closed until you ask for it again.
4. Regression: add a remote machine, reopen the app and confirm it still goes straight to Sessions.

Close this terminal to stop the app. State lives under $STATE_ROOT and can be deleted when done.
EOF

HARNESS_REMOTE_ROOT="$SANDBOX" "$ROOT_DIR/web/node_modules/.bin/electron" "$ROOT_DIR/web" --user-data-dir="$USER_DATA"
