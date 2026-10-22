#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then CHECK_ONLY=1; shift; fi
if (($#)); then printf 'Usage: %s [--check]\n' "$0" >&2; exit 2; fi

for required in node npm git setsid; do
  command -v "$required" >/dev/null 2>&1 || { printf 'Missing required command: %s\n' "$required" >&2; exit 1; }
done
[[ -x "$WEB_DIR/node_modules/.bin/electron" ]] || npm ci --prefix "$WEB_DIR" --no-audit --no-fund

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/harness-remote-codex-mobile-electron.XXXXXX")"
PROFILE_DIR="$TMP_ROOT/electron-profile"
SESSION_DIR="$TMP_ROOT/electron-session"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
NATIVE_DATA_DIR="$TMP_ROOT/xdg-data"
NATIVE_STATE_DIR="$TMP_ROOT/xdg-state"
NATIVE_CACHE_DIR="$TMP_ROOT/xdg-cache"
PROJECT_ROOT="$TMP_ROOT/projects"
PROJECT_ONE="$PROJECT_ROOT/codex-mobile-sandbox"
PROJECT_TWO="$PROJECT_ROOT/project-roots-sandbox"
LOG_DIR="$TMP_ROOT/logs"
BOOTSTRAP="$WEB_DIR/.codex-mobile-electron-$$-$RANDOM.cjs"
DAEMON_STATUS="$TMP_ROOT/embedded-daemon.pid"
READY_STATUS="$TMP_ROOT/startup-ready"
ELECTRON_LOG="$LOG_DIR/electron.log"
mkdir -p "$PROFILE_DIR" "$SESSION_DIR" "$NATIVE_DATA_DIR/opencode" "$NATIVE_DATA_DIR/mimocode" \
  "$NATIVE_STATE_DIR" "$NATIVE_CACHE_DIR" "$PROJECT_ONE" "$PROJECT_TWO" "$LOG_DIR"
git -C "$PROJECT_ONE" init -q
git -C "$PROJECT_ONE" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm 'Initialize Codex mobile sandbox'
git -C "$PROJECT_TWO" init -q
git -C "$PROJECT_TWO" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm 'Initialize project roots sandbox'
node - "$PROJECT_ROOT" "$PROFILE_DIR/desktop-project-roots.json" <<'JS'
const fs = require('node:fs')
fs.writeFileSync(process.argv[3], JSON.stringify([process.argv[2]]) + '\n', { mode: 0o600 })
JS
chmod 600 "$PROFILE_DIR/desktop-project-roots.json"

# Reuse native Codex login, configuration and session index; isolate only the Electron/bridge profile.
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

ELECTRON_PID=""
DAEMON_PID=""
start_electron() {
  rm -f -- "$DAEMON_STATUS" "$READY_STATUS"
  setsid env -u HARNESS_REMOTE_ROOT -u OMP_BRIDGE_ROOT -u ELECTRON_RUN_AS_NODE \
    CODEX_HOME="$CODEX_HOME_DIR" XDG_DATA_HOME="$NATIVE_DATA_DIR" XDG_STATE_HOME="$NATIVE_STATE_DIR" XDG_CACHE_HOME="$NATIVE_CACHE_DIR" \
    HR_TEST_USER_DATA="$PROFILE_DIR" HR_TEST_WEB_DIR="$WEB_DIR" HR_TEST_SESSION_DATA="$SESSION_DIR" \
    HR_TEST_STATUS_FILE="$DAEMON_STATUS" HR_TEST_READY_FILE="$READY_STATUS" HR_TEST_CHECK="$CHECK_ONLY" HR_TEST_PROJECT_ROOT="$PROJECT_ROOT" \
    "$WEB_DIR/node_modules/.bin/electron" "$BOOTSTRAP" >"$ELECTRON_LOG" 2>&1 &
  ELECTRON_PID=$!
}
stop_daemon_group() {
  local pid="${DAEMON_PID:-}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in {1..50}; do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
  DAEMON_PID=""
}
stop_electron() {
  [[ ! -s "$DAEMON_STATUS" ]] || DAEMON_PID="$(<"$DAEMON_STATUS")"
  local pid="${ELECTRON_PID:-}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { stop_daemon_group; return 0; }
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..100}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi
  fi
  wait "$pid" 2>/dev/null || true
  ELECTRON_PID=""
  stop_daemon_group
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  stop_electron
  rm -f -- "$BOOTSTRAP"
  rm -rf -- "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

npm --prefix "$WEB_DIR" run build:desktop >"$LOG_DIR/build.log" 2>&1 || { cat "$LOG_DIR/build.log" >&2; exit 1; }

cat > "$BOOTSTRAP" <<'JS'
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
app.setPath('userData', process.env.HR_TEST_USER_DATA)
app.setPath('sessionData', process.env.HR_TEST_SESSION_DATA)
process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())
app.on('will-quit', () => { try { fs.unlinkSync(process.env.HR_TEST_STATUS_FILE) } catch {} })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let reportedPid = null
function recordPid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid === reportedPid) return
  reportedPid = pid
  fs.writeFileSync(process.env.HR_TEST_STATUS_FILE, `${pid}\n`, { mode: 0o600 })
}
async function waitForRuntimeAndRenderer() {
  const deadline = Date.now() + 45000
  let lastState = null
  while (Date.now() < deadline && !app.isQuitting) {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
    if (window && !window.webContents.isLoading()) {
      try {
        lastState = await window.webContents.executeJavaScript(`(async () => {
          if (!window.harnessDesktop) return { renderer: false }
          return { renderer: true, runtime: await window.harnessDesktop.getLocalRuntimeState() }
        })()`)
        if (lastState.runtime?.status === 'ready') {
          recordPid(lastState.runtime.machine?.pid)
          return { window, runtime: lastState.runtime }
        }
        if (lastState.runtime?.status === 'unavailable') throw new Error(lastState.runtime.error || 'Embedded runtime unavailable')
      } catch (error) {
        if (/Embedded runtime unavailable/.test(String(error))) throw error
      }
    }
    await sleep(300)
  }
  throw new Error(`Timed out waiting for Electron renderer and embedded daemon${lastState ? ` (${JSON.stringify(lastState)})` : ''}`)
}
async function checkApplication(window, runtime) {
  const result = await window.webContents.executeJavaScript(`(async (profileId) => {
    const machine = await window.harnessDesktop.request(profileId, { path: '/v1/machine' })
    const projects = await window.harnessDesktop.request(profileId, { path: '/v1/projects' })
    const roots = await window.harnessDesktop.getProjectRoots()
    const codexSessions = await window.harnessDesktop.request(profileId, { path: "/v1/agents/codex/experimental/session" })
    return { machine, projects, roots, codexSessions }
  })(${JSON.stringify(runtime.machine.profileId)})`)
  if (!result.machine?.ok || result.machine.response?.status !== 200) throw new Error(`IPC /v1/machine failed: ${JSON.stringify(result.machine)}`)
  if (!result.projects?.ok || result.projects.response?.status !== 200) throw new Error(`IPC /v1/projects failed: ${JSON.stringify(result.projects)}`)
  const agents = result.machine.response.data?.agents
  const ids = Array.isArray(agents) ? agents.map(agent => agent.id) : []
  for (const expected of ['codex', 'mimo']) if (!ids.includes(expected)) throw new Error(`Daemon missing ${expected}; available: ${ids.join(', ') || '(none)'}`)
  const projects = result.projects.response.data?.projects
  const names = Array.isArray(projects) ? projects.map(project => project.name) : []
  for (const expected of ['codex-mobile-sandbox', 'project-roots-sandbox']) if (!names.includes(expected)) throw new Error(`Project catalog missing ${expected}; available: ${names.join(', ') || '(none)'}`)
  const root = process.env.HR_TEST_PROJECT_ROOT
  if (result.roots?.environmentOverride !== null) throw new Error(`Expected no environment override, got ${JSON.stringify(result.roots)}`)
  if (!Array.isArray(result.roots?.roots) || result.roots.roots.length !== 1 || path.resolve(result.roots.roots[0]) !== path.resolve(root)) throw new Error(`Unexpected configured roots: ${JSON.stringify(result.roots)}`)
  if (!result.codexSessions?.ok || result.codexSessions.response?.status !== 200 || !Array.isArray(result.codexSessions.response.data)) {
    throw new Error('Codex native session discovery failed: HTTP ' + result.codexSessions?.response?.status)
  }
  console.log(`Codex native sessions visible: ${result.codexSessions.response.data.length}`)
  console.log(`Electron renderer and embedded daemon ready (PID ${runtime.machine.pid})`)
  console.log(`IPC verified: /v1/machine agents ${ids.join(', ')}`)
  console.log(`IPC verified: /v1/projects projects ${names.join(', ')}`)
  console.log(`IPC getProjectRoots verified: ${JSON.stringify(result.roots)}`)
}
async function main() {
  try {
    if (path.resolve(app.getAppPath()) !== path.resolve(process.env.HR_TEST_WEB_DIR)) throw new Error(`Unexpected app path: ${app.getAppPath()}`)
    await import(pathToFileURL(path.join(app.getAppPath(), 'dist-electron', 'electron', 'main.js')).href)
    const { window, runtime } = await waitForRuntimeAndRenderer()
    // Editing project roots restarts the embedded daemon with a new detached PID. Keep the
    // parent launcher informed so cleanup always targets the current daemon process group.
    const monitor = setInterval(async () => {
      try {
        const state = await window.webContents.executeJavaScript('window.harnessDesktop.getLocalRuntimeState()')
        if (state?.status === 'ready') recordPid(state.machine?.pid)
        else if (state?.status === 'unavailable') { try { fs.unlinkSync(process.env.HR_TEST_STATUS_FILE) } catch {} }
      } catch {}
    }, 750)
    monitor.unref?.()
    if (process.env.HR_TEST_CHECK === '1') {
      await checkApplication(window, runtime)
      fs.writeFileSync(process.env.HR_TEST_READY_FILE, 'check', { mode: 0o600 })
      app.quit()
    } else fs.writeFileSync(process.env.HR_TEST_READY_FILE, 'ready', { mode: 0o600 })
  } catch (error) {
    console.error(`[test-bootstrap] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    app.exit(1)
  }
}
app.whenReady().then(main)
JS
chmod 600 "$BOOTSTRAP"

start_electron
wait_for_electron() {
  local timeout="${1:-55}"
  for ((attempt=0; attempt<timeout*5; attempt++)); do
    if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
      if wait "$ELECTRON_PID" 2>/dev/null && [[ -s "$READY_STATUS" ]] && { ((!CHECK_ONLY)) || [[ "$(<"$READY_STATUS")" == check ]]; }; then return 0; fi
      echo 'Electron exited before startup validation completed.' >&2; cat "$ELECTRON_LOG" >&2; return 1
    fi
    if [[ -s "$READY_STATUS" ]]; then
      if ((!CHECK_ONLY)); then return 0; fi
    fi
    sleep 0.2
  done
  echo 'Electron did not finish startup in time:' >&2; cat "$ELECTRON_LOG" >&2; return 1
}
if ((CHECK_ONLY)); then
  wait_for_electron 55
  [[ ! -s "$ELECTRON_LOG" ]] || cat "$ELECTRON_LOG"
  echo '--check passed: Electron renderer, embedded daemon, machine/project IPC, and editable project roots verified.'
  exit 0
fi
wait_for_electron 55

cat <<EOF
Ambiente Electron pronto (finestra nativa, daemon locale incorporato).

Progetto sandbox 1: codex-mobile-sandbox — $PROJECT_ONE
Progetto sandbox 2: project-roots-sandbox — $PROJECT_TWO
Cartella radice iniziale: $PROJECT_ROOT
Profilo Electron isolato: $PROFILE_DIR
Dati Codex nativi riutilizzati (login, configurazione e sessioni): $CODEX_HOME_DIR
Autenticazione OpenCode/MiMo copiata: $([[ "$OPENCODE_AUTH_COPIED" == 1 ]] && echo sì || echo no)/$([[ "$MIMO_AUTH_COPIED" == 1 ]] && echo sì || echo no)
Modelli autorizzati: Codex gpt-6-luna; MiMo openai/gpt-6-luna; OpenCode opencode/longcat-2.5-preview-free; Oh My Pi openrouter/free; PI qwen/qwen3.8-27b:free via OpenRouter. Claude Code non va testato.

Non devi aggiungere una macchina: quella locale si collega automaticamente. Nome visualizzato: Questo computer oppure zorin-PC.
Log di questa esecuzione: $ELECTRON_LOG

Checklist cartelle:
1. Apri Macchine > macchina locale (Questo computer/zorin-PC) > Modifica.
2. Rimuovi la radice iniziale, premi Aggiungi cartella… e scegli $PROJECT_ONE.
3. Premi Salva macchina e conferma il riavvio del daemon locale: il selettore progetti deve mostrare codex-mobile-sandbox.
4. Torna in Modifica, aggiungi $PROJECT_TWO e salva: devono comparire entrambi i progetti.
   Puoi anche scegliere una tua cartella: la configurazione vale solo per questo profilo di test.
Checklist agenti: apri Nuova sessione > Coding agent e scegli Codex CLI o MiMo Code. Il filtro della lista Sessioni mostra solo harness con sessioni esistenti; Codex mostra la cronologia nativa del PC; MiMo usa ancora dati di test separati. Usa i modelli autorizzati sopra; se assenti, segnalalo senza sostituirli.
EOF
printf '\nChiudi la finestra Electron oppure premi Ctrl+C in questo terminale per terminare il test.\n'
wait "$ELECTRON_PID"
