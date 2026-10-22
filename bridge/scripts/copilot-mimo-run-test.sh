#!/usr/bin/env bash
set -euo pipefail

reviewRoot=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
projectRoot=${HARNESS_REMOTE_COPILOT_MIMO_ROOT:-"$HOME/Software"}
testRoot=${HARNESS_REMOTE_COPILOT_MIMO_TEST_DIR:-"${XDG_STATE_HOME:-$HOME/.local/state}/harness-remote/copilot-mimo-test"}
runtimeRoot=${HARNESS_REMOTE_COPILOT_MIMO_RUNTIME:-"${XDG_DATA_HOME:-$HOME/.local/share}/harness-remote/test-runtime"}
sandboxRoot=${HARNESS_REMOTE_COPILOT_MIMO_SANDBOX:-"$HOME/Software/harness-remote-copilot-mimo-sandbox"}
nodeCommand=$(command -v node)
npmCommand=$(command -v npm)
mode=${1:-run}

if [[ "$mode" != run && "$mode" != --check ]]; then
  printf '%s\n' 'Usage: bash copilot-mimo-run-test.sh [--check]' >&2
  exit 2
fi
if [[ ! -d "$projectRoot" ]]; then
  printf 'Project root does not exist: %s\n' "$projectRoot" >&2
  exit 1
fi
if [[ ! -x "$reviewRoot/web/node_modules/.bin/vite" ]]; then
  printf 'The existing web dependencies are missing: %s\n' "$reviewRoot/web/node_modules" >&2
  printf '%s\n' 'Install dependencies in this worktree before running the test launcher.' >&2
  exit 1
fi
if [[ ! -d "$sandboxRoot/.git" || ! -f "$sandboxRoot/README.md" ]]; then
  printf 'The expected Git test sandbox is missing or incomplete: %s\n' "$sandboxRoot" >&2
  exit 1
fi

mkdir -p "$testRoot/state" "$runtimeRoot"
# Earlier test Sessions retain this native working-directory identity. Keep the scratch
# directory available while new tests and adapter installations use durable locations.
mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/harness-remote/copilot-mimo-test/sandbox"
exec {testLockFd}>"$testRoot/run.lock"
if ! flock -n "$testLockFd"; then
  printf 'This test environment is already running or starting. Use its existing terminal; Ctrl+C there stops it.\nState: %s\n' "$testRoot" >&2
  exit 1
fi
missingAdapters=$("$nodeCommand" - "$runtimeRoot" <<'JS'
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
const expected = new Map([
  ['@agentclientprotocol/codex-acp', '1.13.1'],
  ['@automatalabs/pi-acp', '0.5.0'],
  ['@agentclientprotocol/claude-agent-acp', '0.84.0']
])
for (const [name, version] of expected) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'))
    if (manifest.version === version) continue
  } catch {}
  process.stdout.write(`${name}@${version}\n`)
}
JS
)
if [[ -n "$missingAdapters" ]]; then
  mapfile -t adaptersToInstall <<< "$missingAdapters"
  "$npmCommand" install --prefix "$runtimeRoot" --include=optional --no-audit --no-fund "${adaptersToInstall[@]}"
fi

buildNeeded=0
if [[ ! -f "$reviewRoot/web/dist/index.html" ]]; then buildNeeded=1; fi
if (( buildNeeded == 0 )); then
  if find "$reviewRoot/web/src" "$reviewRoot/web/public" -type f -newer "$reviewRoot/web/dist/index.html" -print -quit | rg -q .; then buildNeeded=1; fi
  for sourceFile in "$reviewRoot/web/package.json" "$reviewRoot/web/package-lock.json" "$reviewRoot/web"/tsconfig*.json "$reviewRoot/web"/vite.config.*; do
    if [[ -f "$sourceFile" && "$sourceFile" -nt "$reviewRoot/web/dist/index.html" ]]; then buildNeeded=1; fi
  done
fi
if (( buildNeeded == 1 )); then
  printf '%s\n' 'Building updated frontend…'
  "$npmCommand" --prefix "$reviewRoot/web" run build > "$testRoot/build.log" 2>&1 || {
    cat "$testRoot/build.log" >&2
    exit 1
  }
fi

choose_port() {
  local startPort=$1
  shift
  "$nodeCommand" - "$reviewRoot/bridge/src/launcher.js" "$startPort" "$@" <<'JS'
const { pathToFileURL } = require('node:url')
const [modulePath, startPort, ...excludedPorts] = process.argv.slice(2)
import(pathToFileURL(modulePath).href).then(async ({ findAvailablePort }) => {
  const excluded = excludedPorts.map(Number).filter(Number.isInteger)
  const port = await findAvailablePort(Number(startPort), '127.0.0.1', 100, excluded)
  process.stdout.write(`${port}\n`)
}).catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
JS
}

backendPort=${HARNESS_REMOTE_COPILOT_MIMO_BACKEND_PORT:-$(choose_port 4914)}
webPort=${HARNESS_REMOTE_COPILOT_MIMO_WEB_PORT:-$(choose_port 4915 "$backendPort")}
openCodePort=${HARNESS_REMOTE_COPILOT_MIMO_OPENCODE_PORT:-$(choose_port 4916 "$backendPort" "$webPort")}
if [[ "$backendPort" == "$webPort" || "$backendPort" == "$openCodePort" || "$webPort" == "$openCodePort" ]]; then
  printf '%s\n' 'Backend, web and managed OpenCode ports must differ.' >&2
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
await loadMachineIdentity(stateDirectory, { hostname: () => 'Harness Remote Copilot and MiMo test' })
JS

daemonArgs=(
  "$reviewRoot/bridge/src/daemon-cli.js"
  --backend codex --acp-command "$runtimeRoot/node_modules/.bin/codex-acp"
  --host 127.0.0.1 --port "$backendPort"
  --username hr-copilot --password hr-copilot
  --opencode-port "$openCodePort"
  --root "$sandboxRoot" --root "$projectRoot"
  --state-dir "$testRoot/state"
  --cors "$webOrigin"
)
if [[ -d "$projectRoot/.git" || -f "$projectRoot/.git" ]]; then daemonArgs+=(--root "$projectRoot"); fi
for candidate in "$sandboxRoot"/* "$projectRoot"/*; do
  [[ -d "$candidate" && ( -d "$candidate/.git" || -f "$candidate/.git" ) ]] || continue
  daemonArgs+=(--root "$candidate")
done

cd "$projectRoot"
setsid env -u GH_TOKEN -u GITHUB_TOKEN \
  "PATH=$runtimeRoot/node_modules/.bin:$PATH" HARNESS_REMOTE_ACP_ARGS='[]' \
  HARNESS_REMOTE_COPILOT_MODEL=auto HARNESS_REMOTE_MIMO_CONFIG_CONTENT='{"model":"openai/gpt-6-luna"}' \
  "$nodeCommand" "${daemonArgs[@]}" > "$testRoot/daemon.log" 2>&1 &
daemonPid=$!
setsid "$nodeCommand" "$reviewRoot/web/node_modules/vite/bin/vite.js" preview \
  "$reviewRoot/web" \
  --host 127.0.0.1 --port "$webPort" --strictPort --outDir "$reviewRoot/web/dist" \
  > "$testRoot/web.log" 2>&1 &
webPid=$!

ready=0
for ((attempt=0; attempt<150; attempt++)); do
  if ! kill -0 "$daemonPid" 2>/dev/null || ! kill -0 "$webPid" 2>/dev/null; then
    cat "$testRoot/daemon.log" "$testRoot/web.log" >&2
    exit 1
  fi
  if curl --silent --fail --max-time 1 --user hr-copilot:hr-copilot "http://127.0.0.1:$backendPort/v1/machine" > /dev/null \
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

curl --silent --show-error --fail --max-time 2 --user hr-copilot:hr-copilot \
  "http://127.0.0.1:$backendPort/v1/machine" > "$testRoot/machine.json"
if [[ "${HARNESS_REMOTE_PREWARM_CATALOGS:-0}" == 1 ]]; then
printf '%s\n' 'Preparing native model catalogs (optional; no prompts are sent)…'
"$nodeCommand" - "$backendPort" "$testRoot/machine.json" <<'JS'
const fs = require('node:fs')
const machine = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const origin = `http://127.0.0.1:${process.argv[2]}`
const headers = { Authorization: `Basic ${Buffer.from('hr-copilot:hr-copilot').toString('base64')}` }
Promise.all((machine.agents ?? []).filter((agent) => agent.id !== 'claude' && agent.capabilities?.models).map(async (agent) => {
  const deadline = Date.now() + 100000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/v1/agents/${encodeURIComponent(agent.id)}/models?waitMs=4000`, { headers, signal: AbortSignal.timeout(6000) })
      const catalog = await response.json()
      if (response.ok && !catalog.loading && catalog.models?.length) {
        process.stdout.write(`  ${agent.label ?? agent.id}: catalog ready\n`)
        return
      }
      if (!catalog.loading) break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  process.stdout.write(`  ${agent.label ?? agent.id}: catalog unavailable; inspect daemon.log\n`)
})).catch(() => { process.exitCode = 1 })
JS
fi
if [[ "$mode" == --check ]]; then
  curl --silent --show-error --fail --max-time 5 --user hr-copilot:hr-copilot \
    "http://127.0.0.1:$backendPort/v1/projects" > "$testRoot/projects.json"
  "$nodeCommand" - "$testRoot/machine.json" "$testRoot/projects.json" "$sandboxRoot" <<'JS'
const fs = require('node:fs')
const path = require('node:path')
const machine = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const projects = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const sandbox = path.resolve(process.argv[4])
if (!machine?.machine?.id || !Array.isArray(machine.agents)) throw new Error('Invalid /v1/machine metadata')
const expected = ['omp', 'pi', 'claude', 'codex', 'opencode2', 'copilot', 'mimo']
const missing = expected.filter((id) => !machine.agents.some((agent) => agent.id === id))
if (missing.length) throw new Error(`Missing test harnesses: ${missing.join(', ')}`)
if (!Array.isArray(projects?.projects)) throw new Error('Invalid /v1/projects metadata')
if (!projects.projects.some((project) => path.resolve(project.path) === sandbox)) {
  throw new Error(`The visible Git sandbox is missing from /v1/projects: ${sandbox}`)
}
process.stdout.write(`Machine metadata valid; ${machine.agents.length} harness(es) listed; ${projects.projects.length} project(s) visible; test sandbox is listed.\n`)
JS
fi

printf 'Browser URL: %s\nMachine name: Harness Remote Copilot and MiMo test\nMachine URL: http://127.0.0.1:%s\nHost: 127.0.0.1\nPort: %s\nUsername: hr-copilot\nPassword: hr-copilot\nProject root: %s\nTest sandbox: %s\nReserved legacy OpenCode port (unused here): %s\nLogs: %s\nDetected harnesses:' \
  "$webOrigin" "$backendPort" "$backendPort" "$projectRoot" "$sandboxRoot" "$openCodePort" "$testRoot"
"$nodeCommand" - "$testRoot/machine.json" <<'JS'
const fs = require('node:fs')
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
for (const agent of value.agents ?? []) {
  const label = typeof agent.label === 'string' ? agent.label : agent.backend
  if (typeof label === 'string') process.stdout.write(`\n  ${label} [${agent.id}]`)
}
process.stdout.write('\n')
JS
cat <<'TXT'
Native CLI credentials stay in the usual home directory. The daemon starts without injected GH_TOKEN or GITHUB_TOKEN; Copilot uses the native CLI's authentication. Test models: Copilot Auto; MiMo OpenAI gpt-6-luna.
TXT

if [[ "$mode" == --check ]]; then exit 0; fi
if [[ "${HARNESS_REMOTE_NO_BROWSER:-0}" != 1 ]]; then xdg-open "$webOrigin" >/dev/null 2>&1 || true; fi
printf '%s\n' 'Keep this terminal open; Ctrl+C stops both test servers.'
wait -n "$daemonPid" "$webPid"
