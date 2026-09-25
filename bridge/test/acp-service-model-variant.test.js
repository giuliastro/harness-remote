import assert from "node:assert/strict"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

/**
 * A harness legitimately resets dependent controls when the model changes, so the variant must be
 * applied after the model and never underneath a turn that is already running. These are the exact
 * invariants the Session-first prompt path previously broke by issuing its own set_config_option.
 */
class RecordingAcp {
  calls = []
  #listeners = new Set()
  promptCapabilities = {}
  processID = 4242
  constructor({ holdPrompt = false, models = ["openai/a", "openai/b"], currentModel = models[0] } = {}) {
    this.holdPrompt = holdPrompt
    this.releasePrompt = undefined
    this.models = models
    this.currentModel = currentModel
  }
  on() { return this }
  off() { return this }
  async start() {}
  close() {}
  diagnostics() { return { processID: this.processID } }
  notify() {}
  async listSessions() { return [{ sessionId: "s1", cwd: "/repo", title: "S1", updatedAt: new Date().toISOString() }] }
  #configOptions() {
    return [
      { id: "model", currentValue: this.currentModel, options: this.models.map((value) => ({ value })) },
      { id: "thinking", currentValue: "off", options: [{ value: "off" }, { value: "high" }] }
    ]
  }
  async request(method, params) {
    this.calls.push([method, params?.configId ?? null, params?.value ?? null])
    if (method === "session/load" || method === "session/new") return { sessionId: "s1", configOptions: this.#configOptions() }
    if (method === "session/set_config_option") return { configOptions: this.#configOptions() }
    if (method === "session/prompt") {
      if (this.holdPrompt) await new Promise((resolve) => { this.releasePrompt = resolve })
      return { stopReason: "end_turn" }
    }
    return {}
  }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
}

function configCalls(acp) {
  return acp.calls.filter(([method]) => method === "session/set_config_option").map(([, configId, value]) => `${configId}=${value}`)
}

test("setModel applies the model before its harness-advertised variant", async () => {
  const acp = new RecordingAcp()
  const service = new AcpService(acp, {})
  await service.setModel("s1", "openai/b", { configId: "thinking", value: "high" })
  assert.deepEqual(configCalls(acp), ["model=openai/b", "thinking=high"])
})

test("setModel refuses a variant the running adapter never advertised", async () => {
  const acp = new RecordingAcp()
  const service = new AcpService(acp, {})
  await assert.rejects(
    service.setModel("s1", "openai/b", { configId: "thinking", value: "invented" }),
    /variant is not available/
  )
  // The model still landed; only the invented variant was refused.
  assert.deepEqual(configCalls(acp), ["model=openai/b"])
})

test("setModel with no variant leaves other config options untouched", async () => {
  const acp = new RecordingAcp()
  const service = new AcpService(acp, {})
  await service.setModel("s1", "openai/b")
  assert.deepEqual(configCalls(acp), ["model=openai/b"])
})

test("setModel translates the stable bare Claude id to the current adapter's decorated option", async () => {
  const acp = new RecordingAcp({ models: ["default", "claude-fable-5-1[1m]"], currentModel: "default" })
  const service = new AcpService(acp, {})
  await service.setModel("s1", "claude/claude-fable-5-1")
  assert.deepEqual(configCalls(acp), ["model=claude-fable-5-1[1m]"])
})

test("provider model exclusions hide and reject retired model families", async () => {
  const acp = new RecordingAcp({
    models: ["mimo/mimo-auto", "mimo/mimo-auto/high", "openai/working"],
    currentModel: "openai/working"
  })
  const service = new AcpService(acp, { excludedModelValuePrefixes: ["mimo/mimo-auto"] })

  assert.deepEqual((await service.models("s1")).map((model) => model.value), ["openai/working"])
  await assert.rejects(
    service.setModel("s1", "mimo/mimo-auto/high"),
    (error) => error?.code === "model_unavailable"
  )
  assert.deepEqual(configCalls(acp), [])
})

test("inline model variants stay grouped and switch through the model option's wire value", async () => {
  const acp = new RecordingAcp({
    models: ["openai/gpt", "openai/gpt/low", "xiaomi/mimo", "xiaomi/mimo/high"],
    currentModel: "openai/gpt/low"
  })
  const service = new AcpService(acp, {
    inlineModelVariantValues: ["low", "high"],
    modelProviderOrder: ["xiaomi", "openai"]
  })

  assert.deepEqual((await service.models("s1")).map((model) => [model.value, model.variant]), [
    ["xiaomi/mimo", undefined],
    ["xiaomi/mimo", "high"],
    ["openai/gpt", undefined],
    ["openai/gpt", "low"]
  ])
  await service.setModel("s1", "xiaomi/mimo", { configId: "model", value: "high" })
  assert.deepEqual(configCalls(acp), ["model=xiaomi/mimo", "model=xiaomi/mimo/high"])
})

test("a prompt queued behind a running turn defers both model and variant to dequeue", async () => {
  const acp = new RecordingAcp({ holdPrompt: true })
  const service = new AcpService(acp, {})
  const first = service.prompt("s1", "one", "openai/a", [], { configId: "thinking", value: "off" })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const before = configCalls(acp)

  await service.prompt("s1", "two", "openai/b", [], { configId: "thinking", value: "high" })
  // Still running: the queued turn must not have changed the live turn's configuration.
  assert.deepEqual(configCalls(acp), before)

  acp.releasePrompt?.()
  await first
  await new Promise((resolve) => setTimeout(resolve, 20))
  const after = configCalls(acp).slice(before.length)
  assert.deepEqual(after, ["model=openai/b", "thinking=high"])
})

/**
 * A harness may advertise a different variant range for every model. Real PI does exactly this: one
 * model offers only `off`, another offers up to `max`. The Session therefore has to adopt the options
 * the adapter reports for the model it now holds, or the variant is validated - and sent - against
 * the previous model's range.
 */
class PerModelVariantAcp {
  calls = []
  promptCapabilities = {}
  processID = 99
  #model = "openai/basic"
  #ranges = {
    "openai/basic": ["off"],
    "openai/deep": ["off", "low", "high", "max"]
  }
  on() { return this }
  off() { return this }
  async start() {}
  close() {}
  notify() {}
  diagnostics() { return { processID: this.processID } }
  async listSessions() { return [{ sessionId: "s1", cwd: "/repo", title: "S1", updatedAt: new Date().toISOString() }] }
  #options() {
    return [
      { id: "model", currentValue: this.#model, options: Object.keys(this.#ranges).map((value) => ({ value })) },
      { id: "thinkingLevel", currentValue: this.#ranges[this.#model][0], options: this.#ranges[this.#model].map((value) => ({ value })) }
    ]
  }
  async request(method, params) {
    this.calls.push([method, params?.configId ?? null, params?.value ?? null])
    if (method === "session/load") return { sessionId: "s1", configOptions: this.#options() }
    if (method === "session/set_config_option") {
      if (params.configId === "model") this.#model = params.value
      if (params.configId === "thinkingLevel" && !this.#ranges[this.#model].includes(params.value)) {
        throw new Error(`adapter rejected thinkingLevel=${params.value}`)
      }
      return { configOptions: this.#options() }
    }
    if (method === "session/prompt") return { stopReason: "end_turn" }
    return {}
  }
  subscribe() { return () => {} }
}

test("a variant only the newly selected model offers is applied, not refused against the old model", async () => {
  const acp = new PerModelVariantAcp()
  const service = new AcpService(acp, {})
  // The Session starts on a model whose only level is `off`.
  await service.setModel("s1", "openai/deep", { configId: "thinkingLevel", value: "max" })
  assert.deepEqual(
    acp.calls.filter(([method]) => method === "session/set_config_option").map(([, id, value]) => `${id}=${value}`),
    ["model=openai/deep", "thinkingLevel=max"]
  )
})

test("a variant the newly selected model does not offer is refused before it reaches the adapter", async () => {
  const acp = new PerModelVariantAcp()
  const service = new AcpService(acp, {})
  await service.setModel("s1", "openai/deep", { configId: "thinkingLevel", value: "max" })
  const before = acp.calls.length

  // Going back to the restricted model must not carry `max` with it.
  await assert.rejects(
    service.setModel("s1", "openai/basic", { configId: "thinkingLevel", value: "max" }),
    (error) => {
      assert.equal(error.code, "model_variant_unavailable")
      assert.match(error.message, /this model offers off/)
      return true
    }
  )
  const after = acp.calls.slice(before).filter(([method]) => method === "session/set_config_option")
  assert.deepEqual(
    after.map(([, id, value]) => `${id}=${value}`),
    ["model=openai/basic"],
    "the model change still applied; only the unsupported level was withheld"
  )
})


class LegacyModelSurfaceAcp {
  calls = []
  promptCapabilities = {}
  processID = 5150
  #current = "mimo/mimo-v2.5"
  #models = [
    { modelId: "mimo/mimo-v2.5", name: "MiMo V2.5" },
    { modelId: "mimo/mimo-v2.5-pro", name: "MiMo V2.5 Pro" }
  ]
  on() { return this }
  off() { return this }
  async start() {}
  close() {}
  notify() {}
  diagnostics() { return { processID: this.processID } }
  async listSessions() {
    return [{ sessionId: "s1", cwd: "/repo", title: "S1", updatedAt: new Date().toISOString() }]
  }
  #state() {
    return { currentModelId: this.#current, availableModels: this.#models }
  }
  async request(method, params) {
    this.calls.push([method, params])
    if (method === "session/load" || method === "session/new") {
      return { sessionId: "s1", models: this.#state() }
    }
    if (method === "session/set_model") {
      if (!this.#models.some((candidate) => candidate.modelId === params.modelId)) {
        throw new Error("unknown model id")
      }
      this.#current = params.modelId
      return { models: this.#state() }
    }
    if (method === "session/prompt") return { stopReason: "end_turn" }
    return {}
  }
  subscribe() { return () => {} }
}

test("ACP legacy models state populates the same runtime model catalog", async () => {
  const acp = new LegacyModelSurfaceAcp()
  const service = new AcpService(acp, {})
  const models = await service.models("s1")
  assert.deepEqual(models, [
    { value: "mimo/mimo-v2.5", name: "MiMo V2.5", currentValue: true },
    { value: "mimo/mimo-v2.5-pro", name: "MiMo V2.5 Pro", currentValue: false }
  ])
})

test("ACP legacy models state switches through session/set_model rather than inventing configOptions", async () => {
  const acp = new LegacyModelSurfaceAcp()
  const service = new AcpService(acp, {})
  await service.setModel("s1", "mimo/mimo-v2.5-pro")
  const modelCalls = acp.calls.filter(([method]) => method === "session/set_model")
  assert.equal(modelCalls.length, 1)
  assert.deepEqual(modelCalls[0][1], { sessionId: "s1", modelId: "mimo/mimo-v2.5-pro" })
  assert.equal(
    acp.calls.some(([method]) => method === "session/set_config_option"),
    false,
    "legacy model sessions must never receive a config-option model mutation"
  )
  assert.equal((await service.models("s1")).find((model) => model.currentValue)?.value, "mimo/mimo-v2.5-pro")
})
