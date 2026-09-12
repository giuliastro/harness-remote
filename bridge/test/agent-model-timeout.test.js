import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { ACP_MODEL_CATALOG_TIMEOUT_MS, AcpAgentModelCatalog, HttpAgentModelCatalog, MODEL_CATALOG_TIMEOUT_MS } from "../src/agent-model-catalog.js"

const never = () => new Promise(() => {})

test("ACP model discovery reserves a larger but finite cold-adapter budget", () => {
  const catalog = new AcpAgentModelCatalog({
    agent: { close() {} },
    agentID: "omp",
    directory: "/repo",
    stateDirectory: "/state"
  })
  assert.equal(catalog.timeoutMs, ACP_MODEL_CATALOG_TIMEOUT_MS)
  assert.ok(ACP_MODEL_CATALOG_TIMEOUT_MS > MODEL_CATALOG_TIMEOUT_MS)
})

test("ACP catalog passes one shrinking total budget through startup and Session creation", async () => {
  const seen = []
  let startupBudget
  const agent = {
    async start(timeoutMs) { startupBudget = timeoutMs },
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
  await assert.rejects(() => catalog.list({ allowStale: false }), /timed out(?: during .*?)? after/)
  assert.ok(startupBudget > 0 && startupBudget <= 25)
  assert.equal(seen[0]?.method, "session/new")
  assert.ok(seen[0]?.timeoutMs > 0 && seen[0]?.timeoutMs <= startupBudget)
  assert.equal(catalog.diagnostics().inFlight, false)
})

test("optional ACP variant probing is bounded and cannot invalidate base models", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-variant-timeout-"))
  try {
    const options = [{
      id: "model",
      currentValue: "provider/one",
      options: [
        { value: "provider/one", name: "One" },
        { value: "provider/two", name: "Two" },
        { value: "provider/three", name: "Three" }
      ]
    }, {
      id: "thinking",
      currentValue: "medium",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }]
    }]
    const seenTimeouts = []
    const agent = {
      async start() {},
      async request(method, _params, timeoutMs) {
        if (method === "session/new") return { sessionId: "technical", configOptions: options }
        if (method === "session/set_config_option") {
          seenTimeouts.push(timeoutMs)
          throw new Error("slow optional variant probe")
        }
        throw new Error(`unexpected ${method}`)
      },
      close() {}
    }
    const catalog = new AcpAgentModelCatalog({
      agent,
      agentID: "omp",
      directory: "/repo",
      stateDirectory,
      timeoutMs: 100,
      variantConfigIDs: ["thinking"]
    })
    const result = await catalog.list({ allowStale: false })
    assert.deepEqual(result.models.filter((model) => !model.variant).map((model) => model.modelID), ["one", "two", "three"])
    assert.equal(result.models.some((model) => model.modelID === "one" && model.variant === "high"), true)
    assert.equal(catalog.diagnostics().variantProbe.incomplete, true)
    assert.equal(seenTimeouts.every((timeout) => timeout > 0 && timeout <= 100), true)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("HTTP model discovery obeys the catalog-wide timeout budget", { timeout: 10_000 }, async () => {
  const host = { host: "127.0.0.1", port: 4096, async start() {} }
  const catalog = new HttpAgentModelCatalog({
    host,
    agentID: "opencode",
    fetchImpl: never,
    timeoutMs: 25
  })
  // The catalog's own timeout message proves its 25ms budget won against a fetch that never settles.
  // Do not assert process wall time: a paused CI runner can resume seconds later even though the
  // catalog used the correct internal budget.
  await assert.rejects(() => catalog.list({ allowStale: false }), /timed out after 25ms/)
})