#!/usr/bin/env bash
# OpenCode 2 final-message sync test. All state and processes belong to this script.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST="$ROOT/.harnesstrim/opencode2-final-sync"
STATE="$TEST/state"
SANDBOX="$TEST/sandbox/final-sync-project"
XDG_DATA_HOME="$TEST/xdg-data"
XDG_CONFIG_HOME="$TEST/xdg-config"
XDG_CACHE_HOME="$TEST/xdg-cache"
ELECTRON_DATA="$STATE/electron"
LOGS="$STATE/logs"
CHECK=0
if [[ "${1:-}" == --check ]]; then CHECK=1; shift; fi
[[ $# == 0 ]] || { echo "Uso: $0 [--check]" >&2; exit 2; }

for name in node npm curl setsid flock git opencode2; do
  command -v "$name" >/dev/null || { echo "Comando mancante: $name" >&2; exit 1; }
done
[[ -x "$ROOT/web/node_modules/.bin/electron" ]] || {
  echo "Dipendenze web assenti. Esegui prima: npm --prefix \"$ROOT/web\" install" >&2
  exit 1
}

mkdir -p "$LOGS" "$SANDBOX" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_CACHE_HOME" "$ELECTRON_DATA"
exec 9>"$STATE/run.lock"
flock -n 9 || { echo "Il test OpenCode 2 finale è già aperto." >&2; exit 1; }

# A run starts from clean OpenCode and Electron state. The sandbox repository itself can be reused.
rm -rf "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$ELECTRON_DATA"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_CACHE_HOME" "$ELECTRON_DATA"

if [[ ! -d "$SANDBOX/.git" ]]; then
  git -C "$SANDBOX" init -q
  git -C "$SANDBOX" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' \
    commit --allow-empty -qm 'OpenCode 2 final sync sandbox'
fi

# Reuse the tester's provider configuration and credentials, but never their OpenCode data root.
for config in opencode.json opencode.jsonc; do
  if [[ -f "$HOME/.config/opencode/$config" && ! -f "$XDG_CONFIG_HOME/opencode/$config" ]]; then
    cp "$HOME/.config/opencode/$config" "$XDG_CONFIG_HOME/opencode/$config"
  fi
done
if [[ -f "$HOME/.local/share/opencode/auth.json" && ! -f "$XDG_DATA_HOME/opencode/auth.json" ]]; then
  mkdir -p "$XDG_DATA_HOME/opencode"
  cp "$HOME/.local/share/opencode/auth.json" "$XDG_DATA_HOME/opencode/auth.json"
fi
# Harness tests on this project use the always-on local LM Studio model (see AGENTS.md), never a
# free cloud model: a quota error (429) is not a sync failure and must not be confused with one.
LM_STUDIO_BASE_URL="${LM_STUDIO_BASE_URL:-http://127.0.0.1:1234/v1}"
LM_STUDIO_MODEL="${HARNESS_REMOTE_LM_STUDIO_MODEL:-spark-x2.5-4b}"
if [[ -z "${HARNESS_REMOTE_OPENCODE2_TEST_MODEL:-}" ]]; then
  curl -fsS --max-time 3 "$LM_STUDIO_BASE_URL/models" 2>/dev/null | grep -Fq "\"$LM_STUDIO_MODEL\"" || {
    echo "LM Studio non raggiungibile su $LM_STUDIO_BASE_URL o modello $LM_STUDIO_MODEL assente." >&2
    echo "Avvia LM Studio con il modello, oppure scegli esplicitamente HARNESS_REMOTE_OPENCODE2_TEST_MODEL=<provider/modello>." >&2
    exit 1
  }
  cat >"$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "localhost/$LM_STUDIO_MODEL",
  "provider": {
    "localhost": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio",
      "options": { "baseURL": "$LM_STUDIO_BASE_URL" },
      "models": {
        "$LM_STUDIO_MODEL": { "name": "$LM_STUDIO_MODEL (LM Studio)" }
      }
    }
  }
}
JSON
fi
export XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME

# The desktop-local runtime binds all interfaces only when LAN pairing was enabled before launch.
printf '{"lanPairing":true}\n' >"$ELECTRON_DATA/desktop-network-settings.json"

npm --prefix "$ROOT/web" run build:desktop >"$LOGS/build.log" 2>&1 || {
  cat "$LOGS/build.log" >&2; exit 1
}

CATALOG="$TEST/models.txt"
(cd "$SANDBOX" && opencode2 models --standalone) >"$CATALOG" 2>"$LOGS/models.log" || {
  cat "$LOGS/models.log" >&2
  echo "OpenCode 2 non ha potuto leggere il catalogo modelli." >&2
  exit 1
}
REQUESTED_MODEL="${HARNESS_REMOTE_OPENCODE2_TEST_MODEL:-}"
# An explicit model always wins, including a paid provider the tester trusts. Otherwise use LM Studio.
FIXTURE_MODEL="${REQUESTED_MODEL:-localhost/$LM_STUDIO_MODEL}"
grep -Fxq -- "$FIXTURE_MODEL" "$CATALOG" || {
  cat "$CATALOG" >&2
  echo "Il modello non è nel catalogo OpenCode 2 isolato: $FIXTURE_MODEL" >&2
  exit 1
}

# Build a long Session (more than one 200-message page) so the completion path exercises the same
# journal-page boundary that hid the final reply. No model call is made while creating it.
node --input-type=module - "$SANDBOX" "$FIXTURE_MODEL" "$STATE/fixture.json" <<'NODE'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const [directory, selectedModel, output] = process.argv.slice(2)
const hex26 = () => randomBytes(13).toString('hex')
const sessionID = `ses_${hex26()}`
const messageID = () => `msg_${hex26()}`
const [providerID, ...modelParts] = selectedModel.split('/')
const modelID = modelParts.join('/')
const model = { providerID, id: modelID, variant: 'default' }
const now = Date.now()
const TURNS = 30
const STEPS = 8
// Keep every fixture turn in the past: the tester's new prompt must sort after the whole fixture.
const historyStart = now - TURNS * 10_000 - 60_000
const messages = []
for (let turn = 1; turn <= TURNS; turn += 1) {
  const created = historyStart + turn * 10_000
  messages.push({
    id: messageID(), type: 'user', time: { created },
    text: `Fixture prompt ${turn}. Keep this history and answer only the newest request.`
  })
  for (let step = 1; step <= STEPS; step += 1) {
    const at = created + step
    messages.push({
      id: messageID(), type: 'assistant', time: { created: at, completed: at },
      agent: 'build', model,
      tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0, finish: step === STEPS ? 'stop' : 'tool-calls',
      snapshot: { start: '', end: '' },
      content: [{ type: 'text', text: `Fixture answer ${turn}, step ${step}.`, time: { created: at, completed: at } }]
    })
  }
}
const exported = {
  info: {
    id: sessionID,
    projectID: 'global',
    title: 'HR OpenCode 2 — final sync (30 turns)',
    version: '2.1.4',
    agent: 'build',
    model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: historyStart, updated: historyStart + TURNS * 10_000 + STEPS },
    subpath: '',
    location: { directory }
  },
  messages
}
await writeFile(output, JSON.stringify(exported))
console.log(sessionID)
NODE

SESSION_ID="$(node --input-type=module - "$STATE/fixture.json" <<'NODE'
import fs from 'node:fs'
console.log(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).info.id)
NODE
)"
(cd "$SANDBOX" && opencode2 session import --standalone --directory "$SANDBOX" "$STATE/fixture.json") \
  >"$LOGS/import.log" 2>&1 || {
  cat "$LOGS/import.log" >&2
  echo "Import della Session fixture fallito." >&2
  exit 1
}

PIDS=()
LAUNCHER_PID=""
LAST_PID=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    for ((i=0; i<40; i++)); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  # Electron's embedded daemon deliberately detaches into its own process group. Stop only the
  # instance that uses this test's private state directory.
  pkill -TERM -f -- "--state-dir $ELECTRON_DATA/embedded-daemon" 2>/dev/null || true
  sleep 0.5
  pkill -KILL -f -- "--state-dir $ELECTRON_DATA/embedded-daemon" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

start_group() {
  local logfile="$1"; shift
  local pidfile="$STATE/process-group-${RANDOM}.pid"
  setsid bash -c 'echo "$$" > "$1"; shift; exec "$@"' bash "$pidfile" "$@" >"$logfile" 2>&1 &
  LAUNCHER_PID=$!
  for _ in {1..80}; do [[ -s "$pidfile" ]] && break; sleep 0.02; done
  [[ -s "$pidfile" ]] || { echo "Impossibile identificare il gruppo di processi del test." >&2; return 1; }
  LAST_PID="$(<"$pidfile")"
  PIDS+=("$LAST_PID")
}

if [[ -n "$REQUESTED_MODEL" ]]; then
  MODEL_NOTE="Modello richiesto via HARNESS_REMOTE_OPENCODE2_TEST_MODEL."
else
  MODEL_NOTE="Modello locale LM Studio ($LM_STUDIO_BASE_URL), senza quota cloud."
fi
cat <<EOF
OpenCode 2 — sincronizzazione del messaggio finale
Sorgente: $ROOT
Sandbox: $SANDBOX
Session fixture: $SESSION_ID (30 turni, 240 messaggi)
Modello fixture: $FIXTURE_MODEL
$MODEL_NOTE
Per cambiare modello: HARNESS_REMOTE_OPENCODE2_TEST_MODEL=<provider/modello> $0

LAN pairing: attivo su questa istanza Electron di test.
1. Apri Electron e controlla che il progetto sandbox compaia sotto This computer → OpenCode 2.
2. Apri la Session «HR OpenCode 2 — final sync (30 turns)».
3. Sul telefono apri Harness Remote, aggiungi la macchina con il QR di This computer (Machines → This computer → pairing) e apri la stessa Session.
4. Invia dalla Session sul telefono (o dal desktop mentre l'APK resta aperto) un prompt breve, per esempio:
   Reply with exactly OPENCODE2-FINAL-SYNC-OK
5. Lascia l'APK sulla Session mentre il turno finisce. Atteso: la risposta finale compare, l'Activity smette di girare e lo stato diventa Ready. I 30 turni rendono la pagina journal più corta della Session: era il caso in cui il messaggio finale restava invisibile.
6. Cambia Session e torna indietro, poi ricarica l'APK: la risposta finale deve restare visibile e non devono comparire prompt duplicati.

Chiudendo Electron o premendo Ctrl+C lo script ferma solo i propri processi. Log: $LOGS
EOF

if ((CHECK)); then
  if command -v xvfb-run >/dev/null 2>&1; then
    start_group "$LOGS/electron-check.log" xvfb-run -a env -u ELECTRON_RUN_AS_NODE \
      HARNESS_REMOTE_ROOT="$SANDBOX" HARNESS_REMOTE_BACKEND=opencode2 \
      "$ROOT/web/node_modules/.bin/electron" "$ROOT/web" --user-data-dir="$ELECTRON_DATA" --disable-gpu
    APP_PID="$LAST_PID"
    alive=1
    for _ in {1..80}; do
      if ! kill -0 -- "-$APP_PID" 2>/dev/null; then alive=0; break; fi
      sleep 0.1
    done
    ((alive)) || { cat "$LOGS/electron-check.log" >&2; echo "Electron si è chiuso prima del controllo di avvio." >&2; exit 1; }
    echo "--check: build, fixture OpenCode 2 e avvio Electron completati."
    exit 0
  fi
  echo "--check: build e fixture pronti; xvfb-run assente, avvio Electron saltato."
  exit 0
fi

cd "$SANDBOX"
start_group "$LOGS/electron.log" env -u ELECTRON_RUN_AS_NODE \
  HARNESS_REMOTE_ROOT="$SANDBOX" HARNESS_REMOTE_BACKEND=opencode2 \
  "$ROOT/web/node_modules/.bin/electron" "$ROOT/web" --user-data-dir="$ELECTRON_DATA"
wait "$LAUNCHER_PID"
