import assert from "node:assert/strict"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { harnessProfile } from "../src/harness-profiles.js"

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
  constructor({ holdPrompt = false, models = ["openai/a", "openai/b"], currentModel = models[0], variantConfigID = "thinking", currentVariant = "off" } = {}) {
    this.holdPrompt = holdPrompt
    this.releasePrompt = undefined
    this.models = models
    this.currentModel = currentModel
    this.variantConfigID = variantConfigID
    this.currentVariant = currentVariant
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
      { id: this.variantConfigID, currentValue: this.currentVariant, options: [{ value: this.currentVariant }, { value: "high" }] }
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

test("a journal-less ACP session restores its native model and variant on transcript reads", async () => {
  const acp = new RecordingAcp({ models: ["opencode/longcat-2.5-preview-free"] })
  // Having resume available must not suppress the transcript replay without a journal source.
  acp.sessionCapabilities = { resume: {} }
  const service = new AcpService(acp, { modelVariantConfigIDs: ["thinking"] })
  const page = await service.messagePage("s1")
  assert.deepEqual(page.model, { providerID: "opencode", modelID: "longcat-2.5-preview-free", variant: "off" })
  assert.ok(acp.calls.some(([method]) => method === "session/load"))
  assert.equal(acp.calls.some(([method]) => method === "session/resume"), false)
})

test("OpenCode 2 omits only its declared native default variant while preserving selected effort", async () => {
  const profile = harnessProfile("opencode2")
  const options = {
    modelVariantConfigIDs: profile.modelVariantConfigIDs,
    modelVariantDefaultValues: profile.modelVariantDefaultValues
  }
  const defaultAcp = new RecordingAcp({ models: ["opencode/longcat-2.5-preview-free"], variantConfigID: "effort", currentVariant: "default" })
  const defaultService = new AcpService(defaultAcp, options)
  assert.deepEqual((await defaultService.messagePage("s1")).model, {
    providerID: "opencode",
    modelID: "longcat-2.5-preview-free"
  })

  const highAcp = new RecordingAcp({ models: ["opencode/longcat-2.5-preview-free"], variantConfigID: "effort", currentVariant: "high" })
  const highService = new AcpService(highAcp, options)
  assert.deepEqual((await highService.messagePage("s1")).model, {
    providerID: "opencode",
    modelID: "longcat-2.5-preview-free",
    variant: "high"
  })
})

test("an undeclared native default remains a literal selection for other harnesses", async () => {
  const acp = new RecordingAcp({ models: ["openai/a"], variantConfigID: "reasoning", currentVariant: "default" })
  const service = new AcpService(acp, { modelVariantConfigIDs: ["reasoning"] })
  assert.deepEqual((await service.messagePage("s1")).model, {
    providerID: "openai",
    modelID: "a",
    variant: "default"
  })
})

test("MiMo inline variants use one exact native model value and survive transcript reads", async () => {
  const acp = new RecordingAcp({ models: ["xiaomi/mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash/high"] })
  const service = new AcpService(acp, { inlineModelVariantValues: ["high"] })
  await service.setModel("s1", "xiaomi/mimo-v2.6-flash", { configId: "model", value: "high" })
  assert.deepEqual(configCalls(acp), ["model=xiaomi/mimo-v2.6-flash/high"])
  assert.deepEqual((await service.messagePage("s1")).model, { providerID: "xiaomi", modelID: "mimo-v2.6-flash", variant: "high" })
  await service.setModel("s1", "xiaomi/mimo-v2.6-flash", { configId: "model", value: "xiaomi/mimo-v2.6-flash/high" })
  assert.equal(configCalls(acp).length, 1)
})

test("retired MiMo models and unadvertised inline variants never reach model switching", async () => {
  const acp = new RecordingAcp({ models: ["xiaomi/mimo-v2.6-flash", "mimo/mimo-auto", "mimo/mimo-auto/high"] })
  const service = new AcpService(acp, { excludedModelValuePrefixes: ["mimo/mimo-auto"], inlineModelVariantValues: ["high"] })
  assert.deepEqual((await service.models("s1")).map((option) => option.value), ["xiaomi/mimo-v2.6-flash"])
  await assert.rejects(service.setModel("s1", "mimo/mimo-auto"), /unavailable/)
  await assert.rejects(service.setModel("s1", "xiaomi/mimo-v2.6-flash", { configId: "model", value: "high" }), /variant is not available/)
  assert.deepEqual(configCalls(acp), [])
})

test("legacy ACP model state is switched with session/set_model", async () => {
  const acp = new RecordingAcp()
  const original = acp.request.bind(acp)
  acp.request = async (method, params) => method === "session/load"
    ? { models: { currentModelId: "one", availableModels: [{ modelId: "one" }, { modelId: "two" }] } }
    : original(method, params)
  const service = new AcpService(acp, { modelProviderID: "copilot" })
  assert.deepEqual((await service.messagePage("s1")).model, { providerID: "copilot", modelID: "one" })
  await service.setModel("s1", "copilot/two")
  assert.ok(acp.calls.some(([method]) => method === "session/set_model"))
  assert.deepEqual(configCalls(acp), [])
})

test("a provider cannot silently finish a prompt without the required assistant response", async () => {
  const service = new AcpService(new RecordingAcp(), { requireAssistantResponse: true })
  await assert.rejects(service.promptAndWait("s1", "Hello"), /without an assistant response/)
  const messages = await service.messages("s1")
  assert.match(messages.find((message) => message.info.error)?.info.error.message, /without an assistant response/)
  assert.equal(service.status("s1").type, "idle")
})

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
