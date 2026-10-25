#!/usr/bin/env bash
# Plugin system review for Harness Remote. All application state and processes belong to this script.
#
# Default: deterministic Token Harness demo data in an isolated HOME, so every dashboard, quota,
# setting and routing toggle can be exercised without touching the real Claude/Codex configuration.
# --real: use the Token Harness CLI installed on this machine and the real machine data, while the
#         Harness Remote profile, daemon state and plugin state still live in the isolated test data.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST="$ROOT/.harnesstrim/plugins-run"
STATE="$TEST/state"
DEMO_HOME="$TEST/home"
DEMO_STATE="$TEST/token-harness"
PROJECT="$TEST/sandbox/source-project"
LOGS="$STATE/logs"
FIXTURE="$ROOT/scripts/fixtures/token-harness-demo-cli.mjs"
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
for name in node npm curl setsid flock git; do
  command -v "$name" >/dev/null || { echo "Comando mancante: $name" >&2; exit 1; }
done
[[ -x "$FIXTURE" ]] || { echo "Fixture Token Harness mancante o non eseguibile: $FIXTURE" >&2; exit 1; }
mkdir -p "$STATE/desktop" "$DEMO_HOME" "$DEMO_STATE" "$PROJECT" "$LOGS"
exec 9>"$STATE/run.lock"
flock -n 9 || { echo "Il test Plugin è già aperto." >&2; exit 1; }

if [[ ! -d "$ROOT/node_modules" || ! -d "$ROOT/web/node_modules" ]]; then
  echo "Preparazione dipendenze…"
  npm install --no-audit --no-fund --prefix "$ROOT" >"$LOGS/install-root.log" 2>&1
  npm ci --no-audit --no-fund --prefix "$ROOT/web" >"$LOGS/install-web.log" 2>&1
fi

if [[ ! -d "$PROJECT/.git" ]]; then
  git -C "$PROJECT" init -q
  git -C "$PROJECT" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm 'Plugin test sandbox'
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
kill_test_runtime() {
  local pid
  # Embedded daemons and harnesses may live in their own process groups. The app's private user-data
  # directory is the one identifier every process in this run shares, so terminate by that rather
  # than trusting a single parent pid.
  for pid in $(pgrep -f -- "$STATE/desktop" 2>/dev/null || true); do
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $(pgrep -f -- "$STATE/desktop" 2>/dev/null || true); do
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
  echo "Plugin review ($MODE): build desktop pronta; progetto $PROJECT"
  exit 0
fi

cat <<EOF
Plugin system — modalità $MODE
Codice: $ROOT
Stato Harness Remote: $STATE/desktop
Sandbox: $PROJECT
Fixture CLI Token Harness: $FIXTURE
Log: $LOGS

Cosa provare
  1. Top bar: chip "30% Allowance" (demo) accanto allo stato macchine. Cliccalo.
     Il popover mostra Claude Code 82% e Codex 30%, risparmi locali, grafico e
     gli switch di routing automatico.
  2. Attiva/disattiva il routing Codex. Lo switch deve restare coerente dopo
     l'aggiornamento; in demo modifica solo $DEMO_HOME.
  3. Apri Impostazioni (ingranaggio) → Plugin → Token Harness.
     Qui trovi lista, dettaglio, dashboard, diagnostica e impostazioni.
  4. Disattiva il plugin. Chip, card nel rail e dashboard devono sparire.
     Riattivalo e devono tornare.
  5. Chiudi la sessione aperta (o avvia l'app senza selezionare sessioni):
     il pannello destro mostra la piccola dashboard Token Harness.
  6. Cambia la finestra dei risparmi (7 giorni / 30 giorni / tutto) e verifica
     che il dettaglio dei risparmi si aggiorni.

EOF

if [[ "$MODE" == "demo" ]]; then
  cat <<EOF
Dati demo: quota Claude 82%, quota Codex 30%, risparmio esatto 599.9K token,
copertura 61%, routing iniziale ON per entrambi. Nessun file reale viene toccato.
Per il test reale:
  $0 --real

EOF
else
  cat <<EOF
Modalità reale: rileva il Token Harness installato sulla macchina e i suoi dati.
Harness Remote resta isolato in $STATE. Se la CLI è più vecchia di 0.1.32, il
pannello offre "Install newer copy": installa una copia gestita nei dati del
plugin, senza modificare quella di sistema. Attenzione: gli switch di routing,
se supportati dalla versione del harness, agiscono sulla configurazione reale
di Claude/Codex. Non eseguire turni con harness non autorizzati.

EOF
fi

cd "$PROJECT"
if [[ "$MODE" == "demo" ]]; then
  echo "Avvio Electron…"
  setsid env -u ELECTRON_RUN_AS_NODE -u HARNESS_REMOTE_ACP_COMMAND -u HARNESS_REMOTE_ACP_ARGS \
    HOME="$DEMO_HOME" \
    HARNESS_REMOTE_DEMO_STATE="$DEMO_STATE" \
    HARNESS_REMOTE_TOKEN_HARNESS_PATH="$FIXTURE" \
    HARNESS_REMOTE_ROOT="$PROJECT" \
    "$ROOT/web/node_modules/.bin/electron" "$ROOT/web" \
    --disable-gpu --user-data-dir="$STATE/desktop" >"$LOGS/electron.log" 2>&1 &
else
  echo "Avvio Electron…"
  setsid env -u ELECTRON_RUN_AS_NODE -u HARNESS_REMOTE_ACP_COMMAND -u HARNESS_REMOTE_ACP_ARGS \
    HARNESS_REMOTE_ROOT="$PROJECT" \
    "$ROOT/web/node_modules/.bin/electron" "$ROOT/web" \
    --disable-gpu --user-data-dir="$STATE/desktop" >"$LOGS/electron.log" 2>&1 &
fi
PIDS+=("$!")
wait "${PIDS[-1]}"
