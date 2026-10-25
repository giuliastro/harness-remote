#!/usr/bin/env bash
# Open the branch Electron app against real OpenCode data, for read-only regression checks.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST="$ROOT/.harnesstrim/plugins-history-electron"
STATE="$TEST/state"
LOGS="$STATE/logs"
ELECTRON_DATA="$STATE/electron"
CHECK=0
if [[ "${1:-}" == --check ]]; then CHECK=1; shift; fi
[[ $# == 0 ]] || { echo "Uso: $0 [--check]" >&2; exit 2; }

for name in node npm setsid flock; do
  command -v "$name" >/dev/null || { echo "Comando mancante: $name" >&2; exit 1; }
done
[[ -x "$ROOT/web/node_modules/.bin/electron" ]] || {
  echo "Dipendenze web assenti. Esegui: npm --prefix \"$ROOT/web\" install" >&2
  exit 1
}
[[ -d "$HOME/.local/share/opencode" ]] || {
  echo "OpenCode data non trovati in $HOME/.local/share/opencode" >&2
  exit 1
}

mkdir -p "$LOGS" "$ELECTRON_DATA"
exec 9>"$STATE/run.lock"
flock -n 9 || { echo "Il test Electron con dati reali è già aperto." >&2; exit 1; }

npm --prefix "$ROOT/web" run build:desktop >"$LOGS/build.log" 2>&1 || {
  cat "$LOGS/build.log" >&2; exit 1
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
  [[ -s "$pidfile" ]] || { echo "Impossibile identificare il gruppo di processi." >&2; return 1; }
  LAST_PID="$(<"$pidfile")"
  PIDS+=("$LAST_PID")
}

cat <<EOF
Harness Remote — Electron dal branch, dati OpenCode reali
Sorgente: $ROOT
Root visibile: $HOME/Software/harness-remote-plugin-system
Profilo Electron isolato: $ELECTRON_DATA
Log: $LOGS

Questo NON è l'app installata in /opt/Harness Remote: quella contiene ancora il bridge vecchio.
1. Apri This computer → OpenCode 2.
2. Apri «Sistema plugin per Harness Remote».
3. Atteso: la cronologia recente compare, senza «Server response is too large».
4. Se la Session è lunga, «Earlier messages» carica i turni precedenti.

Chiudendo Electron o premendo Ctrl+C lo script ferma solo i propri processi.
EOF

start_group "$LOGS/electron.log" env -u ELECTRON_RUN_AS_NODE \
  HARNESS_REMOTE_ROOT="$HOME/Software/harness-remote-plugin-system" \
  "$ROOT/web/node_modules/.bin/electron" "$ROOT/web" --user-data-dir="$ELECTRON_DATA"

if ((CHECK)); then
  sleep 8
  if kill -0 -- "-$LAST_PID" 2>/dev/null; then
    echo "--check: build e avvio Electron completati."
    exit 0
  fi
  cat "$LOGS/electron.log" >&2
  echo "Electron si è chiuso durante il controllo." >&2
  exit 1
fi

wait "$LAUNCHER_PID"
