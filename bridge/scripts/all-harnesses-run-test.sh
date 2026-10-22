#!/usr/bin/env bash
set -euo pipefail

reviewRoot=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
projectRoot=${HARNESS_REMOTE_ALL_HARNESSES_ROOT:-"$HOME/Software"}
testRoot=${HARNESS_REMOTE_ALL_HARNESSES_TEST_DIR:-"${XDG_CACHE_HOME:-$HOME/.cache}/harness-remote/issue552-all-harnesses"}
runtimeRoot="$testRoot/runtime"
nodeCommand=$(command -v node)
npmCommand=$(command -v npm)
mode=${1:-run}

if [[ "$mode" != run && "$mode" != --check ]]; then
  printf '%s\n' 'Usage: bash all-harnesses-run-test.sh [--check]' >&2
  exit 2
fi
if [[ ! -d "$projectRoot" ]]; then
  printf 'Project root does not exist: %s\n' "$projectRoot" >&2
  exit 1
fi

mkdir -p "$testRoot/state" "$runtimeRoot"
if [[ ! -x "$reviewRoot/web/node_modules/.bin/vite" ]]; then
  "$npmCommand" ci --prefix "$reviewRoot/web" --ignore-scripts --no-audit --no-fund
fi

if ! "$nodeCommand" - "$runtimeRoot" <<'JS'
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
const expected = new Map([
  ['@agentclientprotocol/codex-acp', '1.13.1'],
  ['@automatalabs/pi-acp', '0.5.0']
])
for (const [name, version] of expected) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'))
    if (manifest.version !== version) process.exit(1)
  } catch {
    process.exit(1)
  }
}
JS
then
  "$npmCommand" install --prefix "$runtimeRoot" --no-audit --no-fund \
    @agentclientprotocol/codex-acp@1.13.1 @automatalabs/pi-acp@0.5.0
fi

"$npmCommand" --prefix "$reviewRoot/web" run build > "$testRoot/build.log" 2>&1 || {
  cat "$testRoot/build.log" >&2
  exit 1
}

choose_port() {
  local startPort=$1 excludedPort=$2
  "$nodeCommand" - "$reviewRoot/bridge/src/launcher.js" "$startPort" "$excludedPort" <<'JS'
const { pathToFileURL } = require('node:url')
const [modulePath, startPort, excludedPort] = process.argv.slice(2)
import(pathToFileURL(modulePath).href).then(async ({ findAvailablePort }) => {
  const port = await findAvailablePort(Number(startPort), '127.0.0.1', 100, [Number(excludedPort)])
  process.stdout.write(`${port}\n`)
}).catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
JS
}

backendPort=${HARNESS_REMOTE_ALL_HARNESSES_BACKEND_PORT:-$(choose_port 4910 0)}
webPort=${HARNESS_REMOTE_ALL_HARNESSES_WEB_PORT:-$(choose_port 4911 "$backendPort")}
if [[ "$backendPort" == "$webPort" ]]; then
  printf '%s\n' 'Backend and web ports must differ.' >&2
  exit 2
fi
webOrigin="http://127.0.0.1:$webPort"
daemonPid=''
webPid=''

cleanup() {
  trap - EXIT INT TERM
  local pid attempt
  for pid in "$webPid" "$daemonPid"; do
    if [[ -n "$pid" ]]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  done
  for ((attempt=0; attempt<25; attempt++)); do
    local remaining=0
    for pid in "$webPid" "$daemonPid"; do
      if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then remaining=1; fi
    done
    (( remaining == 0 )) && break
    sleep 0.2
  done
  for pid in "$webPid" "$daemonPid"; do
    if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  done
  for pid in "$webPid" "$daemonPid"; do
    if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$reviewRoot"
"$nodeCommand" --input-type=module - "$reviewRoot/bridge/src/machine-registry.js" "$testRoot/state" <<'JS'
import { pathToFileURL } from 'node:url'
const [modulePath, stateDirectory] = process.argv.slice(2)
const { loadMachineIdentity } = await import(pathToFileURL(modulePath).href)
await loadMachineIdentity(stateDirectory, { hostname: () => 'Harness Remote all harnesses' })
JS

cd "$projectRoot"
PATH="$runtimeRoot/node_modules/.bin:$PATH" HARNESS_REMOTE_ACP_ARGS='[]' \
  setsid "$nodeCommand" "$reviewRoot/bridge/src/daemon-cli.js" \
  --backend codex --acp-command "$runtimeRoot/node_modules/.bin/codex-acp" --no-opencode \
  --host 127.0.0.1 --port "$backendPort" --username hr552 --password hr552 \
  --root "$projectRoot" --state-dir "$testRoot/state" --cors "$webOrigin" \
  > "$testRoot/daemon.log" 2>&1 &
daemonPid=$!
setsid "$nodeCommand" "$reviewRoot/web/node_modules/vite/bin/vite.js" preview \
  "$reviewRoot/web" \
  --host 127.0.0.1 --port "$webPort" --strictPort --outDir "$reviewRoot/web/dist" \
  > "$testRoot/web.log" 2>&1 &
webPid=$!

ready=0
for ((attempt=0; attempt<100; attempt++)); do
  if ! kill -0 "$daemonPid" 2>/dev/null || ! kill -0 "$webPid" 2>/dev/null; then
    cat "$testRoot/daemon.log" "$testRoot/web.log" >&2
    exit 1
  fi
  if curl --silent --fail --max-time 1 --user hr552:hr552 "http://127.0.0.1:$backendPort/v1/machine" > /dev/null \
    && curl --silent --fail --max-time 1 "$webOrigin" > /dev/null; then
    ready=1
    break
  fi
  sleep 0.2
done
if (( ready == 0 )); then
  cat "$testRoot/daemon.log" "$testRoot/web.log" >&2
  printf '%s\n' 'Harness Remote test servers did not become ready.' >&2
  exit 1
fi

curl --silent --show-error --fail --max-time 2 --user hr552:hr552 \
  "http://127.0.0.1:$backendPort/v1/machine" > "$testRoot/machine.json"
if [[ "$mode" == --check ]]; then
  curl --silent --show-error --fail --max-time 3 --user hr552:hr552 \
    "http://127.0.0.1:$backendPort/v1/projects" > "$testRoot/projects.json"
  "$nodeCommand" - "$testRoot/machine.json" "$testRoot/projects.json" <<'JS'
const fs = require('node:fs')
const machine = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const projects = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
if (!machine?.machine?.id || !Array.isArray(machine.agents)) throw new Error('Invalid /v1/machine metadata')
if (!Array.isArray(projects?.projects)) throw new Error('Invalid /v1/projects metadata')
process.stdout.write(`Machine metadata valid; ${projects.projects.length} project(s) visible.\n`)
JS
fi

printf 'Browser URL: %s\nMachine name: Harness Remote all harnesses\nMachine URL: http://127.0.0.1:%s\nHost: 127.0.0.1\nPort: %s\nUsername: hr552\nPassword: hr552\nProject root: %s\nLogs: %s\nDetected harnesses:' \
  "$webOrigin" "$backendPort" "$backendPort" "$projectRoot" "$testRoot"
"$nodeCommand" - "$testRoot/machine.json" <<'JS'
const fs = require('node:fs')
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
for (const agent of value.agents ?? []) {
  const label = typeof agent.label === 'string' ? agent.label : agent.backend
  if (typeof label === 'string') process.stdout.write(`\n  ${label}`)
}
process.stdout.write('\n')
JS
cat <<'TXT'
Authorized manual test models: Codex gpt-6-luna; Oh My Pi openrouter/free; PI qwen/qwen3.8-27b:free; OpenCode opencode/longcat-2.5-preview-free. Claude Code may be listed, but do not run Claude tests or prompts.
TXT

if [[ "$mode" == --check ]]; then exit 0; fi
if [[ "${HARNESS_REMOTE_NO_BROWSER:-0}" != 1 ]]; then xdg-open "$webOrigin" >/dev/null 2>&1 || true; fi
printf '%s\n' 'Keep this terminal open; Ctrl+C stops both test servers.'
wait -n "$daemonPid" "$webPid"
