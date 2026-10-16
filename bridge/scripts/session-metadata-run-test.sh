#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
  shift
fi
if (($#)); then
  printf '%s\n' "Usage: $0 [--check]" >&2
  exit 2
fi

for required in node npm git curl base64 setsid; do
  command -v "$required" >/dev/null 2>&1 || { printf 'Missing required command: %s\n' "$required" >&2; exit 1; }
done
[[ -x "$ROOT_DIR/web/node_modules/.bin/vite" ]] || { echo "Web dependencies are missing; install them before running this script." >&2; exit 1; }
OPENCode_BIN="$(command -v opencode2 || true)"
if [[ -z "$OPENCode_BIN" && -x "$HOME/.opencode/bin/opencode2" ]]; then
  OPENCode_BIN="$HOME/.opencode/bin/opencode2"
fi
[[ -n "$OPENCode_BIN" ]] || { echo "OpenCode 2 CLI (opencode2) is not installed or not on PATH." >&2; exit 1; }

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/harness-remote-session-metadata.XXXXXX")"
STATE_DIR="$TMP_ROOT/bridge-state"
NATIVE_DATA_DIR="$TMP_ROOT/native-data"
NATIVE_STATE_DIR="$TMP_ROOT/native-state"
SANDBOX="$TMP_ROOT/projects/session-metadata-sandbox"
HISTORY_PROJECT="$SANDBOX/history-project"
LOG_DIR="$TMP_ROOT/logs"
mkdir -p "$STATE_DIR" "$NATIVE_DATA_DIR/opencode" "$NATIVE_DATA_DIR/mimocode" "$NATIVE_STATE_DIR" "$SANDBOX" "$HISTORY_PROJECT" "$LOG_DIR"
git -C "$SANDBOX" init -q
git -C "$SANDBOX" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm 'Initialize isolated session metadata sandbox'
git -C "$HISTORY_PROJECT" init -q
git -C "$HISTORY_PROJECT" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm 'Initialize throwaway history project'

# OpenCode and MiMo read provider credentials from their data directories. Copy only auth.json into
# the isolated test data root; leave the user's config, sessions, cache, and global installation untouched.
ORIGINAL_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
OPENCODE_AUTH_COPIED=0
MIMO_AUTH_COPIED=0
if [[ -f "$ORIGINAL_DATA_HOME/opencode/auth.json" ]]; then
  install -m 600 -- "$ORIGINAL_DATA_HOME/opencode/auth.json" "$NATIVE_DATA_DIR/opencode/auth.json"
  OPENCODE_AUTH_COPIED=1
fi
if [[ -f "$ORIGINAL_DATA_HOME/mimocode/auth.json" ]]; then
  install -m 600 -- "$ORIGINAL_DATA_HOME/mimocode/auth.json" "$NATIVE_DATA_DIR/mimocode/auth.json"
  MIMO_AUTH_COPIED=1
fi

DAEMON_PID=""
WEB_PID=""
DAEMON_PORT=""
OPENCODE_PORT=""
WEB_PORT=""
USERNAME="session-test"
PASSWORD="local-session-test"
FRONTEND_URL=""

stop_group() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in {1..50}; do
    kill -0 -- "-$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  stop_group "$WEB_PID"
  stop_group "$DAEMON_PID"
  rm -rf -- "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

free_port() {
  node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
DAEMON_PORT="$(free_port)"
OPENCODE_PORT="$(free_port)"
WEB_PORT="$(free_port)"
while [[ "$OPENCODE_PORT" == "$DAEMON_PORT" ]]; do OPENCODE_PORT="$(free_port)"; done
while [[ "$WEB_PORT" == "$DAEMON_PORT" || "$WEB_PORT" == "$OPENCODE_PORT" ]]; do WEB_PORT="$(free_port)"; done
FRONTEND_URL="http://127.0.0.1:$WEB_PORT"

npm --prefix "$ROOT_DIR/web" run build >"$LOG_DIR/build.log" 2>&1 || { cat "$LOG_DIR/build.log" >&2; exit 1; }

start_daemon() {
  setsid env \
    XDG_DATA_HOME="$NATIVE_DATA_DIR" \
    XDG_STATE_HOME="$NATIVE_STATE_DIR" \
    OPENCODE_CONFIG_CONTENT='{"model":"opencode/longcat-2.5-preview-free"}' \
    PATH="$(dirname -- "$OPENCode_BIN"):$PATH" \
    node "$ROOT_DIR/bridge/src/daemon-cli.js" \
      --backend opencode2 --no-opencode --host 127.0.0.1 --port "$DAEMON_PORT" \
      --username "$USERNAME" --password "$PASSWORD" \
      --root "$SANDBOX" --state-dir "$STATE_DIR" --cors "$FRONTEND_URL" \
      --opencode-port "$OPENCODE_PORT" >"$LOG_DIR/daemon.log" 2>&1 &
  DAEMON_PID=$!
}

start_frontend() {
  setsid "$ROOT_DIR/web/node_modules/.bin/vite" preview \
    --host 127.0.0.1 --port "$WEB_PORT" --strictPort --outDir "$ROOT_DIR/web/dist" >"$LOG_DIR/frontend.log" 2>&1 &
  WEB_PID=$!
}

wait_http() {
  local url="$1" auth="${2:-}" attempts="${3:-100}"
  for _ in $(seq 1 "$attempts"); do
    if [[ -n "$auth" ]]; then
      if curl --fail --silent --max-time 1 --user "$auth" "$url" >/dev/null 2>&1; then return 0; fi
    elif curl --fail --silent --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

start_services() {
  start_daemon
  start_frontend
  if ! wait_http "$FRONTEND_URL/" ""; then
    echo "Frontend failed to start:" >&2
    cat "$LOG_DIR/frontend.log" >&2
    return 1
  fi
  if ! wait_http "http://127.0.0.1:$DAEMON_PORT/v1/machine" "$USERNAME:$PASSWORD"; then
    echo "Authenticated daemon health check failed:" >&2
    cat "$LOG_DIR/daemon.log" >&2
    return 1
  fi
  local machine_status
  machine_status="$(curl --silent --show-error --max-time 4 -o "$TMP_ROOT/machine.json" -w '%{http_code}' \
    --user "$USERNAME:$PASSWORD" "http://127.0.0.1:$DAEMON_PORT/v1/machine" 2>/dev/null || true)"
  if [[ "$machine_status" != 200 ]] || ! node --input-type=module -e \
    'import fs from "node:fs"; const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!x.agents?.some(a=>a.id==="opencode2")) process.exit(1)' \
    "$TMP_ROOT/machine.json"; then
    printf 'Authenticated /v1/machine probe failed or OpenCode 2 was not advertised (HTTP %s).\n' "$machine_status" >&2
    cat "$LOG_DIR/daemon.log" >&2
    return 1
  fi
}

start_services
if ((CHECK_ONLY)); then
  printf '%s\n' "--check passed: frontend reachable at $FRONTEND_URL; authenticated /v1/machine reports opencode2 on port $DAEMON_PORT."
  exit 0
fi

cat <<EOF
Session metadata test environment is ready.

Frontend: $FRONTEND_URL
Machine name: Session metadata test
Machine URL: http://127.0.0.1:$DAEMON_PORT
Username: $USERNAME
Password: $PASSWORD
Harness: OpenCode 2
Approved OpenCode model: opencode/longcat-2.5-preview-free
Project: session-metadata-sandbox
Project path: $SANDBOX
History project: history-project
History project path: $HISTORY_PROJECT
Isolated OpenCode XDG data/state: $NATIVE_DATA_DIR and $NATIVE_STATE_DIR
if [[ "$OPENCODE_AUTH_COPIED" == 1 || "$MIMO_AUTH_COPIED" == 1 ]]; then
  echo "Provider auth files copied into isolated data."
fi
OpenCode auth copied: $([[ "$OPENCODE_AUTH_COPIED" == 1 ]] && echo yes || echo no)
MiMo auth copied: $([[ "$MIMO_AUTH_COPIED" == 1 ]] && echo yes || echo no)

Checklist:
1. Add a machine named "Session metadata test" with the URL and credentials above. Open Projects, choose
   "session-metadata-sandbox" at the printed project path, select OpenCode 2, create a Session, and send
   a small prompt using opencode/longcat-2.5-preview-free. If that approved model is unavailable, stop
   and report it; do not substitute another model.
2. Rename the Session. Refresh the app and confirm the new name remains; then delete it and confirm it
   disappears from Harness Remote while remaining in OpenCode's native history.
3. In Projects, choose "history-project". Create a Session and send a small prompt. In another terminal,
   remove only that throwaway project folder with: rm -rf -- '$HISTORY_PROJECT'. Refresh the app and
   reopen the Session. Confirm the last assistant reply remains visible. Attempting to continue must
   report a clear missing-project error. Do not remove the sandbox parent or any other directory.
4. Return to this terminal and enter r then Enter. The daemon restarts with the same bridge state,
   isolated OpenCode data/state, and project folders. Confirm the renamed/deleted results and the
   surviving history behavior remain consistent. Enter r again to repeat, or q then Enter to exit.
5. Regression checklist, when each harness and its approved model are available: Codex with
   gpt-6-luna, Oh My Pi with openrouter/free, and PI with qwen/qwen3.8-27b:free via OpenRouter. For each,
   create a Session, choose the approved model, prompt and verify a response, stop and continue, then
   reopen and confirm history. MiMo with OpenAI Luna is also approved: create a Session, choose MiMo
   with OpenAI Luna (openai/gpt-6-luna), prompt and verify a response, stop and continue, then reopen
   and confirm history.
   If any approved model is absent, stop that harness check and report it; do not substitute another.
   Do not run Claude Code tests.

The copied auth.json is never printed. Exiting stops only the frontend and daemon process groups started
here and removes this run's temporary state and sandbox. It does not stop services by name or port.
EOF

if [[ "${HARNESS_REMOTE_NO_BROWSER:-0}" != 1 ]] && command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$FRONTEND_URL" >/dev/null 2>&1 || true
fi

while true; do
  printf '%s' 'Enter r to restart the test daemon, or q to quit: '
  IFS= read -r choice || choice=q
  case "${choice,,}" in
    r)
      stop_group "$DAEMON_PID"
      DAEMON_PID=""
      start_daemon
      if ! wait_http "http://127.0.0.1:$DAEMON_PORT/v1/machine" "$USERNAME:$PASSWORD"; then
        echo "Restarted daemon did not pass its authenticated health check:" >&2
        cat "$LOG_DIR/daemon.log" >&2
        exit 1
      fi
      echo "Daemon restarted; bridge state and sandbox are preserved."
      ;;
    q)
      break
      ;;
    *)
      echo "Enter r or q."
      ;;
  esac
done
