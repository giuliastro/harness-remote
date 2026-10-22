#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
  shift
fi
if (($#)); then
  printf 'Usage: %s [--check]\n' "$0" >&2
  exit 2
fi

for required in node npm git setsid; do
  command -v "$required" >/dev/null 2>&1 || { printf 'Missing required command: %s\n' "$required" >&2; exit 1; }
done
[[ -x "$WEB_DIR/node_modules/.bin/electron" ]] || { echo "Electron dependencies are missing; install them before running this script." >&2; exit 1; }

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/harness-remote-session-metadata-electron.XXXXXX")"
PROFILE_DIR="$TMP_ROOT/electron-profile"
SESSION_DIR="$TMP_ROOT/electron-session"
NATIVE_DATA_DIR="$TMP_ROOT/xdg-data"
NATIVE_STATE_DIR="$TMP_ROOT/xdg-state"
NATIVE_CACHE_DIR="$TMP_ROOT/xdg-cache"
SANDBOX="$TMP_ROOT/projects/session-metadata-sandbox"
HISTORY_PROJECT="$SANDBOX/history-project"
LOG_DIR="$TMP_ROOT/logs"
BOOTSTRAP="$WEB_DIR/.session-metadata-electron-$$-$RANDOM.cjs"
DAEMON_STATUS="$TMP_ROOT/embedded-daemon.pid"
READY_STATUS="$TMP_ROOT/startup-ready"
ELECTRON_LOG="$LOG_DIR/electron.log"
mkdir -p "$PROFILE_DIR" "$SESSION_DIR" "$NATIVE_DATA_DIR/opencode" "$NATIVE_DATA_DIR/mimocode" \
  "$NATIVE_STATE_DIR" "$NATIVE_CACHE_DIR" "$SANDBOX" "$HISTORY_PROJECT" "$LOG_DIR"
git -C "$SANDBOX" init -q
git -C "$SANDBOX" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm 'Initialize isolated session metadata sandbox'
git -C "$HISTORY_PROJECT" init -q
git -C "$HISTORY_PROJECT" -c user.name='Harness Remote Test' -c user.email='test@example.invalid' commit --allow-empty -qm 'Initialize throwaway history project'

# Copy only provider credentials into the isolated XDG data root. User config and other harness
# authentication remain available through the normal home directory and inherited environment.
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
  rm -f -- "$DAEMON_STATUS"
  rm -f -- "$READY_STATUS"
  setsid env \
    HARNESS_REMOTE_ROOT="$SANDBOX" \
    XDG_DATA_HOME="$NATIVE_DATA_DIR" \
    XDG_STATE_HOME="$NATIVE_STATE_DIR" \
    XDG_CACHE_HOME="$NATIVE_CACHE_DIR" \
    OPENCODE_CONFIG_CONTENT='{"model":"opencode/longcat-2.5-preview-free"}' \
    HR_TEST_USER_DATA="$PROFILE_DIR" \
    HR_TEST_WEB_DIR="$WEB_DIR" \
    HR_TEST_SESSION_DATA="$SESSION_DIR" \
    HR_TEST_STATUS_FILE="$DAEMON_STATUS" \
    HR_TEST_READY_FILE="$READY_STATUS" \
    HR_TEST_CHECK="$CHECK_ONLY" \
    "$WEB_DIR/node_modules/.bin/electron" "$BOOTSTRAP" >"$ELECTRON_LOG" 2>&1 &
  ELECTRON_PID=$!
}

stop_daemon_group() {
  local pid="${DAEMON_PID:-}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in {1..50}; do
    kill -0 -- "-$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  DAEMON_PID=""
}

stop_electron() {
  if [[ -s "$DAEMON_STATUS" ]]; then DAEMON_PID="$(<"$DAEMON_STATUS")"; fi
  local pid="${ELECTRON_PID:-}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..100}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  wait "$pid" 2>/dev/null || true
  ELECTRON_PID=""
  # The daemon owns a detached process group. Normally Electron reaps it during before-quit; this
  # fallback targets only the exact PID the bootstrap observed for this run.
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
const statusFile = process.env.HR_TEST_STATUS_FILE
let reportedPid = null
function recordPid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid === reportedPid) return
  reportedPid = pid
  fs.writeFileSync(statusFile, `${pid}\n`, { mode: 0o600 })
}

async function waitForRuntimeAndRenderer() {
  const deadline = Date.now() + 40_000
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
          return { window, state: lastState.runtime }
        }
        if (lastState.runtime?.status === 'unavailable') throw new Error(lastState.runtime.error || 'Embedded runtime unavailable')
      } catch (error) {
        if (/Embedded runtime unavailable/.test(String(error))) throw error
      }
    }
    await sleep(300)
  }
  throw new Error(`Timed out waiting for the Electron renderer and embedded daemon${lastState ? ` (${JSON.stringify(lastState)})` : ''}`)
}

async function checkApplication(window, runtime) {
  const result = await window.webContents.executeJavaScript(`(async (profileId) => {
    const machine = await window.harnessDesktop.request(profileId, { path: '/v1/machine' })
    const projects = await window.harnessDesktop.request(profileId, { path: '/v1/projects' })
    return { machine, projects }
  })(${JSON.stringify(runtime.machine.profileId)})`)
  if (!result.machine?.ok || result.machine.response?.status !== 200) {
    throw new Error(`Electron IPC /v1/machine request failed: ${JSON.stringify(result.machine)}`)
  }
  if (!result.projects?.ok || result.projects.response?.status !== 200) {
    throw new Error(`Electron IPC /v1/projects request failed: ${JSON.stringify(result.projects)}`)
  }
  const agents = result.machine.response.data?.agents
  const agentIDs = Array.isArray(agents) ? agents.map(agent => agent.id) : []
  for (const expected of ['opencode2', 'mimo']) {
    if (!agentIDs.includes(expected)) throw new Error(`Embedded daemon did not advertise ${expected}; available: ${agentIDs.join(', ') || '(none)'}`)
  }
  const projects = result.projects.response.data?.projects
  const names = Array.isArray(projects) ? projects.map(project => project.name) : []
  for (const expected of ['session-metadata-sandbox', 'history-project']) {
    if (!names.includes(expected)) throw new Error(`Embedded daemon project catalog is missing ${expected}; available: ${names.join(', ') || '(none)'}`)
  }
  console.log(`Electron renderer loaded at ${app.getAppPath()}`)
  console.log(`Embedded daemon ready at ${runtime.machine.host}:${runtime.machine.port} (PID ${runtime.machine.pid})`)
  console.log(`Renderer IPC verified /v1/machine and /v1/projects; agents: ${agentIDs.join(', ')}`)
  console.log(`Sandbox projects visible: ${names.join(', ')}`)
}

async function main() {
  try {
    if (path.resolve(app.getAppPath()) !== path.resolve(process.env.HR_TEST_WEB_DIR)) {
      throw new Error(`Unexpected Electron app path: ${app.getAppPath()}`)
    }
    const mainModule = path.join(app.getAppPath(), 'dist-electron', 'electron', 'main.js')
    await import(pathToFileURL(mainModule).href)
    const { window, state } = await waitForRuntimeAndRenderer()
    if (process.env.HR_TEST_CHECK === '1') {
      await checkApplication(window, state)
      fs.writeFileSync(process.env.HR_TEST_READY_FILE, 'check', { mode: 0o600 })
      app.quit()
    } else {
      fs.writeFileSync(process.env.HR_TEST_READY_FILE, 'ready', { mode: 0o600 })
    }
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
  local timeout="${1:-50}"
  for ((attempt=0; attempt<timeout*5; attempt++)); do
    if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
      if wait "$ELECTRON_PID" 2>/dev/null && [[ -s "$READY_STATUS" ]]; then
        if ((!CHECK_ONLY)) || [[ "$(<"$READY_STATUS")" == check ]]; then return 0; fi
      fi
      echo "Electron exited before the requested startup check completed." >&2
      cat "$ELECTRON_LOG" >&2
      return 1
    fi
    if [[ -s "$DAEMON_STATUS" ]]; then
      DAEMON_PID="$(<"$DAEMON_STATUS")"
      if [[ "$DAEMON_PID" =~ ^[1-9][0-9]*$ ]]; then
        if ((CHECK_ONLY)); then
          sleep 0.2
          if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
            if wait "$ELECTRON_PID" 2>/dev/null && [[ -s "$READY_STATUS" && "$(<"$READY_STATUS")" == check ]]; then return 0; fi
            cat "$ELECTRON_LOG" >&2
            return 1
          fi
        else
          return 0
        fi
      fi
    fi
    sleep 0.2
  done
  echo "Electron did not report a ready embedded daemon in time:" >&2
  cat "$ELECTRON_LOG" >&2
  return 1
}

if ((CHECK_ONLY)); then
  wait_for_electron 55
  [[ ! -s "$ELECTRON_LOG" ]] || cat "$ELECTRON_LOG"
  echo "--check passed: built Electron app loaded its renderer, started the embedded daemon, and verified machine/project IPC."
  exit 0
fi
wait_for_electron 55

cat <<EOF
Electron session metadata test environment is ready.

Application: Harness Remote (native Electron window, embedded local daemon)
Worktree: $ROOT_DIR
Branch: $(git -C "$ROOT_DIR" branch --show-current)
Sandbox project: session-metadata-sandbox
Sandbox path: $SANDBOX
History project: history-project
History project path: $HISTORY_PROJECT
Isolated Electron profile/session data: $PROFILE_DIR and $SESSION_DIR
Isolated provider XDG data/state/cache: $NATIVE_DATA_DIR, $NATIVE_STATE_DIR, $NATIVE_CACHE_DIR
OpenCode auth copied: $([[ "$OPENCODE_AUTH_COPIED" == 1 ]] && echo yes || echo no)
MiMo auth copied: $([[ "$MIMO_AUTH_COPIED" == 1 ]] && echo yes || echo no)
Approved OpenCode model: opencode/longcat-2.5-preview-free
Approved MiMo model: openai/gpt-6-luna
No remote machine configuration is needed; the embedded local machine connects automatically.

Checklist:
1. In the Electron app, click New Session and choose "session-metadata-sandbox" in the project picker. Select
   OpenCode 2, create a Session with opencode/longcat-2.5-preview-free, send a short prompt, and confirm
   the assistant responds. If the approved model is unavailable, stop and report it without substituting.
2. Rename that Session, refresh, then enter r in this terminal and confirm the name and last reply
   persist. Delete it and enter r again: it must remain absent from Harness Remote while its native
   history is preserved.
3. In New Session choose "history-project", create a Session, and send a short prompt with the same
   approved model. Enter d in this terminal to remove only its throwaway project folder. Enter r,
   reopen the Session and confirm its last assistant reply remains visible. Try continuing and confirm
   the app reports a clear missing-project error.
4. Close the Electron window, return to this terminal, and enter r then Enter. The full Electron app
   reopens with the same isolated profile, embedded daemon state, and project folders. Confirm the
   rename/delete and surviving-history behavior remain consistent. Enter r again to repeat or q to exit.
5. Regression checks when available: Codex with gpt-6-luna, Oh My Pi with openrouter/free, and PI with
   qwen/qwen3.8-27b:free via OpenRouter. For each, create a Session, prompt and verify a response, stop
   and continue, then reopen and check history. MiMo may be checked with OpenAI Luna (openai/gpt-6-luna)
   using the same flow. If an approved model is absent, stop that harness check and report it. Do not
   run Claude Code tests.

The script starts only this Electron app and its embedded daemon. Exiting stops those owned processes
and removes this run's profile, isolated XDG data and sandbox. It does not stop services by name or port.
EOF

while true; do
  printf '%s' 'Enter r to reopen Electron, d to remove only history-project, or q to quit: '
  IFS= read -r choice || choice=q
  case "${choice,,}" in
    r)
      stop_electron
      : > "$ELECTRON_LOG"
      start_electron
      wait_for_electron 55
      echo "Electron reopened with the same isolated profile, daemon state, and projects."
      ;;
    q)
      break
      ;;
    d)
      rm -rf -- "$HISTORY_PROJECT"
      echo "Removed only this run's history-project folder. Its native session history is preserved."
      ;;
    *)
      echo 'Enter r, d or q.'
      ;;
  esac
done
