#!/usr/bin/env bash
# Manual issue 681 test in the real Harness Remote Electron desktop app.
# The desktop profile, embedded daemon state, HOME/XDG roots and sandbox project are isolated.
# --check builds and starts Electron plus its embedded daemon, verifies the sandbox endpoint, then exits.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST="$ROOT/.harnesstrim/issue-681"
SANDBOX="$TEST/sandbox/Antigravity-ACP"
STATE="$TEST/state"
PROFILE="$STATE/desktop"
NATIVE="$STATE/native"
DATA="$NATIVE/data"
STATE_DIR="$NATIVE/state"
CACHE="$NATIVE/cache"
BIN="$TEST/bin"
LOGS="$STATE/logs"
MODE="${1:-}"
[[ -z "$MODE" || "$MODE" == --check || "$MODE" == --login ]] || { echo "Uso: $0 [--check|--login]" >&2; exit 2; }
[[ $# -le 1 ]] || { echo "Uso: $0 [--check|--login]" >&2; exit 2; }

for name in node npm git setsid flock cp mkdir rm tr ps sleep readlink id awk install chmod; do
  command -v "$name" >/dev/null 2>&1 || { echo "Comando mancante: $name" >&2; exit 1; }
done
[[ -f "$ROOT/bridge/src/daemon-cli.js" && -f "$ROOT/web/electron/main.ts" ]] || {
  echo "Sorgente Harness Remote incompleta in $ROOT." >&2; exit 1;
}
[[ "$MODE" == --login || -x "$ROOT/web/node_modules/.bin/electron" ]] || {
  echo "Dipendenze web/Electron mancanti in $ROOT/web/node_modules." >&2
  echo "Esegui npm ci --prefix '$ROOT/web' e rilancia questo script." >&2
  exit 1
}
if [[ -z "$MODE" && -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  echo "Per la finestra desktop serve una sessione grafica (DISPLAY o WAYLAND_DISPLAY)." >&2
  echo "Usa --check per verificare l'avvio in un display virtuale senza login o modelli." >&2
  exit 1
fi

mkdir -p "$SANDBOX" "$PROFILE" "$DATA" "$STATE_DIR" "$CACHE" "$STATE/tmp" "$BIN" "$LOGS"
exec 9>"$STATE/run.lock"
flock -n 9 || { echo "Il test issue 681 è già aperto." >&2; exit 1; }

AGY_HOST_COMMAND="$(command -v agy || true)"
if [[ -z "$AGY_HOST_COMMAND" && -x "$HOME/.local/bin/agy" ]]; then
  AGY_HOST_COMMAND="$HOME/.local/bin/agy"
fi
if [[ "$MODE" == --login ]]; then
  [[ -n "$AGY_HOST_COMMAND" ]] || { echo "agy non trovato; installa Antigravity CLI prima del login." >&2; exit 1; }
  exec env HOME="$NATIVE" XDG_DATA_HOME="$DATA" XDG_STATE_HOME="$STATE_DIR" \
    XDG_CACHE_HOME="$CACHE" XDG_CONFIG_HOME="$NATIVE/.config" "$AGY_HOST_COMMAND" acp --login
fi

# Preserve manual test artifacts across launches.
if ! git -C "$SANDBOX" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$SANDBOX" init -q
  git -C "$SANDBOX" -c user.name='Harness Remote issue 681 Test' \
    -c user.email='test@example.invalid' commit --allow-empty -qm 'Antigravity ACP test sandbox'
fi
if [[ ! -f "$SANDBOX/README.md" ]]; then
  cat >"$SANDBOX/README.md" <<'EOF'
# Google Antigravity ACP test sandbox

Isolated project for the Harness Remote issue 681 manual test.
Use this project for a new Antigravity session after its model is approved.
EOF
fi

TMP_ROOT="$(mktemp -d "$STATE/tmp/issue-681.XXXXXX")"
BOOTSTRAP="$ROOT/web/.issue-681-bootstrap-$$.cjs"
APP_PID=""
DAEMON_PID=""
DAEMON_START_TICKS=""
LOG="$LOGS/electron.log"
READY="$TMP_ROOT/renderer-ready"
DAEMON_PID_FILE="$TMP_ROOT/daemon.pid"

daemon_is_ours() {
  [[ "${DAEMON_PID:-}" =~ ^[1-9][0-9]*$ && -n "${DAEMON_START_TICKS:-}" ]] || return 1
  [[ -r "/proc/$DAEMON_PID/stat" && -r "/proc/$DAEMON_PID/cmdline" ]] || return 1
  local ticks cmdline
  ticks="$(awk '{print $22}' "/proc/$DAEMON_PID/stat" 2>/dev/null || true)"
  cmdline="$(tr '\0' ' ' <"/proc/$DAEMON_PID/cmdline" 2>/dev/null || true)"
  [[ "$ticks" == "$DAEMON_START_TICKS" && "$cmdline" == *"$ROOT/bridge/src/daemon-cli.js"* && \
    "$cmdline" == *"--state-dir $PROFILE/embedded-daemon"* ]]
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  local group pid
  if [[ "${APP_PID:-}" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM -- "-$APP_PID" 2>/dev/null || true
  fi
  if daemon_is_ours; then
    group="$(ps -o pgid= -p "$DAEMON_PID" 2>/dev/null | tr -d ' ' || true)"
    [[ -z "$group" ]] || kill -TERM -- "-$group" 2>/dev/null || true
  fi
  for _ in {1..50}; do
    local alive=0
    if [[ "${APP_PID:-}" =~ ^[1-9][0-9]*$ ]] && kill -0 "$APP_PID" 2>/dev/null; then alive=1; fi
    if daemon_is_ours; then alive=1; fi
    ((alive == 0)) && break
    sleep 0.1
  done
  if daemon_is_ours; then
    group="$(ps -o pgid= -p "$DAEMON_PID" 2>/dev/null | tr -d ' ' || true)"
    [[ -z "$group" ]] || kill -KILL -- "-$group" 2>/dev/null || true
  fi
  if [[ "${APP_PID:-}" =~ ^[1-9][0-9]*$ ]]; then
    kill -KILL -- "-$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  [[ -z "$BOOTSTRAP" ]] || rm -f -- "$BOOTSTRAP"
  [[ -z "$TMP_ROOT" ]] || rm -rf -- "$TMP_ROOT"
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

echo "Compilo renderer e main process Electron…"
npm --prefix "$ROOT/web" run build:desktop >"$LOGS/build.log" 2>&1 || {
  cat "$LOGS/build.log" >&2; exit 1;
}
[[ -f "$ROOT/web/dist/index.html" && -f "$ROOT/web/dist-electron/electron/main.js" ]] || {
  echo "Build desktop incompleta." >&2; exit 1;
}

# Expose the installed Antigravity CLI to the isolated process only when it is present. Its auth
# remains untouched and is intentionally not copied into the test profile.
if [[ -n "$AGY_HOST_COMMAND" ]]; then
  ln -sfn "$(readlink -f "$AGY_HOST_COMMAND")" "$BIN/agy"
fi

cat >"$BOOTSTRAP" <<'JS'
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

app.setPath('userData', process.env.ISSUE_681_PROFILE)
app.setPath('sessionData', process.env.ISSUE_681_PROFILE + '/session')
process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitForRuntime() {
  const deadline = Date.now() + 45_000
  let last = null
  while (Date.now() < deadline && !app.isQuitting) {
    const win = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
    if (win && !win.webContents.isLoading()) {
      try {
        last = await win.webContents.executeJavaScript(`(async () => {
          if (!window.harnessDesktop) return { renderer: false }
          return { renderer: true, runtime: await window.harnessDesktop.getLocalRuntimeState() }
        })()`)
        if (last.runtime?.status === 'ready') {
          const pid = last.runtime.machine?.pid
          if (Number.isSafeInteger(pid) && pid > 1) {
            fs.writeFileSync(process.env.ISSUE_681_DAEMON_PID, `${pid}\n`, { mode: 0o600 })
          }
          return { win, runtime: last.runtime }
        }
        if (last.runtime?.status === 'unavailable') throw new Error(last.runtime.error || 'Embedded daemon unavailable')
      } catch (error) {
        if (/Embedded daemon unavailable/.test(String(error))) throw error
      }
    }
    await sleep(250)
  }
  throw new Error(`Timeout renderer/daemon Electron: ${last ? JSON.stringify(last) : 'renderer non caricato'}`)
}

async function verifyEndpoints(win, runtime) {
  const result = await win.webContents.executeJavaScript(`(async profileId => {
    const machine = await window.harnessDesktop.request(profileId, { path: '/v1/machine' })
    const projects = await window.harnessDesktop.request(profileId, { path: '/v1/projects' })
    return { machine, projects }
  })(${JSON.stringify(runtime.machine.profileId)})`)
  if (!result.machine?.ok || result.machine.response?.status !== 200) {
    throw new Error(`/v1/machine non raggiungibile via IPC Electron: ${JSON.stringify(result.machine)}`)
  }
  if (!result.projects?.ok || result.projects.response?.status !== 200) {
    throw new Error(`/v1/projects non raggiungibile via IPC Electron: ${JSON.stringify(result.projects)}`)
  }
  const agents = result.machine.response.data?.agents
  const ids = Array.isArray(agents) ? agents.map(agent => agent.id) : []
  const projectsData = result.projects.response.data?.projects
  const names = Array.isArray(projectsData) ? projectsData.map(project => project.name) : []
  const expected = path.basename(process.env.ISSUE_681_SANDBOX)
  if (!names.includes(expected)) throw new Error(`Sandbox ${expected} non visibile: ${names.join(', ') || '(nessuno)'}`)
  console.log(`Electron reale caricato dal working tree ${process.env.ISSUE_681_ROOT}`)
  console.log(`Daemon embedded pronto su ${runtime.machine.host}:${runtime.machine.port}`)
  console.log(`/v1/machine e /v1/projects verificati via IPC; harness rilevati: ${ids.join(', ') || '(nessuno)'}`)
  console.log(`Progetto sandbox visibile: ${expected}`)
  console.log(`Antigravity CLI: ${ids.includes('antigravity') ? 'rilevato' : 'non rilevato; controllare agy/PATH prima del test manuale'}`)
}

async function main() {
  try {
    const webDir = process.env.ISSUE_681_WEB_DIR
    if (path.resolve(app.getAppPath()) !== path.resolve(webDir)) throw new Error(`Percorso Electron inatteso: ${app.getAppPath()}`)
    await import(pathToFileURL(path.join(webDir, 'dist-electron/electron/main.js')).href)
    const { win, runtime } = await waitForRuntime()
    await verifyEndpoints(win, runtime)
    fs.writeFileSync(process.env.ISSUE_681_READY_FILE, 'ready', { mode: 0o600 })
    if (process.env.ISSUE_681_CHECK === '1') app.quit()
  } catch (error) {
    console.error(`[issue 681 bootstrap] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    app.exit(1)
  }
}
app.whenReady().then(main)
JS
chmod 600 "$BOOTSTRAP"
rm -f -- "$READY" "$DAEMON_PID_FILE"

LAUNCHER="$TMP_ROOT/launch-electron.sh"
cat >"$LAUNCHER" <<EOF
#!/usr/bin/env bash
exec env -i \\
  HOME="$NATIVE" USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" \\
  PATH="$BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \\
  DISPLAY="\${DISPLAY:-}" WAYLAND_DISPLAY="\${WAYLAND_DISPLAY:-}" \\
  XAUTHORITY="\${XAUTHORITY:-}" DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-}" \\
  LANG="${LANG:-C.UTF-8}" LC_ALL="${LC_ALL:-}" \\
  XDG_DATA_HOME="$DATA" XDG_STATE_HOME="$STATE_DIR" XDG_CACHE_HOME="$CACHE" \\
  XDG_CONFIG_HOME="$NATIVE/.config" TMPDIR="$STATE/tmp" TMP="$STATE/tmp" TEMP="$STATE/tmp" \\
  HARNESS_REMOTE_ROOT="$SANDBOX" ISSUE_681_PROFILE="$PROFILE" ISSUE_681_WEB_DIR="$ROOT/web" \\
  ISSUE_681_ROOT="$ROOT" ISSUE_681_SANDBOX="$SANDBOX" ISSUE_681_READY_FILE="$READY" \\
  ISSUE_681_DAEMON_PID="$DAEMON_PID_FILE" ISSUE_681_CHECK="$([[ "$MODE" == --check ]] && echo 1 || echo 0)" \\
  "$ROOT/web/node_modules/.bin/electron" --no-sandbox --disable-setuid-sandbox --disable-gpu \\
  --user-data-dir="$PROFILE" "$BOOTSTRAP"
EOF
chmod 700 "$LAUNCHER"

if [[ "$MODE" == --check && -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" && -x "$(command -v xvfb-run 2>/dev/null || true)" ]]; then
  echo "Nessun display disponibile: uso Xvfb soltanto per il controllo headless."
  setsid xvfb-run -a "$LAUNCHER" >"$LOG" 2>&1 &
else
  setsid "$LAUNCHER" >"$LOG" 2>&1 &
fi
APP_PID=$!

wait_for_ready() {
  for _ in {1..250}; do
    if [[ -s "$READY" ]]; then
      [[ ! -s "$DAEMON_PID_FILE" ]] || DAEMON_PID="$(<"$DAEMON_PID_FILE")"
      if [[ "$DAEMON_PID" =~ ^[1-9][0-9]*$ && -r "/proc/$DAEMON_PID/stat" ]]; then
        DAEMON_START_TICKS="$(awk '{print $22}' "/proc/$DAEMON_PID/stat" 2>/dev/null || true)"
      fi
      return 0
    fi
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      wait "$APP_PID" 2>/dev/null || true
      echo "Electron issue 681 è terminato prima di completare l'avvio:" >&2
      cat "$LOG" >&2
      return 1
    fi
    sleep 0.2
  done
  echo "Timeout avvio Electron issue 681; log:" >&2
  cat "$LOG" >&2
  return 1
}

wait_for_ready
if [[ "$MODE" == --check ]]; then
  cat "$LOG"
  echo "--check superato: build desktop, finestra Electron reale, daemon integrato e sandbox verificati."
  exit 0
fi

cat <<EOF
Harness Remote issue 681 — app desktop Electron reale
Working tree: $ROOT
Sandbox progetto: $SANDBOX
Profilo Electron isolato: $PROFILE
HOME/native/XDG isolati: $NATIVE, $DATA, $STATE_DIR, $CACHE
Log: $LOG

Login isolato, se richiesto: $ROOT/scripts/harness-remote-issue-681-run-test.sh --login
Comando già eseguito: $ROOT/scripts/harness-remote-issue-681-run-test.sh
La finestra Electron è aperta sul progetto sandbox. Il daemon integrato è stato verificato.

Checklist manuale (turni reali in attesa di autorizzazione del modello Antigravity):
  1. Seleziona la macchina locale e verifica che il progetto Antigravity-ACP sia visibile.
  2. Apri la sezione harness e verifica che Google Antigravity compaia solo se il comando `agy`
     è installato e raggiungibile. Se manca, interrompi qui: non selezionare un harness sostitutivo.
  3. Seleziona un modello Antigravity autorizzato e crea una Session nel progetto sandbox.
     Invia un prompt e verifica la risposta; la scelta del modello è ancora in attesa di Giulio.
  4. Riapri la Session, invia un secondo prompt, poi prova Stop durante un turno lungo e continua.
  5. Riavvia lo script e verifica che la Session sia ritrovata, senza duplicati nella cronologia.
  6. Prova anche i flussi degli altri harness installati con i modelli già autorizzati nel progetto.

Chiudi la finestra o premi Ctrl+C per arrestare solo Electron e il daemon avviati da questo script.
Il progetto sandbox e lo stato isolato restano sotto $TEST per la revisione.
EOF

wait "$APP_PID"
