#!/usr/bin/env bash
# Android E1 test for PR672. The real Electron app is optional with --desktop.
# Test projects and profiles persist under .harnesstrim/pr672; no router or Internet listener is used.
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST="$ROOT/.harnesstrim/pr672"
STATE="$TEST/state"
DESKTOP="$STATE/electron"
TARGET_STATE="$STATE/target-daemon"
TARGET_CODEX="$STATE/codex-target"
DESKTOP_CODEX="$STATE/codex-desktop"
SANDBOX="$TEST/sandbox"
TARGET_PROJECT="$SANDBOX/E1-remote-target"
LOCAL_PROJECT="$SANDBOX/E1-electron-local"
LOGS="$STATE/logs"
ANDROID_APK="$ROOT/web/android/app/build/outputs/apk/debug/app-debug.apk"
ANDROID_PACKAGE="ai.harness.remote.debug.e1test"
MODE="${1:-}"
[[ -z "$MODE" || "$MODE" == --check || "$MODE" == --desktop ]] || { echo "Uso: $0 [--check|--desktop]" >&2; exit 2; }
[[ $# -le 1 ]] || { echo "Uso: $0 [--check|--desktop]" >&2; exit 2; }

for name in node npm git flock setsid ps tr awk sleep install mkdir chmod curl grep sed; do
  command -v "$name" >/dev/null 2>&1 || { echo "Comando mancante: $name" >&2; exit 1; }
done
[[ -x "$ROOT/web/node_modules/.bin/electron" ]] || {
  echo "Dipendenze web/Electron mancanti in $ROOT/web/node_modules." >&2; exit 1;
}
[[ -f "$ROOT/bridge/src/daemon-cli.js" && -f "$ROOT/web/electron/main.ts" ]] || {
  echo "Sorgenti daemon o Electron non trovati nel checkout $ROOT." >&2; exit 1;
}

mkdir -p "$DESKTOP/session" "$TARGET_STATE" "$TARGET_CODEX" "$DESKTOP_CODEX" \
  "$SANDBOX" "$LOGS"
chmod 700 "$TEST" "$STATE" "$DESKTOP" "$TARGET_STATE" "$TARGET_CODEX" "$DESKTOP_CODEX" "$LOGS"
for log in "$LOGS/build-electron.log" "$LOGS/build-android.log" "$LOGS/target-daemon.log" "$LOGS/electron.log"; do
  [[ ! -f "$log" ]] || chmod 600 "$log"
done
exec 9>"$STATE/run.lock"
flock -n 9 || { echo "Il test PR672 è già aperto." >&2; exit 1; }

# Retain user-created files and sessions across runs. Initialize only an empty sandbox.
for project in "$TARGET_PROJECT" "$LOCAL_PROJECT"; do
  mkdir -p "$project"
  if [[ ! -d "$project/.git" ]]; then
    git -C "$project" init -q
    git -C "$project" -c user.name='Harness Remote PR672 Test' \
      -c user.email='test@example.invalid' commit --allow-empty -qm 'PR672 E1 test sandbox'
  fi
  if [[ ! -f "$project/README.md" ]]; then
    cat >"$project/README.md" <<'EOF'
# Harness Remote PR672 E1 test project

Use this isolated project for manual E1 test sessions. The E1 target daemon uses
the `E1-remote-target` project; the Electron app's embedded local daemon uses
`E1-electron-local`.
EOF
  fi
done

echo "Compilo renderer e main process dell'app Electron reale…"
npm --prefix "$ROOT/web" run build:desktop >"$LOGS/build-electron.log" 2>&1 || {
  cat "$LOGS/build-electron.log" >&2; exit 1;
}
[[ -f "$ROOT/web/dist/index.html" && -f "$ROOT/web/dist-electron/electron/main.js" ]] || {
  echo "Build desktop incompleta." >&2; exit 1;
}
if [[ -x /tmp/harness-e1-jdk21/bin/java ]]; then
  TEST_JAVA_HOME=/tmp/harness-e1-jdk21
elif [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]] && "$JAVA_HOME/bin/java" -version 2>&1 | grep -q 'version "21'; then
  TEST_JAVA_HOME="$JAVA_HOME"
else
  echo "JDK 21 non trovato; imposta JAVA_HOME a un JDK 21." >&2; exit 1
fi
echo "Compilo l'app Android E1 separata dall'installazione quotidiana…"
(cd "$ROOT/web" && ./node_modules/.bin/cap copy android && node scripts/sync-native-live-events.mjs) >"$LOGS/build-android.log" 2>&1 || {
  cat "$LOGS/build-android.log" >&2; exit 1;
}
node - "$ROOT/web/android/app/build.gradle" <<'JS'
const fs = require('node:fs')
const file = process.argv[2]
const source = fs.readFileSync(file, 'utf8')
const updated = source.replace(/applicationIdSuffix\s+[^\r\n]+/, 'applicationIdSuffix ".debug.e1test"')
if (updated === source && !source.includes('applicationIdSuffix ".debug.e1test"')) {
  throw new Error('Debug applicationIdSuffix not found in generated Android project')
}
fs.writeFileSync(file, updated)
JS
(cd "$ROOT/web/android" && JAVA_HOME="$TEST_JAVA_HOME" ./gradlew :app:assembleDebug -Pe1TestApp --quiet) >>"$LOGS/build-android.log" 2>&1 || {
  cat "$LOGS/build-android.log" >&2; exit 1;
}
[[ -f "$ANDROID_APK" ]] || { echo "APK E1 non generato." >&2; exit 1; }
if [[ "$MODE" == --check ]]; then
  echo "PR672 E1: renderer, main Electron e APK Android E1 compilati."
  echo "Sandbox target: $TARGET_PROJECT"
  echo "Sandbox Electron locale: $LOCAL_PROJECT"
  echo "APK E1: $ANDROID_APK ($ANDROID_PACKAGE)"
  exit 0
fi

[[ -f "$HOME/.codex/auth.json" ]] || {
  echo "Autenticazione Codex non trovata in ~/.codex/auth.json; necessaria per la sessione Luna." >&2; exit 1;
}
install -m 600 "$HOME/.codex/auth.json" "$TARGET_CODEX/auth.json"
install -m 600 "$HOME/.codex/auth.json" "$DESKTOP_CODEX/auth.json"
[[ ! -f "$HOME/.codex/config.toml" ]] || {
  install -m 600 "$HOME/.codex/config.toml" "$TARGET_CODEX/config.toml"
  install -m 600 "$HOME/.codex/config.toml" "$DESKTOP_CODEX/config.toml"
}

# Ask the OS for two currently free loopback ports; daemon-cli rechecks availability before bind.
PREFERRED_HTTPS_PORT=""
[[ ! -f "$STATE/e1-https-port" ]] || PREFERRED_HTTPS_PORT="$(<"$STATE/e1-https-port")"
ALLOCATED_PORTS="$(PR672_PREFERRED_HTTPS_PORT="$PREFERRED_HTTPS_PORT" node --input-type=module <<'JS'
import net from 'node:net'
async function freePort(preferred = 0) {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(preferred, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}
const httpPort = await freePort()
const preferred = Number(process.env.PR672_PREFERRED_HTTPS_PORT)
let httpsPort = 0
if (Number.isInteger(preferred) && preferred > 0 && preferred <= 65535 && preferred !== httpPort) {
  try { httpsPort = await freePort(preferred) } catch { /* Another service owns the old port. */ }
}
if (!httpsPort) {
  for (let attempt = 0; attempt < 8 && (!httpsPort || httpsPort === httpPort); attempt += 1) {
    httpsPort = await freePort()
  }
}
console.log(`${httpPort} ${httpsPort}`)
JS
)" || { echo "Impossibile allocare due porte loopback libere." >&2; exit 1; }
read -r TARGET_HTTP_PORT E1_HTTPS_PORT <<<"$ALLOCATED_PORTS"
[[ "$TARGET_HTTP_PORT" != "$E1_HTTPS_PORT" ]] || { echo "Allocazione porte duplicate; riprova." >&2; exit 1; }
TARGET_USER="e1-pr672"
TARGET_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
printf '%s\n' "$TARGET_HTTP_PORT" >"$STATE/target-http-port"
printf '%s\n' "$E1_HTTPS_PORT" >"$STATE/e1-https-port"

ADB="$(command -v adb || true)"
if [[ -z "$ADB" && -x "$HOME/Android/Sdk/platform-tools/adb" ]]; then
  ADB="$HOME/Android/Sdk/platform-tools/adb"
fi
ADB_SERIAL=""
ADB_REVERSE_CREATED=0
ADB_REVERSE_REUSED=0
if [[ -n "$ADB" ]]; then
  mapfile -t DEVICES < <("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1 }')
  if (( ${#DEVICES[@]} == 1 )); then
    ADB_SERIAL="${DEVICES[0]}"
    "$ADB" -s "$ADB_SERIAL" install -r "$ANDROID_APK" >/dev/null || {
      echo "Installazione dell'APK E1 sul telefono non riuscita." >&2; exit 1;
    }
    echo "App di test $ANDROID_PACKAGE installata su $ADB_SERIAL (separata dall'app quotidiana)."
    REVERSE_LIST="$("$ADB" -s "$ADB_SERIAL" reverse --list 2>/dev/null || true)"
    if grep -Eq "(^|[[:space:]])tcp:${E1_HTTPS_PORT}[[:space:]]+tcp:${E1_HTTPS_PORT}$" <<<"$REVERSE_LIST"; then
      ADB_REVERSE_REUSED=1
      echo "adb reverse già presente e coincidente su $ADB_SERIAL tcp:$E1_HTTPS_PORT."
    elif grep -Eq "(^|[[:space:]])tcp:${E1_HTTPS_PORT}[[:space:]]" <<<"$REVERSE_LIST"; then
      echo "adb reverse tcp:$E1_HTTPS_PORT è già associato a un'altra porta; non lo modifico." >&2
      exit 1
    elif "$ADB" -s "$ADB_SERIAL" reverse "tcp:$E1_HTTPS_PORT" "tcp:$E1_HTTPS_PORT"; then
      ADB_REVERSE_CREATED=1
      echo "adb reverse configurato: Android localhost:$E1_HTTPS_PORT → PC 127.0.0.1:$E1_HTTPS_PORT."
    else
      echo "adb reverse non riuscito; verifica cavo e debug USB." >&2
      exit 1
    fi
  elif (( ${#DEVICES[@]} > 1 )); then
    echo "Trovati più dispositivi adb; scollega quelli non usati e riprova." >&2
    exit 1
  else
    echo "Nessun dispositivo Android adb collegato. Collega il telefono e autorizza il debug USB." >&2
    exit 1
  fi
else
  echo "adb non trovato: il test Android richiede adb e un telefono collegato." >&2
  exit 1
fi
REVERSE_LIST="$("$ADB" -s "$ADB_SERIAL" reverse --list)"
grep -Eq "(^|[[:space:]])tcp:${E1_HTTPS_PORT}[[:space:]]+tcp:${E1_HTTPS_PORT}$" <<<"$REVERSE_LIST" || {
  echo "adb reverse non risulta attivo sulla porta $E1_HTTPS_PORT." >&2; exit 1;
}

TARGET_PID=""
APP_PID=""
BOOTSTRAP="$ROOT/web/.pr672-bootstrap-$$.cjs"
TARGET_LOG="$LOGS/target-daemon.log"
APP_LOG="$LOGS/electron.log"
cleanup() {
  local status=$? proc command_line pid group
  trap - EXIT INT TERM HUP
  [[ -z "${BOOTSTRAP:-}" ]] || rm -f -- "$BOOTSTRAP"
  local -a embedded_groups=()
  # Stop only this profile's embedded daemon, after checking its command line and start identity.
  for proc in /proc/[0-9]*/cmdline; do
    [[ -r "$proc" ]] || continue
    command_line="$(tr '\0' ' ' <"$proc" 2>/dev/null || true)"
    [[ "$command_line" == *"$ROOT/bridge/src/daemon-cli.js"* && \
      "$command_line" == *"--state-dir $DESKTOP/embedded-daemon"* ]] || continue
    pid="${proc#/proc/}"; pid="${pid%/cmdline}"
    group="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    [[ -n "$group" && "$group" != "$APP_PID" ]] && embedded_groups+=("$group")
  done
  if [[ "$ADB_REVERSE_CREATED" == 1 && -n "$ADB_SERIAL" ]]; then
    # Remove only the mapping this script created, and only if it still points to our port.
    local current_reverse
    current_reverse="$("$ADB" -s "$ADB_SERIAL" reverse --list 2>/dev/null || true)"
    if grep -Eq "(^|[[:space:]])tcp:${E1_HTTPS_PORT}[[:space:]]+tcp:${E1_HTTPS_PORT}$" <<<"$current_reverse"; then
      "$ADB" -s "$ADB_SERIAL" reverse --remove "tcp:$E1_HTTPS_PORT" >/dev/null 2>&1 || true
    fi
  fi
  for group in "${embedded_groups[@]}"; do kill -TERM -- "-$group" 2>/dev/null || true; done
  [[ -z "$APP_PID" ]] || kill -TERM -- "-$APP_PID" 2>/dev/null || true
  [[ -z "$TARGET_PID" ]] || kill -TERM -- "-$TARGET_PID" 2>/dev/null || true
  for _ in {1..40}; do
    local alive=0
    if [[ -n "$APP_PID" ]] && kill -0 -- "-$APP_PID" 2>/dev/null; then alive=1; fi
    if [[ -n "$TARGET_PID" ]] && kill -0 -- "-$TARGET_PID" 2>/dev/null; then alive=1; fi
    for group in "${embedded_groups[@]}"; do kill -0 -- "-$group" 2>/dev/null && alive=1; done
    (( alive == 0 )) && break
    sleep 0.1
  done
  for group in "${embedded_groups[@]}"; do kill -KILL -- "-$group" 2>/dev/null || true; done
  [[ -z "$APP_PID" ]] || kill -KILL -- "-$APP_PID" 2>/dev/null || true
  [[ -z "$TARGET_PID" ]] || kill -KILL -- "-$TARGET_PID" 2>/dev/null || true
  [[ -z "$APP_PID" ]] || wait "$APP_PID" 2>/dev/null || true
  [[ -z "$TARGET_PID" ]] || wait "$TARGET_PID" 2>/dev/null || true
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

echo "Avvio daemon target isolato con HTTPS E1 solo su 127.0.0.1…"
setsid env -u HARNESS_REMOTE_ACP_COMMAND -u HARNESS_REMOTE_ACP_ARGS \
  CODEX_HOME="$TARGET_CODEX" \
  HARNESS_REMOTE_USERNAME="$TARGET_USER" HARNESS_REMOTE_PASSWORD="$TARGET_PASSWORD" \
  node "$ROOT/bridge/src/daemon-cli.js" \
  --backend codex --host 127.0.0.1 --port "$TARGET_HTTP_PORT" --root "$TARGET_PROJECT" \
  --state-dir "$TARGET_STATE" --no-opencode --remote-loopback-port "$E1_HTTPS_PORT" \
  >"$TARGET_LOG" 2>&1 &
TARGET_PID=$!

ready=0
for ((i=0; i<120; i++)); do
  kill -0 "$TARGET_PID" 2>/dev/null || { cat "$TARGET_LOG" >&2; exit 1; }
  if curl -fsS -u "$TARGET_USER:$TARGET_PASSWORD" \
    "http://127.0.0.1:$TARGET_HTTP_PORT/v1/machine" -o /dev/null 2>/dev/null && \
    [[ "$(curl -k -sS -o /dev/null -w '%{http_code}' \
      "https://127.0.0.1:$E1_HTTPS_PORT/v1/remote/addresses" 2>/dev/null || true)" == 401 ]]; then
    ready=1; break
  fi
  sleep 0.2
done
(( ready == 1 )) || { echo "Daemon E1 non pronto; log: $TARGET_LOG" >&2; cat "$TARGET_LOG" >&2; exit 1; }

if [[ "$MODE" == --desktop && ! -f "$DESKTOP/window-state.json" ]]; then
  printf '%s\n' '{"width":520,"height":880,"maximized":false}' >"$DESKTOP/window-state.json"
fi
cat <<EOF

PR #672 — test Android E1 su USB (nessuna finestra o tray desktop)
Target E1: https://127.0.0.1:$E1_HTTPS_PORT (TLS 1.3, loopback-only; nessuna porta router/Internet aperta)
QR/link one-time: riportato nel log qui sotto; scade dopo 5 minuti.
ADB: adb -s ${ADB_SERIAL:-<seriale>} reverse tcp:$E1_HTTPS_PORT tcp:$E1_HTTPS_PORT
Sandbox target da usare sul telefono: $TARGET_PROJECT

Sul telefono Android apri l'app Harness Remote con pacchetto $ANDROID_PACKAGE → Machines → Pair/Add machine e scansiona il QR
"remote-pair" del daemon E1. La connessione raggiunge solo il gateway HTTPS loopback; il QR
contiene il grant breve, DNS identity e pin TLS, non le credenziali Basic. Se il QR scade,
chiudi e riavvia questo script per crearne uno nuovo. Non inoltrare né fotografare il QR.

Nell'app E1 sul telefono, apri la macchina abbinata e seleziona il progetto E1-remote-target.
Per il test reale crea una sessione Codex con modello gpt-6-luna, invia un prompt innocuo,
verifica risposta, Stop e ripresa e rispondi a una richiesta di permesso.
Non usare Claude Code. Verifica anche che un pairing QR scaduto/già usato venga rifiutato e che
la revoca del dispositivo impedisca le richieste successive. Conferma infine che il telefono
continui a raggiungere la macchina solo mentre adb reverse è attivo; non attivare router mapping.

Credenziali: non occorrono credenziali Basic nella UI Android; il pairing E1 usa token one-time
e chiave dispositivo. L'utente tecnico del daemon loopback è privato e non viene esposto.
Log target (include QR one-time): $TARGET_LOG
Premi Ctrl+C per fermare il daemon e rimuovere la sola mappatura adb creata da questo script.
EOF
sed -n '/^E1 HTTPS preview /,$p' "$TARGET_LOG"

printf '%s\n' "$E1_HTTPS_PORT" >"$STATE/e1-active-port"
if [[ "$MODE" != --desktop ]]; then
  wait "$TARGET_PID"
  exit $?
fi
cat >"$BOOTSTRAP" <<'JS'
const { app } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
app.setPath('userData', process.env.PR672_ELECTRON_PROFILE)
app.setPath('sessionData', path.join(process.env.PR672_ELECTRON_PROFILE, 'session'))
process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())
app.whenReady().then(() => import(pathToFileURL(path.join(__dirname, 'dist-electron/electron/main.js')).href))
  .catch((error) => { console.error('[PR672 bootstrap]', error); app.exit(1) })
JS
chmod 600 "$BOOTSTRAP"
cd "$LOCAL_PROJECT"
setsid env -u ELECTRON_RUN_AS_NODE -u HARNESS_REMOTE_ACP_COMMAND -u HARNESS_REMOTE_ACP_ARGS \
  CODEX_HOME="$DESKTOP_CODEX" HARNESS_REMOTE_ROOT="$LOCAL_PROJECT" PR672_ELECTRON_PROFILE="$DESKTOP" \
  HARNESS_REMOTE_TEST_EXIT_ON_CLOSE=1 \
  "$ROOT/web/node_modules/.bin/electron" "$BOOTSTRAP" \
  --user-data-dir="$DESKTOP" >"$APP_LOG" 2>&1 &
APP_PID=$!
wait "$APP_PID"
