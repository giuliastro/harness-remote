#!/usr/bin/env bash
set -euo pipefail
reviewRoot=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
testRoot=${HARNESS_REMOTE_OPENCODE2_TEST_DIR:-"${XDG_CACHE_HOME:-$HOME/.cache}/harness-remote/issue552-test"}
runtimeRoot=${HARNESS_REMOTE_OPENCODE2_RUNTIME_DIR:-"${XDG_CACHE_HOME:-$HOME/.cache}/harness-remote/issue552-runtime"}
nodeCommand=$(command -v node)
npmCommand=$(command -v npm)
mode=${1:-run}
if [[ "$mode" != run && "$mode" != --check ]]; then
  printf '%s\n' 'Usage: bash opencode2-run-test.sh [--check]' >&2
  exit 2
fi
mkdir -p "$testRoot"/{bin,sandbox,state,data,cache}
runtimeCommand="$runtimeRoot/node_modules/.bin/opencode2"
if [[ ! -x "$runtimeCommand" ]] || [[ "$("$runtimeCommand" --version)" != 'opencode v2.0.28' ]]; then
  "$npmCommand" install --prefix "$runtimeRoot" --no-audit --no-fund @opencode/cli@2.0.28
fi
if [[ ! -x "$reviewRoot/web/node_modules/.bin/vite" ]]; then
  "$npmCommand" ci --prefix "$reviewRoot/web" --ignore-scripts --no-audit --no-fund
fi
"$npmCommand" --prefix "$reviewRoot/web" run build > "$testRoot/build.log" 2>&1 || { cat "$testRoot/build.log" >&2; exit 1; }
printf '# OpenCode 2 ACP sandbox\n\nUse this project for issue #552 tests.\n' > "$testRoot/sandbox/README.md"
if [[ ! -d "$testRoot/sandbox/.git" ]]; then git -C "$testRoot/sandbox" init --quiet; fi
# Isolate v2's native sessions/cache. Free-model access and existing provider configuration are
# inherited; no credentials or global installation are modified by this script.
cat > "$testRoot/bin/opencode2" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
export XDG_DATA_HOME="$HR_OPENCODE2_TEST_ROOT/data"
export XDG_CACHE_HOME="$HR_OPENCODE2_TEST_ROOT/cache"
export XDG_STATE_HOME="$HR_OPENCODE2_TEST_ROOT/state/native"
export OPENCODE_CONFIG_CONTENT='{"model":"opencode/longcat-2.5-preview-free"}'
exec "$HR_OPENCODE2_TEST_CLI" "$@"
SH
chmod +x "$testRoot/bin/opencode2"
ln -sf "$nodeCommand" "$testRoot/bin/node"
# This focused machine exposes only v2; the normal launcher remains available for regression
# machines. A separate PATH also prevents accidental probing of unrelated installed harnesses.
nativePort=${HARNESS_REMOTE_OPENCODE2_NATIVE_PORT:-$("$nodeCommand" --input-type=module -e 'import net from "node:net";const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}
webPort=${HARNESS_REMOTE_OPENCODE2_WEB_PORT:-$("$nodeCommand" --input-type=module -e 'import net from "node:net";const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}
nativePid=''
webPid=''
cleanup() {
  trap - EXIT INT TERM
  # setsid creates groups owned by this launcher; never kill processes by port or name.
  for pid in "$webPid" "$nativePid"; do
    if [[ -n "$pid" ]]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  done
  for pid in "$webPid" "$nativePid"; do
    if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$reviewRoot"
"$nodeCommand" --input-type=module - "$testRoot/state" <<'JS'
import { loadMachineIdentity } from './bridge/src/machine-registry.js'
await loadMachineIdentity(process.argv[2], { hostname: () => 'OpenCode 2 · issue 552' })
JS
HR_OPENCODE2_TEST_ROOT="$testRoot" HR_OPENCODE2_TEST_CLI="$runtimeCommand" PATH="$testRoot/bin:/usr/bin:/bin" \
  setsid "$nodeCommand" bridge/src/daemon-cli.js --backend opencode2 --no-opencode \
  --host 127.0.0.1 --port "$nativePort" --username issue552 --password issue552 \
  --root "$testRoot/sandbox" --state-dir "$testRoot/state" \
  --cors "http://127.0.0.1:$webPort" > "$testRoot/daemon.log" 2>&1 &
nativePid=$!
setsid "$nodeCommand" web/node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port "$webPort" --strictPort \
  --outDir "$reviewRoot/web/dist" > "$testRoot/web.log" 2>&1 &
webPid=$!
for ((attempt=0; attempt<100; attempt++)); do
  if ! kill -0 "$nativePid" 2>/dev/null || ! kill -0 "$webPid" 2>/dev/null; then
    cat "$testRoot/daemon.log" "$testRoot/web.log" >&2; exit 1
  fi
  if curl --silent --fail --max-time 1 --user issue552:issue552 "http://127.0.0.1:$nativePort/v1/machine" > /dev/null \
    && curl --silent --fail --max-time 1 "http://127.0.0.1:$webPort" > /dev/null; then break; fi
  sleep 0.2
done
curl --silent --fail --max-time 2 --user issue552:issue552 "http://127.0.0.1:$nativePort/v1/machine" > "$testRoot/machine.json"
curl --silent --fail --max-time 2 "http://127.0.0.1:$webPort" > /dev/null
printf 'Browser: http://127.0.0.1:%s\nMachine name: OpenCode 2 test\nMachine URL: http://127.0.0.1:%s\nUsername: issue552\nPassword: issue552\nProject: %s/sandbox\nLogs: %s\n' "$webPort" "$nativePort" "$testRoot" "$testRoot"
if [[ "$mode" == --check ]]; then exit 0; fi
if [[ "${HARNESS_REMOTE_NO_BROWSER:-0}" != 1 ]]; then xdg-open "http://127.0.0.1:$webPort" >/dev/null 2>&1 || true; fi
printf '%s\n' 'Keep this terminal open; Ctrl+C stops both test servers.'
wait -n "$nativePid" "$webPid"
