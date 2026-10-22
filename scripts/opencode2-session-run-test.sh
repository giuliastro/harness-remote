#!/usr/bin/env bash
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

for required in node npm git curl base64 setsid; do
  command -v "$required" >/dev/null || { echo "Missing required command: $required" >&2; exit 1; }
done
[[ -x "$ROOT_DIR/web/node_modules/.bin/vite" ]] || { echo "Web dependencies are missing; install them before running this script." >&2; exit 1; }
[[ -x "$HOME/.opencode/bin/opencode2" || -n "$(command -v opencode2 || true)" ]] || { echo "OpenCode 2 CLI (opencode2) is not installed or not on PATH." >&2; exit 1; }

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/harness-remote-opencode2-test.XXXXXX")"
STATE_DIR="$TMP_ROOT/state"
SANDBOX="$TMP_ROOT/harness-remote-opencode2-sandbox"
LOG_DIR="$TMP_ROOT/logs"
mkdir -p "$STATE_DIR" "$SANDBOX" "$LOG_DIR"
git -C "$SANDBOX" init -q
git -C "$SANDBOX" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm 'Initialize isolated OpenCode 2 test project'

DAEMON_PID=""
VITE_PID=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  for pid in "$VITE_PID" "$DAEMON_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "$VITE_PID" "$DAEMON_PID"; do
    if [[ -n "$pid" ]]; then
      for _ in {1..30}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -0 "$pid" 2>/dev/null && { kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf -- "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

free_port() {
  node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
DAEMON_PORT="$(free_port)"
OPENCODE_PORT="$(free_port)"
VITE_PORT="$(free_port)"
while [[ "$OPENCODE_PORT" == "$DAEMON_PORT" ]]; do OPENCODE_PORT="$(free_port)"; done
while [[ "$VITE_PORT" == "$DAEMON_PORT" || "$VITE_PORT" == "$OPENCODE_PORT" ]]; do VITE_PORT="$(free_port)"; done
FRONTEND_URL="http://127.0.0.1:$VITE_PORT"
USERNAME="harness"
PASSWORD="test-opencode2-local"

npm --prefix "$ROOT_DIR/web" run build

start_group() {
  local logfile="$1"; shift
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >"$logfile" 2>&1 &
  else
    "$@" >"$logfile" 2>&1 &
  fi
  LAST_PID=$!
}
start_group "$LOG_DIR/daemon.log" node "$ROOT_DIR/bridge/src/daemon-cli.js" \
  --backend opencode2 --host 127.0.0.1 --port "$DAEMON_PORT" \
  --username "$USERNAME" --password "$PASSWORD" \
  --root "$SANDBOX" --state-dir "$STATE_DIR" --cors "$FRONTEND_URL" \
  --opencode-port "$OPENCODE_PORT"
DAEMON_PID=$LAST_PID
start_group "$LOG_DIR/vite.log" "$ROOT_DIR/web/node_modules/.bin/vite" "$ROOT_DIR/web" --host 127.0.0.1 --port "$VITE_PORT" --strictPort
VITE_PID=$LAST_PID

wait_http() {
  local url="$1"; local attempts="${2:-100}"
  for _ in $(seq 1 "$attempts"); do
    if curl --fail --silent --show-error --user "$USERNAME:$PASSWORD" --max-time 1 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  return 1
}
if ! wait_http "$FRONTEND_URL/"; then
  echo "Frontend failed to start:" >&2
  cat "$LOG_DIR/vite.log" >&2
  exit 1
fi

curl --fail --silent "$FRONTEND_URL/" | node --input-type=module -e 'let text=""; for await(const chunk of process.stdin) text+=chunk; if(!text.includes("/src/main.tsx")) process.exit(1)'

AUTH="$(printf '%s:%s' "$USERNAME" "$PASSWORD" | base64 -w0)"
# Probe the daemon directly; the frontend URL is intentionally a separate origin for the CORS check.
wait_http "http://127.0.0.1:$DAEMON_PORT/v1/machine" || { cat "$LOG_DIR/daemon.log" >&2; exit 1; }
MACHINE_STATUS="$(curl --silent --show-error --max-time 4 -o "$TMP_ROOT/machine.json" -w '%{http_code}' \
  -H "Authorization: Basic $AUTH" "http://127.0.0.1:$DAEMON_PORT/v1/machine" 2>/dev/null || true)"
if [[ "$MACHINE_STATUS" != "200" ]] || ! node --input-type=module -e 'import fs from "node:fs"; const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!x.agents?.some(a=>a.id==="opencode2")) process.exit(1)' "$TMP_ROOT/machine.json"; then
  echo "Authenticated /v1/machine probe failed or OpenCode 2 was not advertised (HTTP $MACHINE_STATUS)." >&2
  cat "$LOG_DIR/daemon.log" >&2
  exit 1
fi

if ((CHECK_ONLY)); then
  echo "--check passed: frontend is reachable at $FRONTEND_URL; authenticated daemon /v1/machine reports opencode2 on port $DAEMON_PORT."
  exit 0
fi

cat <<EOF
OpenCode 2 local session test is ready.

Frontend: $FRONTEND_URL
Machine host: 127.0.0.1
Machine port: $DAEMON_PORT
Username: $USERNAME
Password: $PASSWORD
Sandbox project name: harness-remote-opencode2-sandbox
Sandbox path: $SANDBOX
Approved model: opencode/longcat-2.5-preview-free

Checklist:
1. In Harness Remote, add a machine with host 127.0.0.1, port $DAEMON_PORT, username $USERNAME, and password $PASSWORD.
2. Open the machine and confirm OpenCode 2 appears as an available harness.
3. Open Projects, choose the project harness-remote-opencode2-sandbox at $SANDBOX, then select OpenCode 2 and create a native Session.
4. Confirm the new Session is listed under OpenCode 2 and remains there after refresh; check that no request fails with ECONNREFUSED on port 4096.
5. Open the model and variant picker and select the approved model opencode/longcat-2.5-preview-free and send a small prompt such as “Reply with exactly: opencode2 test passed”. Confirm a response, then stop and continue the Session once.

6. Reload the app, reopen the Session and send a second prompt: it must continue the same Session with its history.
7. Check a deliberately incorrect machine port: the UI must show a connection error and allow retrying.
8. Regression: repeat create, model selection, prompt, Stop, continue and reopen for OpenCode (opencode/longcat-2.5-preview-free), Codex (gpt-6-luna), OMP (openrouter/free), PI (qwen/qwen3.8-27b:free), when installed. Do not test Claude Code. If an approved model is absent, stop that harness test and report it.

Closing this terminal stops only the daemon and Vite processes started by this script and removes the temporary state and sandbox.
EOF

if command -v xdg-open >/dev/null 2>&1; then xdg-open "$FRONTEND_URL" >/dev/null 2>&1 || true; fi
wait
