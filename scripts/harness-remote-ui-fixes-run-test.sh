#!/usr/bin/env bash
# Manual test environment for the UI fixes on the current working tree.
#
# It builds the real Electron desktop app and, unless the APK is already current, a debug APK.
# The desktop app runs from this checkout with an isolated HOME/profile, the embedded backend,
# LAN pairing enabled, and a deterministic "UI Test" machine for the Session UI checks.
#
# Usage:
#   scripts/harness-remote-ui-fixes-run-test.sh              # build if needed + run
#   scripts/harness-remote-ui-fixes-run-test.sh --check      # verify readiness only
#   scripts/harness-remote-ui-fixes-run-test.sh --rebuild-apk
#   scripts/harness-remote-ui-fixes-run-test.sh --build-only   # build/verify without opening Electron
#   scripts/harness-remote-ui-fixes-run-test.sh --force        # clear a stale lock left by an old run
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST="$ROOT/.harnesstrim/ui-fixes"
STATE="$TEST/state"
DESKTOP="$STATE/desktop"
HOME_TEST="$STATE/home"
PROJECT="$TEST/sandbox/ui-fixes-project"
LOGS="$STATE/logs"
BIN="$STATE/bin"
APK="$TEST/HarnessRemote-ui-fixes-debug.apk"
FAKE="$ROOT/scripts/ui-fixes-fake-daemon.mjs"
USERNAME=uitest
PASSWORD=uitest-local
CHECK=0
REBUILD_APK=0
BUILD_ONLY=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --rebuild-apk) REBUILD_APK=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --force) FORCE=1 ;;
    *) echo "Uso: $0 [--check] [--rebuild-apk]" >&2; exit 2 ;;
  esac
done

for name in node npm git flock curl setsid ps tr awk sed grep install mkdir rm cp readlink dirname ip sha256sum java; do
  command -v "$name" >/dev/null 2>&1 || { echo "Comando mancante: $name" >&2; exit 1; }
done
[[ -x "$ROOT/web/node_modules/.bin/electron" ]] || { echo "Dipendenze Electron mancanti in $ROOT/web/node_modules." >&2; exit 1; }
[[ -x "$ROOT/web/android/gradlew" ]] || { echo "Progetto Android mancante in $ROOT/web/android." >&2; exit 1; }
[[ -f "$FAKE" ]] || { echo "Daemon di test mancante: $FAKE" >&2; exit 1; }

source_stamp() {
  {
    git -C "$ROOT" rev-parse HEAD
    git -C "$ROOT" diff -- web/src web/electron web/android web/package.json web/capacitor.config.ts web/index.html
  } | sha256sum | awk '{print $1}'
}

apk_is_current() {
  [[ -f "$APK" && -f "$STATE/apk-stamp" ]] && [[ "$(cat "$STATE/apk-stamp")" == "$(source_stamp)" ]]
}

if [[ "$CHECK" == 1 ]]; then
  missing=0
  [[ -f "$ROOT/web/dist/index.html" && -f "$ROOT/web/dist-electron/electron/main.js" ]] || { echo "Build desktop mancante."; missing=1; }
  apk_is_current || { echo "APK mancante o non aggiornato al working tree corrente (usa --rebuild-apk)."; missing=1; }
  node --check "$FAKE" || missing=1
  [[ -x "$ROOT/web/node_modules/.bin/electron" ]] || missing=1
  [[ -f "$ROOT/web/android/gradlew" ]] || missing=1
  (( missing == 0 )) && { echo "Ambiente UI fixes pronto: $TEST"; exit 0; }
  exit 1
fi

mkdir -p "$STATE" "$LOGS" "$PROJECT" "$BIN" "$HOME_TEST/.config" "$HOME_TEST/.local/share" "$HOME_TEST/.cache" "$STATE/npm-cache"
export npm_config_cache="$STATE/npm-cache"
export npm_config_update_notifier=false
if [[ "$BUILD_ONLY" != 1 ]]; then
  exec 9>"$STATE/run.lock"
  if ! flock -n 9; then
    if [[ "$FORCE" == 1 ]]; then
      # The previous process may be an old test instance whose tray icon survived the window
      # close. The lock is only a filename; replacing the inode lets this run start, and the
      # stale-process sweep below then terminates the old test's HOME processes.
      rm -f -- "$STATE/run.lock"
      exec 9>"$STATE/run.lock"
      flock -n 9 || { echo "Impossibile liberare il lock del test." >&2; exit 1; }
    else
      echo "Il test UI fixes risulta già aperto da un processo precedente." >&2
      echo "Se hai chiuso tutto, rilancia con --force per terminare l'istanza vecchia." >&2
      exit 1
    fi
  fi
fi

if [[ ! -d "$PROJECT/.git" ]]; then
  git -C "$PROJECT" init -q
  git -C "$PROJECT" -c user.name='Harness Remote UI Test' \
    -c user.email='test@example.invalid' commit --allow-empty -qm 'UI fixes test sandbox'
fi
if [[ ! -f "$PROJECT/README.md" ]]; then
  cat >"$PROJECT/README.md" <<'EOF'
# Harness Remote UI fixes test sandbox

Progetto isolato per il test delle correzioni UI: lista Session, ricerca, header della Session,
impostazioni e avviso di caricamento degli harness.
EOF
fi

build_apk() {
  echo "Costruzione APK debug dal working tree corrente…"
  npm --prefix "$ROOT/web" run build >"$LOGS/apk-web-build.log" 2>&1 || { cat "$LOGS/apk-web-build.log" >&2; exit 1; }
  # Call the installed Capacitor binary directly. `npx cap` can try to fetch the package from
  # npm, which fails in read-only npm caches and is unnecessary here.
  (cd "$ROOT/web" && ./node_modules/.bin/cap sync android) >"$LOGS/apk-sync.log" 2>&1 || {
    cat "$LOGS/apk-sync.log" >&2; exit 1;
  }
  (cd "$ROOT/web" && node scripts/sync-native-live-events.mjs) >>"$LOGS/apk-sync.log" 2>&1 || {
    cat "$LOGS/apk-sync.log" >&2; exit 1;
  }
  # Gradle and the Android tools are build caches, not app state. Use the normal cache when it is
  # writable; in a restricted sandbox fall back to a test cache so the manual environment still runs.
  local gradle_home android_home java_home
  if [[ -w "$HOME/.gradle" ]]; then gradle_home="$HOME/.gradle"; else gradle_home="$STATE/gradle"; fi
  if [[ -w "$HOME/.android" || ! -e "$HOME/.android" ]]; then android_home="$HOME/.android"; else android_home="$STATE/android"; fi
  java_home="${JAVA_HOME:-}"
  if [[ ! -x "$java_home/bin/java" ]] || ! "$java_home/bin/java" -version 2>&1 | grep -q 'version "21\.'; then
    java_home=""
    for candidate in "$HOME/.sdkman/candidates/java/current" /usr/lib/jvm/java-21-openjdk-amd64; do
      if [[ -x "$candidate/bin/java" ]] && "$candidate/bin/java" -version 2>&1 | grep -q 'version "21\.'; then
        java_home="$candidate"; break
      fi
    done
  fi
  [[ -n "$java_home" ]] || { echo "Serve Java 21 per compilare l'APK Capacitor." >&2; exit 1; }
  mkdir -p "$gradle_home" "$android_home"
  (cd "$ROOT/web/android" && JAVA_HOME="$java_home" PATH="$java_home/bin:$PATH" \
    GRADLE_USER_HOME="$gradle_home" ANDROID_USER_HOME="$android_home" \
    ./gradlew assembleDebug --no-daemon --console=plain) >"$LOGS/apk-gradle.log" 2>&1 || {
    tail -80 "$LOGS/apk-gradle.log" >&2; exit 1;
  }
  cp "$ROOT/web/android/app/build/outputs/apk/debug/app-debug.apk" "$APK"
  source_stamp >"$STATE/apk-stamp"
  echo "APK: $APK"
}

if [[ "$REBUILD_APK" == 1 ]] || ! apk_is_current; then
  build_apk
else
  echo "APK già aggiornato: $APK"
fi

echo "Compilo la vera app desktop Electron dal working tree corrente…"
npm --prefix "$ROOT/web" run build:desktop >"$LOGS/desktop-build.log" 2>&1 || { cat "$LOGS/desktop-build.log" >&2; exit 1; }
[[ -f "$ROOT/web/dist/index.html" && -f "$ROOT/web/dist-electron/electron/main.js" ]] || {
  echo "Build Electron incompleta." >&2; exit 1;
}
if [[ "$BUILD_ONLY" == 1 ]]; then
  echo "Build pronta: $ROOT/web/dist e $ROOT/web/dist-electron; APK: $APK"
  exit 0
fi

# A curated test PATH: only the harnesses this check needs, so machine discovery is deterministic
# and does not also start PI/DeepSeek/Codex from the daily environment.
find_tool() {
  local name=$1 candidate
  candidate="$(command -v "$name" 2>/dev/null || true)"
  if [[ -n "$candidate" ]]; then readlink -f "$candidate"; return 0; fi
  for candidate in "$HOME/.local/bin/$name" "$HOME/.opencode/bin/$name" "$HOME/.mimocode/bin/$name"; do
    [[ -x "$candidate" ]] && { readlink -f "$candidate"; return 0; }
  done
  return 1
}
NODE_REAL="$(find_tool node)" || { echo "node non trovato" >&2; exit 1; }
for tool in node copilot omp claude opencode; do
  real="$(find_tool "$tool" || true)"
  if [[ -z "$real" ]]; then
    if [[ "$tool" == "copilot" ]]; then
      echo "Avviso: Copilot non trovato nel PATH; la verifica Copilot verrà saltata." >&2
    else
      echo "Comando richiesto non trovato: $tool" >&2; exit 1
    fi
  else
    ln -sfn "$real" "$BIN/$tool"
  fi
done

cat >"$HOME_TEST/.bashrc" <<EOF
export PATH="$BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EOF
cp "$HOME_TEST/.bashrc" "$HOME_TEST/.bash_profile"
cp "$HOME_TEST/.bashrc" "$HOME_TEST/.profile"

stop_test_processes() {
  local proc pid group
  local -a groups=()
  for proc in /proc/[0-9]*; do
    pid="${proc#/proc/}"
    [[ "$pid" =~ ^[0-9]+$ && "$pid" != "$$" ]] || continue
    if cat "$proc/environ" 2>/dev/null | tr '\0' '\n' | grep -qx "HOME=$HOME_TEST"; then
      group="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" || continue
      [[ -n "$group" ]] && groups+=("$group")
      continue
    fi
    if cat "$proc/environ" 2>/dev/null | tr '\0' '\n' | grep -qx "HARNESS_REMOTE_ROOT=$PROJECT"; then
      group="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" || continue
      [[ -n "$group" ]] && groups+=("$group")
    fi
  done
  for group in "${groups[@]:-}"; do [[ -z "$group" ]] || kill -TERM -- "-$group" 2>/dev/null || true; done
  sleep 0.3
  for group in "${groups[@]:-}"; do [[ -z "$group" ]] || kill -KILL -- "-$group" 2>/dev/null || true; done
}

stop_test_processes
rm -rf "$DESKTOP"
mkdir -p "$DESKTOP"
printf '%s\n' '{"width":430,"height":900,"maximized":false}' >"$DESKTOP/window-state.json"
printf '%s\n' '{"lanPairing":true}' >"$DESKTOP/desktop-network-settings.json"
mkdir -p "$DESKTOP/embedded-daemon/npm-cache"
for real_cache in \
  "$HOME/.config/harness-remote-web/embedded-daemon/npm-cache" \
  "$HOME/.config/Harness Remote/embedded-daemon/npm-cache"; do
  [[ -d "$real_cache" ]] || continue
  for provider_cache in "$real_cache"/*; do
    [[ -d "$provider_cache" ]] || continue
    ln -sfn "$provider_cache" "$DESKTOP/embedded-daemon/npm-cache/$(basename "$provider_cache")"
  done
done

free_port() {
  "$NODE_REAL" --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
FAKE_PORT="$(free_port)"
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit }}')"
[[ -n "$LAN_IP" ]] || LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -n "$LAN_IP" ]] || { echo "Nessun indirizzo LAN trovato." >&2; exit 1; }

APP_PID=""
FAKE_PID=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  local proc pid group
  local -a daemon_groups=()
  for proc in /proc/[0-9]*/cmdline; do
    [[ -r "$proc" ]] || continue
    local command_line
    command_line="$(tr '\0' ' ' <"$proc" 2>/dev/null)" || continue
    [[ "$command_line" == *"$ROOT/bridge/src/daemon-cli.js"* ]] || continue
    [[ "$command_line" == *"--state-dir $DESKTOP/embedded-daemon"* ]] || continue
    pid="${proc#/proc/}"; pid="${pid%/cmdline}"
    group="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" || continue
    [[ -n "$group" && "$group" != "${APP_PID:-}" ]] && daemon_groups+=("$group")
  done
  for pid in "${FAKE_PID:-}" "${APP_PID:-}"; do
    [[ -z "$pid" ]] || kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for group in "${daemon_groups[@]:-}"; do [[ -z "$group" ]] || kill -TERM -- "-$group" 2>/dev/null || true; done
  for ((i=0; i<40; i++)); do
    local alive=0
    [[ -n "${APP_PID:-}" ]] && kill -0 -- "-$APP_PID" 2>/dev/null && alive=1
    [[ -n "${FAKE_PID:-}" ]] && kill -0 -- "-$FAKE_PID" 2>/dev/null && alive=1
    for group in "${daemon_groups[@]:-}"; do [[ -n "$group" ]] && kill -0 -- "-$group" 2>/dev/null && alive=1; done
    (( alive == 0 )) && break
    sleep 0.1
  done
  [[ -z "${APP_PID:-}" ]] || kill -KILL -- "-$APP_PID" 2>/dev/null || true
  [[ -z "${FAKE_PID:-}" ]] || kill -KILL -- "-$FAKE_PID" 2>/dev/null || true
  for group in "${daemon_groups[@]:-}"; do [[ -z "$group" ]] || kill -KILL -- "-$group" 2>/dev/null || true; done
  [[ -z "${APP_PID:-}" ]] || wait "$APP_PID" 2>/dev/null || true
  [[ -z "${FAKE_PID:-}" ]] || wait "$FAKE_PID" 2>/dev/null || true
  stop_test_processes
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

echo "Avvio la macchina UI Test deterministica su 0.0.0.0:$FAKE_PORT…"
setsid env UI_TEST_PORT="$FAKE_PORT" UI_TEST_USERNAME="$USERNAME" UI_TEST_PASSWORD="$PASSWORD" \
  UI_TEST_ROOT="$PROJECT" UI_TEST_MACHINE_NAME="UI Test" UI_TEST_MACHINE_ID="machine-ui-test" \
  "$NODE_REAL" "$FAKE" >"$LOGS/fake-daemon.log" 2>&1 &
FAKE_PID=$!
ready=0
for ((i=0; i<100; i++)); do
  if curl -fsS --max-time 1 -u "$USERNAME:$PASSWORD" "http://127.0.0.1:$FAKE_PORT/v1/machine" >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "$FAKE_PID" 2>/dev/null || break
  sleep 0.1
done
(( ready == 1 )) || { cat "$LOGS/fake-daemon.log" >&2; exit 1; }

echo "Avvio la vera app desktop Electron…"
cd "$PROJECT"
setsid env -u ELECTRON_RUN_AS_NODE -u HARNESS_REMOTE_ACP_COMMAND -u HARNESS_REMOTE_ACP_ARGS \
  HARNESS_REMOTE_ROOT="$PROJECT" HARNESS_REMOTE_TEST_QUIT_ON_CLOSE=1 \
  "$ROOT/web/node_modules/.bin/electron" "$ROOT/web" --no-sandbox --disable-gpu \
  --user-data-dir="$DESKTOP" >"$LOGS/electron.log" 2>&1 &
APP_PID=$!
runtime=0
for ((i=0; i<300; i++)); do
  [[ -f "$DESKTOP/embedded-daemon/machine.json" ]] && { runtime=1; break; }
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.2
done
(( runtime == 1 )) || { tail -60 "$LOGS/electron.log" >&2; exit 1; }
sleep 1

ADB="${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb"
INSTALLED=0
if [[ -x "$ADB" ]] && [[ "$("$ADB" devices | awk 'NR>1 && $2=="device"' | wc -l)" == 1 ]]; then
  echo "Installazione APK sul telefono collegato…"
  if "$ADB" install -r "$APK" >"$LOGS/adb-install.log" 2>&1; then INSTALLED=1; else
    echo "Installazione automatica fallita; vedi $LOGS/adb-install.log" >&2
  fi
fi

cat <<EOF

UI fixes — ambiente di test pronto
Working tree: $(git -C "$ROOT" rev-parse --short HEAD) ($(source_stamp | cut -c1-12))
Desktop: vera app Electron, profilo isolato
APK: $APK$([[ "$INSTALLED" == 1 ]] && echo ' (installato sul telefono collegato)')
Progetto sandbox: $PROJECT
Log: $LOGS

MACCHINA UI TEST (da aggiungere in Machines → Add machine)
  Nome:     UI Test
  URL:      http://$LAN_IP:$FAKE_PORT
  Utente:   $USERNAME
  Password: $PASSWORD

Checklist desktop
1. Apri "Questo computer": usa le tue sessioni reali, quindi qui devono comparire le Session
   che usi normalmente (chiudi prima l'app Harness Remote quotidiana, altrimenti può tenerle
   occupate). Devono comparire almeno OMP, Claude Code, OpenCode e Copilot.
   Copilot può risultare non disponibile se non è autenticato: la correzione riguarda il
   rilevamento degli altri tre, che prima sparivano per il PATH GUI.
2. Aggiungi la macchina "UI Test" con i dati sopra. Apri il suo progetto "sandbox".
3. Le Session della macchina "UI Test" devono comparire subito. Se un harness reale è
   lento, deve apparire solo la sua riga "Caricamento sessioni: ..." sopra le Session
   già disponibili, senza un riepilogo globale che copra la lista.
4. Apri "Riga sessione: cestino e rename". In alto a destra deve esserci il cestino
   senza dover entrare in rename. Clicca il titolo: il campo e i pulsanti devono restare
   dentro la finestra. Il cestino deve aprire la conferma.
5. Torna alla lista, clicca la lente. I filtri devono stare sopra i risultati, non
   coprirli. Cerca "Ricerca" e apri il risultato.
6. Apri "Ricerca mobile: filtri sopra i risultati" e verifica che il cestino ci sia
   anche da sessione già aperta.

Checklist telefono
7. Installa l'APK se non è stato installato sopra. È l'app debug "Harness Remote".
8. Desktop → Machines → "Questo computer" → Pair a phone; sul telefono scansiona il QR.
9. Sul telefono apri la macchina collegata e vai in Impostazioni → "Connessione in
   background": il testo deve essere leggibile e non sovrapporsi al pulsante.
10. Se vuoi provare header/ricerca/loading anche sul telefono, aggiungi la macchina
    "UI Test" con URL, utente e password qui sopra.

Chiudi Electron o premi Ctrl+C per fermare solo i processi di questo test.
EOF

wait "$APP_PID"
