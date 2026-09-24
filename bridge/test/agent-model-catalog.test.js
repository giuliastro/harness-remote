import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  AcpAgentModelCatalog,
  HttpAgentModelCatalog,
  modelsFromConfigOptions,
  modelsFromProvidersResponse,
  modelsFromRuntimeProvidersResponse
} from "../src/agent-model-catalog.js"

class FakeAcp extends EventEmitter {
  constructor(prefix = "catalog") {
    super()
    this.prefix = prefix
  }
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
      return { sessionId: `${this.prefix}-session-${this.newCalls}`, configOptions: this.options() }
    }
    if (method === "session/load") {
      this.loadCalls += 1
      return { configOptions: this.options() }
    }
    throw new Error(`unexpected method ${method}`)
  }
}

test("Claude catalog normalizes a lone decorated canonical id to the bare value the adapter accepts", () => {
  const models = modelsFromConfigOptions([{
    id: "model",
    currentValue: "claude-fable-5-1[1m]",
    options: [
      { value: "default", name: "Default" },
      { value: "opus[1m]", name: "Opus (1M context)" },
      { value: "claude-fable-5-1[1m]", name: "Fable" }
    ]
  }], "claude")

  assert.deepEqual(models.map((model) => model.modelID), ["default", "opus[1m]", "claude-fable-5-1"])
  assert.equal(models.at(-1).isDefault, true)
})

test("Claude catalog preserves the 1M suffix when it distinguishes two advertised rows", () => {
  const models = modelsFromConfigOptions([{
    id: "model",
    currentValue: "claude-sonnet-5[1m]",
    options: [
      { value: "claude-sonnet-5", name: "Sonnet" },
      { value: "claude-sonnet-5[1m]", name: "Sonnet (1M context)" }
    ]
  }], "claude")

  assert.deepEqual(models.map((model) => model.modelID), ["claude-sonnet-5", "claude-sonnet-5[1m]"])
  assert.equal(models.at(-1).isDefault, true)
})

test("ACP catalog excludes provider-declared retired model families", () => {
  const models = modelsFromConfigOptions([{
    id: "model",
    currentValue: "openai/working",
    options: [
      { value: "mimo/mimo-auto", name: "MiMo Auto" },
      { value: "mimo/mimo-auto/high", name: "MiMo Auto High" },
      { value: "openai/working", name: "Working" }
    ]
  }], "mimo", ["mimo/mimo-auto"])

  assert.deepEqual(models.map((model) => `${model.providerID}/${model.modelID}`), ["openai/working"])
  assert.equal(models[0].isDefault, true)
})

test("ACP model discovery keeps one warm catalog per adapter lifetime and explicit refresh uses a fresh technical session", async () => {
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
    assert.equal(agent.loadCalls, 0)

    const refreshed = await catalog.list({ allowStale: false, refresh: true })
    assert.deepEqual(refreshed.models.map((model) => model.modelID), ["two", "three"])
    assert.equal(agent.newCalls, 2, "an explicit refresh must use a fresh Session rather than historical configOptions")
    assert.equal(agent.loadCalls, 0)
    await assert.rejects(() => catalog.validate({ providerID: "provider", modelID: "one" }), /no longer available/)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("concurrent ACP model picker opens join one technical catalog operation", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-single-flight-"))
  try {
    const agent = new FakeAcp()
    const originalRequest = agent.request.bind(agent)
    agent.request = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return originalRequest(...args)
    }
    const catalog = new AcpAgentModelCatalog({ agent, agentID: "pi", directory: "/repo", stateDirectory })
    const results = await Promise.all(Array.from({ length: 25 }, () => catalog.list({ allowStale: false })))
    assert.equal(agent.newCalls, 1)
    assert.equal(agent.loadCalls, 0)
    assert.equal(results.every((result) => result.models.length === 2), true)
    assert.equal(catalog.diagnostics().inFlight, false)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("ACP variants are emitted only from model-specific config options advertised at runtime", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-variants-"))
  try {
    let currentModel = "provider/one"
    const optionsFor = (model = currentModel) => [{
      id: "model",
      currentValue: model,
      options: [
        { value: "provider/one", name: "One" },
        { value: "provider/two", name: "Two" }
      ]
    }, {
      id: "thinking",
      currentValue: model === "provider/one" ? "medium" : "off",
      options: model === "provider/one"
        ? [{ value: "low" }, { value: "medium" }, { value: "high" }]
        : [{ value: "off" }, { value: "high" }]
    }]
    const agent = new EventEmitter()
    agent.start = async () => {}
    agent.close = () => {}
    agent.request = async (method, params) => {
      if (method === "session/new") return { sessionId: "catalog-session", configOptions: optionsFor() }
      if (method === "session/set_config_option" && params.configId === "model") {
        currentModel = params.value
        return { configOptions: optionsFor() }
      }
      if (method === "session/set_config_option" && params.configId === "thinking") return { configOptions: optionsFor() }
      throw new Error(`unexpected ${method}/${params?.configId || ""}`)
    }
    const catalog = new AcpAgentModelCatalog({
      agent,
      agentID: "omp",
      directory: "/repo",
      stateDirectory,
      variantConfigIDs: ["thinking", "invented-option"]
    })
    const result = await catalog.list({ allowStale: false })
    assert.deepEqual(
      result.models.map((model) => `${model.modelID}:${model.variant || "base"}`),
      ["one:base", "two:base", "one:low", "one:medium", "one:high", "two:off", "two:high"]
    )
    assert.equal(result.models.filter((model) => model.variant).every((model) => model.variantConfigId === "thinking"), true)
    assert.equal(result.models.some((model) => model.variantConfigId === "invented-option"), false)
    assert.equal(currentModel, "provider/two", "the hidden technical Session may remain on the last probed model")
    const selected = await catalog.resolve({ providerID: "provider", modelID: "two", variant: "high" })
    assert.equal(selected.variantConfigId, "thinking")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("ACP catalog invalidates its in-memory models and creates a fresh technical session when the adapter exits", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-catalog-exit-"))
  try {
    const agent = new FakeAcp()
    const catalog = new AcpAgentModelCatalog({ agent, agentID: "omp", directory: "/repo", stateDirectory })
    await catalog.list({ allowStale: false })
    agent.models = ["provider/three"]
    agent.emit("exit", new Error("adapter restarted"))
    const reloaded = await catalog.list({ allowStale: false })
    assert.deepEqual(reloaded.models.map((model) => model.modelID), ["three"])
    assert.equal(agent.newCalls, 2)
    assert.equal(agent.loadCalls, 0, "a restarted adapter must never source models from a historical Session")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("ACP model discovery never reuses a persisted catalog session after daemon restart", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-catalog-restart-"))
  try {
    const firstAgent = new FakeAcp("old")
    const first = new AcpAgentModelCatalog({ agent: firstAgent, agentID: "pi", directory: "/repo", stateDirectory })
    await first.list({ allowStale: false })
    assert.equal(first.hiddenSessionIDs.has("old-session-1"), true)

    const restartedAgent = new FakeAcp("fresh")
    restartedAgent.models = ["provider/two", "provider/three"]
    const restarted = new AcpAgentModelCatalog({ agent: restartedAgent, agentID: "pi", directory: "/repo", stateDirectory })
    const result = await restarted.list({ allowStale: false })

    assert.deepEqual(result.models.map((model) => model.modelID), ["two", "three"])
    assert.equal(restartedAgent.newCalls, 1)
    assert.equal(restartedAgent.loadCalls, 0, "the old technical Session may be hidden but must never be loaded for discovery")
    assert.equal(restarted.hiddenSessionIDs.has("old-session-1"), true)
    assert.equal(restarted.hiddenSessionIDs.has("fresh-session-1"), true)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("persisted ACP catalog sessions are hidden immediately after daemon restart without starting the adapter", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-model-catalog-preload-"))
  try {
    const first = new AcpAgentModelCatalog({ agent: new FakeAcp("old"), agentID: "codex", directory: "/repo", stateDirectory })
    await first.list({ allowStale: false })

    const restartedAgent = new FakeAcp("fresh")
    const restarted = new AcpAgentModelCatalog({ agent: restartedAgent, agentID: "codex", directory: "/repo", stateDirectory })
    await restarted.preloadState()

    assert.equal(restarted.hiddenSessionIDs.has("old-session-1"), true)
    assert.equal(restartedAgent.starts, 0, "preload must not start the ACP adapter")
    assert.equal(restartedAgent.loadCalls, 0, "preload must not load the old Session")
    assert.equal(restartedAgent.newCalls, 0, "preload must not create a new Session")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("OpenCode runtime provider inventory excludes disconnected providers and uses a short TTL", async () => {
  let calls = 0
  let models = { one: { id: "one", name: "One" } }
  const paths = []
  const host = { host: "127.0.0.1", port: 4096, async start() {} }
  const fetchImpl = async (url) => {
    calls += 1
    paths.push(new URL(String(url)).pathname)
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          all: [
            { id: "openai", name: "OpenAI", models },
            { id: "removed-provider", name: "Removed", models: { gone: { id: "gone", name: "Gone" } } }
          ],
          connected: ["openai"],
          default: { openai: Object.keys(models)[0], "removed-provider": "gone" }
        }
      }
    }
  }
  const catalog = new HttpAgentModelCatalog({ host, agentID: "opencode", fetchImpl, ttlMs: 30_000 })
  assert.deepEqual((await catalog.list()).models.map((model) => model.modelID), ["one"])
  assert.equal((await catalog.list()).models.some((model) => model.modelID === "gone"), false)
  models = { two: { id: "two", name: "Two" } }
  assert.deepEqual((await catalog.list()).models.map((model) => model.modelID), ["one"], "warm picker reopen should use the short cache")
  assert.equal(calls, 1)
  assert.deepEqual((await catalog.list({ refresh: true })).models.map((model) => model.modelID), ["two"])
  assert.equal(calls, 2)
  assert.deepEqual(paths, ["/provider", "/provider"])
  assert.equal(catalog.diagnostics().source, "opencode-runtime:/provider")
})

test("OpenCode model discovery falls back to config inventory only when runtime provider routes do not exist", async () => {
  const paths = []
  const host = { host: "127.0.0.1", port: 4096, async start() {} }
  const fetchImpl = async (url) => {
    const pathname = new URL(String(url)).pathname
    paths.push(pathname)
    if (pathname === "/provider" || pathname === "/api/provider") return { ok: false, status: 404 }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          providers: [{ id: "legacy", name: "Legacy", models: { one: { id: "one", name: "One" } } }],
          default: { legacy: "one" }
        }
      }
    }
  }
  const catalog = new HttpAgentModelCatalog({ host, agentID: "opencode", fetchImpl })
  assert.deepEqual((await catalog.list({ allowStale: false })).models.map((model) => model.modelID), ["one"])
  assert.deepEqual(paths, ["/provider", "/api/provider", "/config/providers"])
  assert.equal(catalog.diagnostics().source, "opencode-config-providers-legacy")
})

test("runtime provider parser keeps only providers OpenCode reports connected", () => {
  const result = modelsFromRuntimeProvidersResponse({
    all: [
      { id: "connected", name: "Connected", models: { current: { id: "current" } } },
      { id: "old", name: "Old", models: { removed: { id: "removed" } } }
    ],
    connected: ["connected"],
    default: { connected: "current", old: "removed" }
  })
  assert.deepEqual(result.map((model) => `${model.providerID}/${model.modelID}`), ["connected/current"])
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
