#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-run}"
[[ "$MODE" == run || "$MODE" == --check ]] || { echo "Usage: $0 [--check]" >&2; exit 2; }
for tool in node npm curl setsid; do command -v "$tool" >/dev/null; done
[[ -x "$ROOT_DIR/web/node_modules/.bin/vite" ]] || npm ci --prefix "$ROOT_DIR/web" --no-audit --no-fund
TEST_DIR="$(mktemp -d /tmp/harness-remote-codex-mobile.XXXXXX)"
DAEMON_PID=""
WEB_PID=""
cleanup() {
  trap - EXIT INT TERM HUP
  for pid in "$WEB_PID" "$DAEMON_PID"; do
    [[ -z "$pid" ]] || kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for _ in {1..30}; do
    local alive=0
    for pid in "$WEB_PID" "$DAEMON_PID"; do [[ -z "$pid" ]] || ! kill -0 -- "-$pid" 2>/dev/null || alive=1; done
    ((alive)) || break
    sleep 0.1
  done
  for pid in "$WEB_PID" "$DAEMON_PID"; do
    [[ -z "$pid" ]] || kill -KILL -- "-$pid" 2>/dev/null || true
    [[ -z "$pid" ]] || wait "$pid" 2>/dev/null || true
  done
  rm -rf -- "$TEST_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
mkdir -p "$TEST_DIR/projects/codex-mobile-sandbox" "$TEST_DIR/codex" "$TEST_DIR/data" "$TEST_DIR/native-state" "$TEST_DIR/bridge"
git -C "$TEST_DIR/projects/codex-mobile-sandbox" init -q
if [[ -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]]; then install -m 600 "${CODEX_HOME:-$HOME/.codex}/auth.json" "$TEST_DIR/codex/auth.json"; fi
for provider in opencode mimocode; do
  if [[ -f "${XDG_DATA_HOME:-$HOME/.local/share}/$provider/auth.json" ]]; then
    mkdir -p "$TEST_DIR/data/$provider"
    install -m 600 "${XDG_DATA_HOME:-$HOME/.local/share}/$provider/auth.json" "$TEST_DIR/data/$provider/auth.json"
  fi
done
read -r DAEMON_PORT WEB_PORT OPENCODE_PORT < <(node --input-type=module - <<'JS'
import net from 'node:net'
const servers = []
for (let i=0;i<3;i++) { const s=net.createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); servers.push(s) }
console.log(servers.map(s=>s.address().port).join(' '))
for (const s of servers) s.close()
JS
)
WEB_URL="http://127.0.0.1:$WEB_PORT"
npm --prefix "$ROOT_DIR/web" run build >"$TEST_DIR/build.log" 2>&1 || { cat "$TEST_DIR/build.log"; exit 1; }
# Remove only Codex desktop's private terminal PATH entry, reproducing a GUI launch.
TEST_PATH="$(node -e 'console.log(process.env.PATH.split(require("node:path").delimiter).filter(p=>p!=="/usr/lib/chatgpt/resources").join(require("node:path").delimiter))')"
(
  cd "$TEST_DIR/projects/codex-mobile-sandbox"
  exec setsid env PATH="$TEST_PATH" CODEX_HOME="$TEST_DIR/codex" XDG_DATA_HOME="$TEST_DIR/data" XDG_STATE_HOME="$TEST_DIR/native-state" \
    node "$ROOT_DIR/bridge/src/daemon-cli.js" --host 127.0.0.1 --port "$DAEMON_PORT" --opencode-port "$OPENCODE_PORT" \
    --username mobile-test --password local-mobile-test --state-dir "$TEST_DIR/bridge" --root "$TEST_DIR/projects" --cors "$WEB_URL"
) >"$TEST_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
setsid node "$ROOT_DIR/web/node_modules/vite/bin/vite.js" preview "$ROOT_DIR/web" --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$TEST_DIR/web.log" 2>&1 &
WEB_PID=$!
READY=0
for _ in {1..120}; do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null || ! kill -0 "$WEB_PID" 2>/dev/null; then cat "$TEST_DIR/daemon.log" "$TEST_DIR/web.log"; exit 1; fi
  if curl -fsS --max-time 1 -u mobile-test:local-mobile-test "http://127.0.0.1:$DAEMON_PORT/v1/machine" >"$TEST_DIR/machine.json" 2>/dev/null && curl -fsS --max-time 1 "$WEB_URL" >/dev/null 2>&1; then READY=1; break; fi
  sleep 0.25
done
(( READY )) || { cat "$TEST_DIR/daemon.log" "$TEST_DIR/web.log"; exit 1; }
node --input-type=module - "$TEST_DIR/machine.json" <<'JS'
import fs from 'node:fs'
const machine=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))
if (!Array.isArray(machine.agents) || !machine.machine?.id) throw Error('Invalid machine metadata')
console.log('Detected harnesses:', machine.agents.map(a=>a.id).join(', '))
console.log('Codex CLI detected:', machine.agents.some(a=>a.id==='codex'))
JS
cat <<TXT
Frontend: $WEB_URL
Machine name: Codex mobile test
Machine URL: http://127.0.0.1:$DAEMON_PORT
Username: mobile-test
Password: local-mobile-test
Project: codex-mobile-sandbox
Project path: $TEST_DIR/projects/codex-mobile-sandbox
Logs: $TEST_DIR

Checklist:
1. Add the machine with these details. At 375px, 390px and landscape widths open Machines.
   Actions must wrap; machine details and project folders must fill the row beneath them.
   Also check an unreachable machine (port 1), Retry, Edit and Remove; no horizontal overflow.
2. Open Nuova sessione, then choose Codex CLI in Coding agent. The harness filter above the
   session list only shows harnesses with existing sessions; it is not the installed-agent selector.
   This run starts with empty Codex and MiMo histories, so they appear there only after a session
   is created. Their previous sessions are not imported into this isolated environment.
   Load the model catalog and choose gpt-6-luna and a supported variant.
   Create a session in codex-mobile-sandbox, send a short prompt and verify the assistant response.
   Stop a running response, continue, reopen the session and verify history, then reload the app.
3. Repeat model selection, create/prompt, stop/continue and reopen for available harnesses:
   OpenCode 2: opencode/longcat-2.5-preview-free; OMP: openrouter/free;
   PI via OpenRouter: qwen/qwen3.8-27b:free; MiMo: openai/gpt-6-luna.
   If an approved model is absent, report it and do not substitute. Do not test Claude Code.
4. Check desktop Machines layout, pairing dialog open/close, and wrong-credentials errors.

State, Codex history and sandbox are isolated for this run. Exit stops only this script's processes.
TXT
[[ "$MODE" != --check ]] || exit 0
if [[ "${HARNESS_REMOTE_NO_BROWSER:-0}" != 1 ]]; then xdg-open "$WEB_URL" >/dev/null 2>&1 || true; fi
printf '%s\n' 'Keep this terminal open. Ctrl+C stops the test environment.'
wait -n "$DAEMON_PID" "$WEB_PID"
