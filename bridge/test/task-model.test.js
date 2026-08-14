import assert from "node:assert/strict"
import test from "node:test"
import { normalizeTaskModel, promptModelBody, sessionModelBody } from "../src/task-model.js"
import { TaskLauncher } from "../src/task-launcher.js"

test("a model selection is accepted only when it names both a provider and a model", () => {
  assert.deepEqual(normalizeTaskModel({ providerID: "anthropic", modelID: "claude-opus-5" }), {
    providerID: "anthropic",
    modelID: "claude-opus-5"
  })
  assert.deepEqual(normalizeTaskModel({ providerID: " anthropic ", modelID: " claude-opus-5 ", variant: " thinking " }), {
    providerID: "anthropic",
    modelID: "claude-opus-5",
    variant: "thinking"
  })
  assert.equal(normalizeTaskModel({ providerID: "anthropic" }), null)
  assert.equal(normalizeTaskModel({ modelID: "claude-opus-5" }), null)
  assert.equal(normalizeTaskModel({ providerID: "  ", modelID: "  " }), null)
  assert.equal(normalizeTaskModel(undefined), null)
  assert.equal(normalizeTaskModel("anthropic/claude-opus-5"), null)
})

test("session creation and prompting use the field names each endpoint expects", () => {
  const model = { providerID: "anthropic", modelID: "claude-opus-5", variant: "thinking" }
  assert.deepEqual(sessionModelBody(model), { providerID: "anthropic", id: "claude-opus-5", variant: "thinking" })
  assert.deepEqual(promptModelBody(model), { providerID: "anthropic", modelID: "claude-opus-5" })
  assert.equal(sessionModelBody(null), undefined)
  assert.equal(promptModelBody(null), undefined)
})

function httpDaemon(calls) {
  return {
    hostEntry: () => ({ kind: "http", host: { start: async () => {}, host: "127.0.0.1", port: 4096 } }),
    registry: { host: () => ({ state: "available" }) },
    calls
  }
}

function launcher(calls) {
  return new TaskLauncher({
    daemon: httpDaemon(calls),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return { ok: true, status: 200, json: async () => ({ id: "session-1" }) }
    }
  })
}

test("the chosen model reaches both the session and the prompt", async () => {
  const calls = []
  const task = {
    id: "task-abcdef01",
    agentId: "opencode",
    prompt: "do the work",
    model: { providerID: "anthropic", modelID: "claude-opus-5", variant: "thinking" },
    workspace: { mode: "worktree", path: "/state/worktrees/task", branch: "task/x", source: "/repo" }
  }
  const run = await launcher(calls).createSession(task)
  await launcher(calls).startPrompt(task, { ...run, base: "http://127.0.0.1:4096" })

  const session = calls.find((call) => call.url.includes("/session?"))
  assert.deepEqual(session.body.model, { providerID: "anthropic", id: "claude-opus-5", variant: "thinking" })

  const prompt = calls.find((call) => call.url.includes("/prompt_async"))
  assert.deepEqual(prompt.body.model, { providerID: "anthropic", modelID: "claude-opus-5" })
  assert.equal(prompt.body.variant, "thinking")
})

test("a task without a model sends nothing rather than an empty selection", async () => {
  const calls = []
  const task = {
    id: "task-abcdef01",
    agentId: "opencode",
    prompt: "do the work",
    model: null,
    workspace: { mode: "worktree", path: "/state/worktrees/task", branch: "task/x", source: "/repo" }
  }
  const run = await launcher(calls).createSession(task)
  await launcher(calls).startPrompt(task, { ...run, base: "http://127.0.0.1:4096" })
  assert.ok(calls.every((call) => !("model" in call.body) || call.body.model === undefined))
  assert.ok(calls.every((call) => call.body.variant === undefined))
})

test("an ACP task applies its chosen model to the session it creates", async () => {
  const calls = []
  const configOptions = [{ id: "model", currentValue: "openrouter/kimi", options: [
    { value: "openrouter/deepseek-v4" },
    { value: "openrouter/kimi" }
  ] }]
  const daemon = {
    hostEntry: () => ({ kind: "acp", host: {
      start: async () => {},
      request: async (method, params) => {
        calls.push({ method, params })
        return method === "session/new" ? { sessionId: "acp-1", configOptions } : {}
      }
    } }),
    registry: { host: () => ({ state: "available" }) }
  }
  const task = {
    id: "task-1",
    agentId: "pi",
    prompt: "work",
    model: { providerID: "openrouter", modelID: "deepseek-v4" },
    workspace: { mode: "worktree", path: "/state/worktrees/task", branch: "task/x", source: "/repo" }
  }
  await new TaskLauncher({ daemon }).createSession(task)
  const applied = calls.find((call) => call.method === "session/set_config_option")
  assert.ok(applied, "the chosen model must be applied to the new session")
  assert.deepEqual(applied.params, { sessionId: "acp-1", configId: "model", value: "openrouter/deepseek-v4" })

  calls.length = 0
  configOptions[0].options = [{ value: "sonnet" }, { value: "opus" }]
  await new TaskLauncher({ daemon }).createSession({ ...task, model: { providerID: "claude", modelID: "opus" } })
  assert.equal(calls.find((call) => call.method === "session/set_config_option").params.value, "opus")

  calls.length = 0
  await new TaskLauncher({ daemon }).createSession({ ...task, model: null })
  assert.equal(calls.some((call) => call.method === "session/set_config_option"), false)
})
