#!/usr/bin/env bash
# Ready-to-run manual test environment for the six Session-first UI fixes.
#
# It starts two isolated machines and a frontend, all on free ports and separate state:
#   - OpenCode 2 machine: exercises the working-session label, the header identity and settings.
#   - MiMo machine (project-scoped, four roots): exercises the "Load older Sessions" pagination
#     button, which is the one surface that advertises a continuation cursor.
# Nothing touches your daily machines, state or ports, and closing this terminal stops only the
# processes it started.
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

for required in node npm curl base64 setsid; do
  command -v "$required" >/dev/null || { echo "Missing required command: $required" >&2; exit 1; }
done
[[ -x "$ROOT_DIR/web/node_modules/.bin/vite" ]] || { echo "Web dependencies are missing; run npm install in web/ first." >&2; exit 1; }
[[ -n "$(command -v opencode2 || true)" || -x "$HOME/.opencode/bin/opencode2" ]] || { echo "OpenCode 2 CLI (opencode2) is not installed." >&2; exit 1; }
[[ -n "$(command -v mimo || true)" || -x "$HOME/.mimocode/bin/mimo" ]] || { echo "MiMo CLI (mimo) is not installed." >&2; exit 1; }

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/harness-remote-ui-fixes-test.XXXXXX")"
LOG_DIR="$TMP_ROOT/logs"
OC_STATE="$TMP_ROOT/opencode2-state"
OC_SANDBOX="$TMP_ROOT/opencode2-sandbox"
MIMO_STATE="$TMP_ROOT/mimo-state"
mkdir -p "$LOG_DIR" "$OC_STATE" "$OC_SANDBOX" "$MIMO_STATE"
git -C "$OC_SANDBOX" init -q
git -C "$OC_SANDBOX" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm 'Initialize isolated OpenCode 2 test project'
# Four separate Project roots so the project-scoped MiMo machine has an unscanned tail: that is what
# makes the Session rail advertise a continuation cursor at all.
MIMO_ROOTS=()
for index in 1 2 3 4; do
  root="$TMP_ROOT/mimo-root-$index"
  mkdir -p "$root"
  git -C "$root" init -q
  git -C "$root" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm "Initialize MiMo test project $index"
  MIMO_ROOTS+=(--root "$root")
done

PIDS=()
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    for _ in {1..30}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && { kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
    wait "$pid" 2>/dev/null || true
  done
  rm -rf -- "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

free_port() {
  node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
OC_DAEMON_PORT="$(free_port)"
MIMO_DAEMON_PORT="$(free_port)"
OC_HOST_PORT="$(free_port)"
MIMO_HOST_PORT="$(free_port)"
VITE_PORT="$(free_port)"
while [[ "$MIMO_DAEMON_PORT" == "$OC_DAEMON_PORT" ]]; do MIMO_DAEMON_PORT="$(free_port)"; done
while [[ "$VITE_PORT" == "$OC_DAEMON_PORT" || "$VITE_PORT" == "$MIMO_DAEMON_PORT" ]]; do VITE_PORT="$(free_port)"; done
FRONTEND_URL="http://127.0.0.1:$VITE_PORT"
USERNAME="harness"
PASSWORD="test-ui-fixes-local"

npm --prefix "$ROOT_DIR/web" run build

start_group() {
  local logfile="$1"; shift
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >"$logfile" 2>&1 &
  else
    "$@" >"$logfile" 2>&1 &
  fi
  PIDS+=("$!")
}
start_group "$LOG_DIR/opencode2-daemon.log" node "$ROOT_DIR/bridge/src/daemon-cli.js" \
  --backend opencode2 --host 127.0.0.1 --port "$OC_DAEMON_PORT" \
  --username "$USERNAME" --password "$PASSWORD" \
  --root "$OC_SANDBOX" --state-dir "$OC_STATE" --cors "$FRONTEND_URL" \
  --opencode-port "$OC_HOST_PORT"
start_group "$LOG_DIR/mimo-daemon.log" node "$ROOT_DIR/bridge/src/daemon-cli.js" \
  --backend mimo --host 127.0.0.1 --port "$MIMO_DAEMON_PORT" \
  --username "$USERNAME" --password "$PASSWORD" \
  "${MIMO_ROOTS[@]}" --state-dir "$MIMO_STATE" --cors "$FRONTEND_URL" \
  --opencode-port "$MIMO_HOST_PORT" --no-opencode
start_group "$LOG_DIR/vite.log" "$ROOT_DIR/web/node_modules/.bin/vite" "$ROOT_DIR/web" --host 127.0.0.1 --port "$VITE_PORT" --strictPort

wait_http() {
  local url="$1"; local attempts="${2:-100}"
  for _ in $(seq 1 "$attempts"); do
    if curl --fail --silent --show-error --user "$USERNAME:$PASSWORD" --max-time 1 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  return 1
}
if ! wait_http "$FRONTEND_URL/"; then
  echo "Frontend failed to start:" >&2; cat "$LOG_DIR/vite.log" >&2; exit 1
fi
wait_http "http://127.0.0.1:$OC_DAEMON_PORT/v1/machine" || { echo "OpenCode 2 daemon failed to start:" >&2; cat "$LOG_DIR/opencode2-daemon.log" >&2; exit 1; }
wait_http "http://127.0.0.1:$MIMO_DAEMON_PORT/v1/machine" || { echo "MiMo daemon failed to start:" >&2; cat "$LOG_DIR/mimo-daemon.log" >&2; exit 1; }

if ((CHECK_ONLY)); then
  echo "--check passed: frontend $FRONTEND_URL; OpenCode 2 on $OC_DAEMON_PORT; MiMo on $MIMO_DAEMON_PORT."
  exit 0
fi

cat <<EOF
Harness Remote UI-fix manual test is ready.

Frontend:        $FRONTEND_URL
OpenCode 2 machine: host 127.0.0.1  port $OC_DAEMON_PORT
MiMo machine:       host 127.0.0.1  port $MIMO_DAEMON_PORT
Username: $USERNAME
Password: $PASSWORD
Approved models: OpenCode 2 -> opencode/longcat-2.5-preview-free ; MiMo -> openai/gpt-6-luna
OpenCode 2 sandbox: $OC_SANDBOX
MiMo Project roots: 4 temporary git folders (listed above on the MiMo daemon log line)

Checklist (bugs 1, 2, 5, 6):
1. Add both machines in Harness Remote with the host/port/credentials above.
2. Bug 1 - pagination: filter to MiMo Code on the MiMo machine. With all four roots empty, discovery
   must finish without "Carica sessioni precedenti". Create a MiMo Code Session titled PAGINATION-ROOT-3
   in mimo-root-3 (leave roots 1 and 2 empty); no prompt is needed. Reload the app and filter to MiMo:
   the Session must appear even though the first two roots are empty. Open it and confirm its title.
   Normal nonempty pages must still load older Sessions only on click, on the selected machine.
   If a scan reaches its four-page/time budget, continuation must remain available even with no rows;
   that button represents unscanned history, not proof that the machine is empty.
3. Bug 2 - working label: on the OpenCode 2 machine create a Session, select
   opencode/longcat-2.5-preview-free and send: "Use bash to run sleep 25, then reply REOPEN_UI_OK.
   Do not modify files." While it answers, open another Session and return to the active one. During
   history loading there must be only the history loader, with no provisional harness reply bubble.
   After loading the live reply must read "<harness> is working", never "is getting started". Repeat
   after reloading the app. A fresh Send must still show "is getting started" before assistant activity.
4. Bug 5 - duplicate identity: open that Session. The top bar keeps
   "This computer / <project> / <title>"; the line above the title must show only the harness, with no
   repeated machine or project.
5. Bug 6 - settings: open Settings (top-right icon). The window is wider, long option labels such as
   "Riduci a una riga di riepilogo" are not clipped, and every dropdown shows its chevron and reads as
   a control, not a plain box. Switch language to Italiano to check the longest labels.

Not covered here (they need their own device):
- Bug 3 is desktop/Electron-only: run "npm run electron:dev" in web/ and confirm the Machines manager
  no longer opens itself on startup when machines exist (it goes straight to Sessions).
- Bug 4 is phone-only: pair a phone by QR, follow a long Session, background the phone, let the PC
  finish the turn, then foreground the phone: the Session must stop reading "working" immediately.

Closing this terminal stops only the two daemons and Vite started here and removes the sandbox.
EOF

if command -v xdg-open >/dev/null 2>&1; then xdg-open "$FRONTEND_URL" >/dev/null 2>&1 || true; fi
wait
