import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpAgentModelCatalog, HttpAgentModelCatalog, modelsFromProvidersResponse } from "../src/agent-model-catalog.js"

class FakeAcp extends EventEmitter {
  starts = 0
  newCalls = 0
  loadCalls = 0
  models = ["provider/one", "provider/two"]
  async start() { this.starts += 1 }
  close() {}
  options() {
    return [{ id: "model", currentValue: this.models[0], options: this.models.map((value) => ({ value, name: value.split("/").at(-1) })) }]
  }
  async request(method, params) {
    if (method === "session/new") {
      this.newCalls += 1
      assert.equal(params.cwd, "/repo")
      return { sessionId: "catalog-session", configOptions: this.options() }
    }
    if (method === "session/load") {
      this.loadCalls += 1
      assert.equal(params.sessionId, "catalog-session")
      return { configOptions: this.options() }
    }
    throw new Error(`unexpected method ${method}`)
  }
}

test("ACP model discovery keeps one catalog load per adapter lifetime unless explicitly refreshed", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-catalog-"))
  try {
    const agent = new FakeAcp()
    const catalog = new AcpAgentModelCatalog({ agent, agentID: "pi", directory: "/repo", stateDirectory })
    const first = await catalog.list({ allowStale: false })
    assert.deepEqual(first.models.map((model) => model.modelID), ["one", "two"])
    assert.equal(agent.newCalls, 1)

    agent.models = ["provider/two", "provider/three"]
    const cached = await catalog.list({ allowStale: false })
    assert.deepEqual(cached.models.map((model) => model.modelID), ["one", "two"])
    assert.equal(agent.newCalls, 1)
    assert.equal(agent.loadCalls, 0, "opening model pickers must not reload the technical ACP session")

    const refreshed = await catalog.list({ allowStale: false, refresh: true })
    assert.deepEqual(refreshed.models.map((model) => model.modelID), ["two", "three"])
    assert.equal(agent.loadCalls, 1)
    await assert.rejects(() => catalog.validate({ providerID: "provider", modelID: "one" }), /no longer available/)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("ACP catalog invalidates its in-memory models when the dedicated adapter exits", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-catalog-exit-"))
  try {
    const agent = new FakeAcp()
    const catalog = new AcpAgentModelCatalog({ agent, agentID: "omp", directory: "/repo", stateDirectory })
    await catalog.list({ allowStale: false })
    assert.equal(agent.newCalls, 1)
    assert.equal(agent.loadCalls, 0)

    agent.models = ["provider/three"]
    agent.emit("exit", new Error("adapter restarted"))
    const reloaded = await catalog.list({ allowStale: false })
    assert.deepEqual(reloaded.models.map((model) => model.modelID), ["three"])
    assert.equal(agent.loadCalls, 1, "a restarted adapter must load the persisted catalog session once")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("ACP model discovery reuses persisted catalog session after daemon restart", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-catalog-restart-"))
  try {
    const firstAgent = new FakeAcp()
    const first = new AcpAgentModelCatalog({ agent: firstAgent, agentID: "claude", directory: "/repo", stateDirectory })
    await first.list({ allowStale: false })
    const restartedAgent = new FakeAcp()
    const restarted = new AcpAgentModelCatalog({ agent: restartedAgent, agentID: "claude", directory: "/repo", stateDirectory })
    const result = await restarted.list({ allowStale: false })
    assert.equal(restartedAgent.newCalls, 0)
    assert.equal(restartedAgent.loadCalls, 1)
    assert.equal(restarted.hiddenSessionIDs.has("catalog-session"), true)
    assert.equal(result.stale, false)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("persisted ACP catalog session is hidden immediately after daemon restart", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-catalog-preload-"))
  try {
    const first = new AcpAgentModelCatalog({ agent: new FakeAcp(), agentID: "codex", directory: "/repo", stateDirectory })
    await first.list({ allowStale: false })

    const restartedAgent = new FakeAcp()
    const restarted = new AcpAgentModelCatalog({ agent: restartedAgent, agentID: "codex", directory: "/repo", stateDirectory })
    await restarted.preloadState()

    assert.equal(restarted.hiddenSessionIDs.has("catalog-session"), true)
    assert.equal(restartedAgent.starts, 0, "preload must not start the ACP adapter")
    assert.equal(restartedAgent.loadCalls, 0, "preload must not load or probe the session")
    assert.equal(restartedAgent.newCalls, 0, "preload must not create a new session")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("HTTP model discovery refreshes managed harness each time", async () => {
  let calls = 0
  let models = { one: { id: "one", name: "One" } }
  const host = { host: "127.0.0.1", port: 4096, async start() {} }
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      calls += 1
      return { providers: [{ id: "openai", name: "OpenAI", models }], default: { openai: Object.keys(models)[0] } }
    }
  })
  const catalog = new HttpAgentModelCatalog({ host, agentID: "opencode", fetchImpl })
  assert.deepEqual((await catalog.list()).models.map((model) => model.modelID), ["one"])
  models = { two: { id: "two", name: "Two" } }
  assert.deepEqual((await catalog.list()).models.map((model) => model.modelID), ["two"])
  assert.equal(calls, 2)
})

test("provider catalog keeps one exact selection per model variant and skips disabled models", () => {
  const result = modelsFromProvidersResponse({
    providers: [{
      id: "openai",
      name: "OpenAI",
      models: {
        disabled: { id: "disabled", name: "Disabled", enabled: false },
        reasoning: {
          id: "reasoning",
          name: "Reasoning Model",
          variants: { low: {}, high: {} },
          limit: { context: 200_000, output: 32_000 },
          cost: { input: 2, output: 8 }
        },
        free: {
          id: "free",
          name: "Free Model",
          variants: [{ id: "fast" }, { id: "fast" }],
          cost: [{ input: 0, output: 0 }]
        }
      }
    }],
    default: { openai: "reasoning" }
  })

  assert.deepEqual(result.map((model) => `${model.modelID}:${model.variant || "base"}`), [
    "reasoning:base",
    "reasoning:low",
    "reasoning:high",
    "free:base",
    "free:fast"
  ])
  assert.equal(result.some((model) => model.modelID === "disabled"), false)
  assert.equal(result.find((model) => model.modelID === "reasoning" && !model.variant)?.isDefault, true)
  assert.equal(result.find((model) => model.modelID === "reasoning")?.isFree, false)
  assert.equal(result.find((model) => model.modelID === "reasoning")?.inputCost, 2)
  assert.equal(result.find((model) => model.modelID === "free")?.isFree, true)
  assert.equal(result.find((model) => model.modelID === "free")?.inputCost, 0)
})
