import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath))
}

const workflow = read(".github/workflows/pr-checks.yml")
const webPackage = JSON.parse(read("web/package.json"))
const bridgePackage = JSON.parse(read("bridge/package.json"))

const REQUIRED_BROWSER_SMOKES = [
  "scripts/native-session-navigation-smoke.mjs",
  "scripts/native-claude-browser-smoke.mjs",
  "scripts/native-session-reconnect-smoke.mjs",
  "scripts/native-session-browser-smoke.mjs",
  "scripts/native-opencode-browser-smoke.mjs",
  "scripts/native-opencode-real-regression-smoke.mjs",
  "scripts/native-opencode-permission-regression-smoke.mjs",
  "scripts/native-session-model-switch-smoke.mjs",
  "scripts/native-session-outcome-browser-smoke.mjs",
  "scripts/cross-machine-continuation-browser-smoke.mjs"
]

const REQUIRED_WEB_CONTRACTS = [
  "src/session-first-regression.test.mjs",
  "src/native-session-discovery.test.mjs",
  "src/native-session-continuation.test.mjs",
  "src/native-session-handoff-recovery.test.mjs",
  "src/omp-session-multi-turn.test.mjs",
  "src/omp-session-model-projection.test.mjs",
  "src/native-session-observer.test.mjs",
  "test:native-session-model-lifecycle"
]

const REQUIRED_BRIDGE_PROVIDER_TESTS = [
  "bridge/test/claude-v3-regression.test.js",
  "bridge/test/codex-session-history.test.js",
  "bridge/test/omp-acp-lifecycle.test.js",
  "bridge/test/pi-session-history.test.js",
  "bridge/test/opencode-host.test.js",
  "bridge/test/harness-capability-contract.test.js",
  "bridge/test/native-session-claim-lifecycle.test.js",
  "bridge/test/native-session-model-routing.test.js",
  "bridge/test/real-harness-release-gate.test.js"
]

test("blocking PR workflow keeps the Native Session behavioral gates wired", () => {
  assert.match(workflow, /run: npm run test:ci:full\s+working-directory: web/, "web full regression tier must remain blocking")
  assert.match(workflow, /run: npm test\s+working-directory: bridge/, "bridge behavioral suite must remain blocking")
  assert.match(workflow, /Run OpenCode permission transport regression[\s\S]*opencode-permission-api\.test\.mjs/, "fail-closed OpenCode permission transport must remain a blocking regression")

  for (const smoke of REQUIRED_BROWSER_SMOKES) {
    assert.ok(exists(`web/${smoke}`), `missing browser smoke: web/${smoke}`)
    assert.ok(workflow.includes(`node ${smoke}`), `${smoke} must remain in the blocking Chromium product smoke`)
  }
})

test("canonical web full tier keeps the shared Native Session lifecycle contracts", () => {
  const full = webPackage.scripts?.["test:ci:full"]
  assert.equal(typeof full, "string", "web test:ci:full must exist")

  for (const contract of REQUIRED_WEB_CONTRACTS) {
    assert.ok(full.includes(contract), `${contract} must remain in web test:ci:full`)
  }

  assert.ok(full.includes("test:events"), "live-event regressions must remain in web test:ci:full")
  assert.ok(full.includes("test:native-response"), "native response regressions must remain in web test:ci:full")
})

test("bridge CI auto-discovers provider-specific and release-gate reliability tests", () => {
  assert.equal(bridgePackage.scripts?.test, "node --test", "bridge npm test must keep Node test auto-discovery")

  for (const relativePath of REQUIRED_BRIDGE_PROVIDER_TESTS) {
    assert.ok(exists(relativePath), `${relativePath} is part of the supported-harness reliability contract`)
  }
})
