import assert from "node:assert/strict"
import test from "node:test"
import { ACP_MODEL_CATALOG_TIMEOUT_MS, AcpAgentModelCatalog, HttpAgentModelCatalog, MODEL_CATALOG_TIMEOUT_MS } from "../src/agent-model-catalog.js"

const never = () => new Promise(() => {})

test("ACP model discovery reserves the cold-adapter startup budget", () => {
  const catalog = new AcpAgentModelCatalog({
    agent: { close() {} },
    agentID: "omp",
    directory: "/repo",
    stateDirectory: "/state"
  })
  assert.equal(catalog.timeoutMs, ACP_MODEL_CATALOG_TIMEOUT_MS)
  assert.ok(ACP_MODEL_CATALOG_TIMEOUT_MS > MODEL_CATALOG_TIMEOUT_MS)
})

test("ACP model catalog timeout is delegated to the bounded ACP client rather than a duplicate outer timer", async () => {
  const seen = []
  const agent = {
    async start() {},
    async request(method, _params, timeoutMs) {
      seen.push({ method, timeoutMs })
      throw new Error(`ACP request timed out after ${timeoutMs}ms`)
    },
    close() {}
  }
  const catalog = new AcpAgentModelCatalog({
    agent,
    agentID: "codex",
    directory: "/repo",
    stateDirectory: "/state",
    timeoutMs: 25
  })
  await assert.rejects(() => catalog.list({ allowStale: false }), /timed out after 25ms/)
  assert.equal(seen.every((call) => call.timeoutMs === 25), true)
  assert.equal(catalog.diagnostics().inFlight, false)
})

test("HTTP model discovery obeys the catalog-wide timeout budget", async () => {
  const host = { host: "127.0.0.1", port: 4096, async start() {} }
  const catalog = new HttpAgentModelCatalog({
    host,
    agentID: "opencode",
    fetchImpl: never,
    timeoutMs: 25
  })
  const started = Date.now()
  await assert.rejects(() => catalog.list({ allowStale: false }), /timed out after 25ms/)
  assert.ok(Date.now() - started < 500)
})