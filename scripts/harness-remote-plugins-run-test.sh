#!/usr/bin/env bash
# Plugin system review for Harness Remote. All application state and processes belong to this script.
#
# Default: the app discovers the real native Sessions and coding agents, while Token Harness returns
# deterministic demo quota/savings and reads/writes a test-only routing HOME. No real Claude/Codex
# configuration is touched.
# --real: use the Token Harness CLI installed on this machine and the real machine data, while the
#         Harness Remote profile, daemon state and plugin state still live in the isolated test data.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST="$ROOT/.harnesstrim/plugins-run"
STATE="$TEST/state"
DEMO_HOME="$TEST/home"
DEMO_STATE="$TEST/token-harness"
LOGS="$STATE/logs"
FIXTURE="$ROOT/scripts/fixtures/token-harness-demo-cli.mjs"
REAL_STATE="${HARNESS_REMOTE_REAL_STATE:-}"
if [[ -z "$REAL_STATE" ]]; then
  for candidate in "$HOME/.config/harness-remote-web/embedded-daemon" "$HOME/.config/Harness Remote/embedded-daemon"; do
    if [[ -d "$candidate" ]]; then REAL_STATE="$candidate"; break; fi
  done
fi
MODE="demo"
CHECK=0
for argument in "$@"; do
  case "$argument" in
    --real) MODE="real" ;;
    --demo) MODE="demo" ;;
    --check) CHECK=1 ;;
    *) echo "Uso: $0 [--demo|--real] [--check]" >&2; exit 2 ;;
  esac
done
for name in node npm curl setsid flock; do
  command -v "$name" >/dev/null || { echo "Comando mancante: $name" >&2; exit 1; }
done
[[ -x "$FIXTURE" ]] || { echo "Fixture Token Harness mancante o non eseguibile: $FIXTURE" >&2; exit 1; }
mkdir -p "$STATE/desktop" "$DEMO_HOME" "$DEMO_STATE" "$LOGS"
exec 9>"$STATE/run.lock"
flock -n 9 || { echo "Il test Plugin è già aperto." >&2; exit 1; }

if [[ ! -d "$ROOT/node_modules" || ! -d "$ROOT/web/node_modules" ]]; then
  echo "Preparazione dipendenze…"
  npm install --no-audit --no-fund --prefix "$ROOT" >"$LOGS/install-root.log" 2>&1
  npm ci --no-audit --no-fund --prefix "$ROOT/web" >"$LOGS/install-web.log" 2>&1
fi


echo "Build app desktop…"
npm --prefix "$ROOT/web" run build:desktop >"$LOGS/build.log" 2>&1 || {
  cat "$LOGS/build.log" >&2
  exit 1
}

seed_routing() {
  local harness=$1
  HOME="$DEMO_HOME" HARNESS_REMOTE_DEMO_STATE="$DEMO_STATE" "$FIXTURE" plan --harness "$harness" --provider none --agent-routing --json >/dev/null
  HOME="$DEMO_HOME" HARNESS_REMOTE_DEMO_STATE="$DEMO_STATE" "$FIXTURE" apply --plan demo-plan-1 --yes --json >/dev/null
}

if [[ "$MODE" == "demo" ]]; then
  # Start each launch with both routing switches on, so the first interaction can turn one off.
  seed_routing claude
  seed_routing codex
fi

PIDS=()
test_runtime_pids() {
  # Match only Electron and Node processes. A plain `pgrep -f $STATE/desktop` also matches the shell
  # that happens to mention this path in its own command line, which is exactly how a cleanup can
  # kill its own terminal.
  ps -eo pid=,comm=,args= | awk -v dir="$STATE/desktop" '
    $2 == "electron" || $2 == "node" {
      if (index($0, dir)) print $1
    }'
}
kill_test_runtime() {
  local pid
  # Embedded daemons and harnesses may live in their own process groups. Kill the Electron/Node
  # process groups first; the daemon's detached group is found by the same private user-data path.
  for pid in $(test_runtime_pids); do
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $(test_runtime_pids); do
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    for ((i=0; i<30; i++)); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  kill_test_runtime
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if ((CHECK)); then
  echo "Plugin review ($MODE): build desktop pronta; sessioni reali da $HOME"
  [[ -n "$REAL_STATE" ]] && echo "Stato sessioni stabile: $REAL_STATE"
  exit 0
fi

# The stable app's daemon state owns the deleted-session and hidden-session indexes. Without it a
# fresh test profile rediscovers Sessions the user already deleted and reports a much larger count.
sync_real_state() {
  [[ -n "$REAL_STATE" && -d "$REAL_STATE" ]] || return 0
  local target="$STATE/desktop/embedded-daemon"
  local backup="$STATE/plugin-state-backup"
  rm -rf "$backup"
  if [[ -d "$target/plugins" ]]; then
    mkdir -p "$backup"
    cp -a "$target/plugins/." "$backup/"
  fi
  rm -rf "$target"
  mkdir -p "$STATE/desktop"
  cp -a "$REAL_STATE" "$target"
  if [[ -d "$backup" ]]; then
    mkdir -p "$target/plugins"
    cp -a "$backup/." "$target/plugins/"
  fi
  echo "Sincronizzato lo stato sessioni da $REAL_STATE"
}
sync_real_state

cat <<EOF
Plugin system — modalità $MODE
Codice: $ROOT
Stato Harness Remote: $STATE/desktop
Sessioni reali: $HOME
Stato sessioni stabile: ${REAL_STATE:-non trovato}
Home routing demo: $DEMO_HOME
Fixture CLI Token Harness: $FIXTURE
Log: $LOGS

Cosa provare
  1. La macchina deve risultare online e la lista Sessioni deve popolarsi con
     le sessioni native reali della macchina (non deve restare a 0).
  2. Apri una sessione Codex o Claude. Il chip quota mostra l'harness della
     sessione in uso e il suo residuo, per esempio "Codex 30%" oppure
     "Claude 82%". Su desktop è nella top bar; su telefono è nell'header della
     sessione. Con OpenCode/Pi/OMP il chip resta nascosto.
  3. Clicca il chip: il popover apre quel plugin con l'harness in uso evidenziato,
     le finestre 5h/settimanali, i risparmi e gli switch di routing.
  4. Attiva/disattiva il routing dell'harness in uso. Lo stato deve restare
     coerente dopo l'aggiornamento; in demo modifica solo $DEMO_HOME.
  5. Apri Impostazioni (ingranaggio) → Plugin → Token Harness.
     Qui trovi dashboard, routing, nota sugli optimizer e il pulsante
     "Apri Token Harness": in demo apre una pagina di prova nel browser; in
     --real apre il vero pannello Token Harness sulla macchina.
  6. Disattiva il plugin: chip e dashboard devono sparire. Riattivalo e devono
     tornare. La card riepilogativa non è più sopra la lista Sessioni.
  7. Senza sessione selezionata il pannello destro mostra la dashboard
     Token Harness; cambia la finestra dei risparmi (7/30/tutto) e verifica
     che il dettaglio si aggiorni.

EOF

if [[ "$MODE" == "demo" ]]; then
  cat <<EOF
Dati demo: quota Claude 82%, quota Codex 30%, risparmio esatto 599.9K token,
copertura 61%, routing iniziale ON per entrambi. Le sessioni e gli agenti sono
quelli reali della macchina; la CLI Token Harness demo e la configurazione di
routing sono isolate in $DEMO_HOME. Lo stato sessioni della release stabile
viene sincronizzato a ogni avvio.
Per il test reale:
  $0 --real

EOF
else
  cat <<EOF
Modalità reale: rileva il Token Harness installato sulla macchina e i suoi dati.
Harness Remote resta isolato in $STATE. Se la CLI è più vecchia di 0.1.34, il
pannello offre "Install newer copy": installa una copia gestita nei dati del
plugin, senza modificare quella di sistema. Attenzione: gli switch di routing,
se supportati dalla versione del harness, agiscono sulla configurazione reale
di Claude/Codex. Non eseguire turni con harness non autorizzati.

EOF
fi

cd "$ROOT"
if [[ "$MODE" == "demo" ]]; then
  echo "Avvio Electron…"
  setsid env -u ELECTRON_RUN_AS_NODE -u HARNESS_REMOTE_ACP_COMMAND -u HARNESS_REMOTE_ACP_ARGS \
    HARNESS_REMOTE_DEMO_STATE="$DEMO_STATE" \
    HARNESS_REMOTE_TOKEN_HARNESS_HOME="$DEMO_HOME" \
    HARNESS_REMOTE_TOKEN_HARNESS_PATH="$FIXTURE" \
    "$ROOT/web/node_modules/.bin/electron" "$ROOT/web" \
    --disable-gpu --user-data-dir="$STATE/desktop" >"$LOGS/electron.log" 2>&1 &
else
  echo "Avvio Electron…"
  setsid env -u ELECTRON_RUN_AS_NODE -u HARNESS_REMOTE_ACP_COMMAND -u HARNESS_REMOTE_ACP_ARGS \
    "$ROOT/web/node_modules/.bin/electron" "$ROOT/web" \
    --disable-gpu --user-data-dir="$STATE/desktop" >"$LOGS/electron.log" 2>&1 &
fi
PIDS+=("$!")
wait "${PIDS[-1]}"
