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
  // A task with half a selection would launch on the agent default while claiming otherwise.
  assert.equal(normalizeTaskModel({ providerID: "anthropic" }), null)
  assert.equal(normalizeTaskModel({ modelID: "claude-opus-5" }), null)
  assert.equal(normalizeTaskModel({ providerID: "  ", modelID: "  " }), null)
  assert.equal(normalizeTaskModel(undefined), null)
  assert.equal(normalizeTaskModel("anthropic/claude-opus-5"), null)
})

// The two endpoints disagree about what the model id is called, which is why this lives in one
// place rather than being spelled out at each call site.
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

// A task saved before models could be chosen, or one deliberately left on the agent default, must
// send no model at all rather than an empty object the agent would have to interpret.
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
