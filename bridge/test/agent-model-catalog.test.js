import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpAgentModelCatalog, HttpAgentModelCatalog } from "../src/agent-model-catalog.js"

class FakeAcp {
  starts = 0
  closes = 0
  newCalls = 0
  loadCalls = 0
  models = ["provider/one", "provider/two"]
  requestTimeouts = []

  async start() { this.starts += 1 }
  close() { this.closes += 1 }

  options() {
    return [{
      id: "model",
      currentValue: this.models[0],
      options: this.models.map((value) => ({ value, name: value.split("/").at(-1) }))
    }]
  }

  async request(method, params, timeoutMs) {
    this.requestTimeouts.push({ method, timeoutMs })
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

test("ACP model discovery creates one durable catalog session then refreshes it", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-catalog-"))
  try {
    const agent = new FakeAcp()
    const catalog = new AcpAgentModelCatalog({ agent, agentID: "pi", directory: "/repo", stateDirectory, requestTimeoutMs: 4321 })

    const first = await catalog.list({ allowStale: false })
    assert.deepEqual(first.models.map((model) => model.modelID), ["one", "two"])
    assert.equal(agent.newCalls, 1)
    assert.equal(agent.loadCalls, 0)
    assert.equal(catalog.hiddenSessionIDs.has("catalog-session"), true)
    assert.deepEqual(agent.requestTimeouts[0], { method: "session/new", timeoutMs: 4321 })

    agent.models = ["provider/two", "provider/three"]
    const refreshed = await catalog.list({ allowStale: false })
    assert.deepEqual(refreshed.models.map((model) => model.modelID), ["two", "three"])
    assert.equal(agent.newCalls, 1, "New Task must reuse the same catalog session")
    assert.equal(agent.loadCalls, 1, "each later open refreshes the harness config options")
    assert.deepEqual(agent.requestTimeouts[1], { method: "session/load", timeoutMs: 4321 })

    await assert.rejects(
      () => catalog.validate({ providerID: "provider", modelID: "one" }),
      /no longer available/,
      "launch must reject a model removed after the picker opened"
    )
    assert.equal(agent.newCalls, 1)
    assert.equal(agent.loadCalls, 2)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("shared ACP model catalog does not close the session bridge ACP process", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-catalog-shared-"))
  try {
    const agent = new FakeAcp()
    const catalog = new AcpAgentModelCatalog({ agent, agentID: "pi", directory: "/repo", stateDirectory, ownsAgent: false })
    await catalog.list({ allowStale: false })
    catalog.close()
    assert.equal(agent.closes, 0)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("ACP model discovery reuses its persisted catalog session after daemon restart", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-catalog-restart-"))
  try {
    const firstAgent = new FakeAcp()
    const first = new AcpAgentModelCatalog({ agent: firstAgent, agentID: "claude", directory: "/repo", stateDirectory })
    await first.list({ allowStale: false })
    assert.equal(firstAgent.newCalls, 1)

    const restartedAgent = new FakeAcp()
    const restarted = new AcpAgentModelCatalog({ agent: restartedAgent, agentID: "claude", directory: "/repo", stateDirectory })
    const result = await restarted.list({ allowStale: false })
    assert.equal(restartedAgent.newCalls, 0, "restart must not create another catalog session")
    assert.equal(restartedAgent.loadCalls, 1)
    assert.equal(restarted.hiddenSessionIDs.has("catalog-session"), true)
    assert.equal(result.stale, false)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("HTTP model discovery asks the managed harness again on every refresh", async () => {
  let calls = 0
  let models = { one: { id: "one", name: "One" } }
  const host = { host: "127.0.0.1", port: 4096, async start() {} }
  const fetchImpl = async () => {
    calls += 1
    return {
      ok: true,
      async json() {
        return { providers: [{ id: "openai", name: "OpenAI", models }], default: { openai: Object.keys(models)[0] } }
      }
    }
  }
  const catalog = new HttpAgentModelCatalog({ host, agentID: "opencode", fetchImpl })
  assert.deepEqual((await catalog.list()).models.map((model) => model.modelID), ["one"])
  models = { two: { id: "two", name: "Two" } }
  assert.deepEqual((await catalog.list()).models.map((model) => model.modelID), ["two"])
  assert.equal(calls, 2)
})

test("HTTP model discovery fails within its catalog deadline", async () => {
  const host = { host: "127.0.0.1", port: 4096, async start() {} }
  const catalog = new HttpAgentModelCatalog({
    host,
    agentID: "opencode",
    requestTimeoutMs: 20,
    fetchImpl: () => new Promise(() => {})
  })
  await assert.rejects(() => catalog.list({ allowStale: false }), /timed out/)
})
