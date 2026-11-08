#!/usr/bin/env bash
# DeepSeek Harness in the actual Harness Remote Electron desktop app, with isolated state.
#
# The app runs the embedded bridge daemon, the bridge launches the real `dsh-acp` adapter, and the
# adapter starts its bundled DeepSeek Harness runtime. DSH_HOME is isolated from ~/.dsh so the test
# never lists or edits the daily DeepSeek sessions; only the credentials and provider profiles are
# copied in. The adapter and its extracted runtime live under .harnesstrim/deepseek to keep the rest
# of the machine untouched.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST="$ROOT/.harnesstrim/deepseek"
ADAPTER="$TEST/adapter"
STATE="$TEST/state"
DESKTOP="$STATE/desktop"
DSH_HOME="$STATE/dsh-home"
DSH_CACHE="$TEST/dsh-cache"
BIN="$TEST/bin"
PROJECT="$TEST/sandbox/DeepSeek-Harness"
LOGS="$STATE/logs"
MODE="${1:-}"
[[ -z "$MODE" || "$MODE" == --check ]] || { echo "Uso: $0 [--check]" >&2; exit 2; }
[[ $# -le 1 ]] || { echo "Uso: $0 [--check]" >&2; exit 2; }

for name in node npm flock git setsid ps tr cp mkdir find readlink install; do
  command -v "$name" >/dev/null || { echo "Comando mancante: $name" >&2; exit 1; }
done
[[ -f "$ROOT/bridge/src/harness-profiles.js" && -f "$ROOT/bridge/src/daemon-cli.js" ]] || {
  echo "Sorgente Harness Remote incompleta in $ROOT." >&2; exit 1;
}
[[ -x "$ROOT/web/node_modules/.bin/electron" ]] || {
  echo "Dipendenze web/Electron mancanti; installa web prima di eseguire il test." >&2; exit 1;
}
[[ -f "$HOME/.dsh/.credentials.yaml" ]] || {
  echo "Credenziali DeepSeek non trovate in ~/.dsh/.credentials.yaml." >&2
  echo "Accedi prima con DeepSeek Harness, oppure copia qui un DSH_HOME già autenticato." >&2
  exit 1
}

mkdir -p "$LOGS" "$DESKTOP" "$BIN" "$DSH_HOME" "$DSH_CACHE" "$ADAPTER" "$PROJECT"
exec 9>"$STATE/run.lock"
flock -n 9 || { echo "Il test DeepSeek è già aperto." >&2; exit 1; }

if [[ ! -d "$PROJECT/.git" ]]; then
  git -C "$PROJECT" init -q
  git -C "$PROJECT" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' \
    commit --allow-empty -qm 'DeepSeek Harness test sandbox'
fi
if [[ ! -f "$PROJECT/README.md" ]]; then
  cat >"$PROJECT/README.md" <<'EOF'
# DeepSeek Harness test sandbox

This repository belongs to an isolated Harness Remote manual test.
Ask the agent to read this file, list the directory, or create a small file here.
EOF
fi

echo "Preparo il profilo DeepSeek isolato in $STATE…"
# Copy only identity/provider material. Sessions stay out: the sandbox must not expose or modify
# the daily ~/.dsh sessions, and a fresh list makes the manual checks unambiguous.
install -m 600 "$HOME/.dsh/.credentials.yaml" "$DSH_HOME/.credentials.yaml"
for item in .anonymous-user-id profiles settings.yaml.imported; do
  [[ -e "$HOME/.dsh/$item" ]] || continue
  rm -rf -- "$DSH_HOME/$item"
  cp -a -- "$HOME/.dsh/$item" "$DSH_HOME/$item"
done

if [[ ! -x "$ADAPTER/node_modules/.bin/dsh-acp" ]]; then
  echo "Installo @openma/deepseek-harness-acp@0.4.40 in $ADAPTER…"
  npm install --prefix "$ADAPTER" --no-audit --no-fund --loglevel=error \
    @openma/deepseek-harness-acp@0.4.40 >"$LOGS/adapter-install.log" 2>&1 || {
      cat "$LOGS/adapter-install.log" >&2; exit 1;
    }
fi
ln -sfn "$(readlink -f "$ADAPTER/node_modules/.bin/dsh-acp")" "$BIN/dsh-acp"

cache_ready() {
  [[ -n "$(find "$DSH_CACHE" -maxdepth 2 -name .dsh-acp-runtime -print -quit)" ]]
}
if ! cache_ready; then
  echo "Estraggo il runtime DeepSeek nel cache isolato (prima volta, circa 1 GB)…"
fi
echo "Verifico l'avvio dell'adattatore DeepSeek…"
if ! PATH="$BIN:$PATH" DSH_HOME="$DSH_HOME" DSH_ACP_CACHE_DIR="$DSH_CACHE" NO_BROWSER=1 \
    PREWARM_ACP_CLIENT="$ROOT/bridge/src/acp-client.js" \
    node --input-type=module >"$LOGS/prewarm.log" 2>&1 <<'JS'
import { pathToFileURL } from "node:url"
const { AcpClient } = await import(pathToFileURL(process.env.PREWARM_ACP_CLIENT).href)
const client = new AcpClient({ command: "dsh-acp", args: [], permissionMode: "allow" })
try {
  await client.start(180_000)
  console.log(`dsh-acp ${client.agentInfo?.version ?? "ready"}`)
} finally {
  await client.close().catch(() => undefined)
}
JS
then
  cat "$LOGS/prewarm.log" >&2
  echo "Il runtime DeepSeek non si è avviato." >&2
  exit 1
fi
cache_ready || {
  cat "$LOGS/prewarm.log" >&2
  echo "Cache del runtime DeepSeek incompleta." >&2
  exit 1
}

echo "Compilo la vera app desktop Electron…"
npm --prefix "$ROOT/web" run build:desktop >"$LOGS/build-electron.log" 2>&1 || {
  cat "$LOGS/build-electron.log" >&2; exit 1;
}
[[ -f "$ROOT/web/dist/index.html" && -f "$ROOT/web/dist-electron/electron/main.js" ]] || {
  echo "Build Electron incompleta." >&2; exit 1;
}

if [[ "$MODE" == --check ]]; then
  echo "DeepSeek: adattatore, runtime, credenziali, build Electron e progetto pronti."
  echo "Progetto sandbox: $PROJECT"
  exit 0
fi

# The desktop app's own minimum outer width is 420 px. Seed an isolated window state so the
# DeepSeek controls are comfortable on first launch instead of relying on the previous profile.
if [[ ! -f "$DESKTOP/window-state.json" ]]; then
  printf '%s\n' '{"width":1280,"height":900,"maximized":false}' >"$DESKTOP/window-state.json"
fi

cat <<EOF
DeepSeek Harness — vera app desktop Electron, stato isolato
Profilo Electron: $DESKTOP
DSH_HOME isolato: $DSH_HOME
Adattatore: $BIN/dsh-acp (dsh-acp 0.4.40)
Progetto sandbox: $PROJECT
Macchina: "Questo computer" (daemon integrato; nessun URL o credenziale da digitare)

Apri il selettore di harness/agente della macchina locale e scegli DeepSeek Harness.
I modelli disponibili sono DeepSeek Flash (deepseek-official::deepseek-flash) e
DeepSeek V4 Pro (deepseek-official::deepseek-v4-pro), con Effort separato.

Checklist:
  1. Aggiorna i modelli: devono comparire Flash e V4 Pro (non un modello OpenCode).
  2. Crea una Native Session nel progetto sandbox: non deve apparire alcun timeout.
  Dopo aver concordato il modello per i test reali con Giulio:
  3. Seleziona quel modello ed Effort low. Chiedi: "Leggi README.md e dimmi in
     una riga cosa contiene." Verifica streaming, lettura e risposta finale.
  4. Se autorizzato anche V4 Pro, passa a V4 Pro ed Effort high, poi chiedi:
     "Rispondi con la parola DEEPSEEK e l'elenco dei file correnti."
     Verifica che il turno usi il nuovo modello senza aprire un'altra sessione.
  5. Avvia un turno più lungo (es. "Elenca e spiega ogni file del progetto, poi crea
     NOTE.md con un riassunto") e premi Stop: il turno deve fermarsi e la sessione
     restare utilizzabile. Invia poi un nuovo prompt.
  6. Durante un turno invia un secondo prompt: deve essere trattato come steering,
     non messo in coda. Se il turno è appena finito, deve partire come nuovo turno
     senza perdere il testo (promptRequired).
  7. Rinomina la sessione, chiudi e riapri l'app: deve comparire nell'elenco native
     con il nuovo nome, apribile e con la trascrizione completa. Prova anche Elimina.
  8. Torna a OpenCode Legacy e verifica che una sessione normale e il model picker
     continuino a funzionare. Se Codex Luna è disponibile, ripeti la prova anche lì.

Non avviare turni Claude Code. I modelli DeepSeek eseguono inferenza a pagamento:
usa il test solo dopo l'autorizzazione esplicita di Giulio.

Chiudi la finestra o premi Ctrl+C per fermare solo questo test.
Log Electron: $LOGS/electron.log
Log adattatore/prewarm: $LOGS/prewarm.log
EOF

app_pid=''
cleanup() {
  trap - EXIT INT TERM HUP
  local proc command_line daemon_pid daemon_group
  local -a daemon_groups=()
  # The desktop app launches its embedded daemon in a different process group.
  # Match both this source checkout and this isolated profile before signalling it.
  for proc in /proc/[0-9]*/cmdline; do
    [[ -r "$proc" ]] || continue
    command_line="$(tr '\0' ' ' <"$proc" 2>/dev/null)" || continue
    [[ "$command_line" == *"$ROOT/bridge/src/daemon-cli.js"* ]] || continue
    [[ "$command_line" == *"--state-dir $DESKTOP/embedded-daemon"* ]] || continue
    daemon_pid="${proc#/proc/}"
    daemon_pid="${daemon_pid%/cmdline}"
    daemon_group="$(ps -o pgid= -p "$daemon_pid" | tr -d ' ')" || continue
    [[ -n "$daemon_group" && "$daemon_group" != "$app_pid" ]] && daemon_groups+=("$daemon_group")
  done
  if [[ -n "$app_pid" ]]; then
    kill -TERM -- "-$app_pid" 2>/dev/null || true
  fi
  for daemon_group in "${daemon_groups[@]}"; do kill -TERM -- "-$daemon_group" 2>/dev/null || true; done
  for ((i=0; i<30; i++)); do
    local alive=0
    if [[ -n "$app_pid" ]] && kill -0 -- "-$app_pid" 2>/dev/null; then alive=1; fi
    for daemon_group in "${daemon_groups[@]}"; do
      kill -0 -- "-$daemon_group" 2>/dev/null && alive=1
    done
    (( alive == 0 )) && break
    sleep 0.1
  done
  [[ -z "$app_pid" ]] || kill -KILL -- "-$app_pid" 2>/dev/null || true
  for daemon_group in "${daemon_groups[@]}"; do kill -KILL -- "-$daemon_group" 2>/dev/null || true; done
  [[ -z "$app_pid" ]] || wait "$app_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# The embedded daemon inherits this environment. PATH makes the preinstalled adapter visible to
# `resolveAcpLaunch`, avoiding a second large npx extraction on machines with little free space.
# DSH_HOME/CACHE keep the runtime's sessions and extraction isolated.
# HARNESS_REMOTE_ROOT controls the local machine's project roots so only the sandbox is offered.
setsid env -u ELECTRON_RUN_AS_NODE -u HARNESS_REMOTE_BACKEND \
  -u HARNESS_REMOTE_ACP_COMMAND -u HARNESS_REMOTE_ACP_ARGS \
  PATH="$BIN:$PATH" \
  HARNESS_REMOTE_ROOT="$PROJECT" \
  DSH_HOME="$DSH_HOME" \
  DSH_ACP_CACHE_DIR="$DSH_CACHE" \
  NO_BROWSER=1 \
  "$ROOT/web/node_modules/.bin/electron" "$ROOT/web" \
  --disable-gpu --user-data-dir="$DESKTOP" >"$LOGS/electron.log" 2>&1 &
app_pid=$!
wait "$app_pid"
