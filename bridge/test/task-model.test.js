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

// A task on an ACP harness has to apply its model to the session it just created, before the
// prompt goes out. `session/new` reports the config options, so nothing extra has to be fetched.
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

  // A harness whose ids carry no provider answers with the bare id; resolve against what it offered.
  calls.length = 0
  configOptions[0].options = [{ value: "sonnet" }, { value: "opus" }]
  await new TaskLauncher({ daemon }).createSession({ ...task, model: { providerID: "claude", modelID: "opus" } })
  assert.equal(calls.find((call) => call.method === "session/set_config_option").params.value, "opus")

  // No model chosen means nothing is set, so the agent default stands untouched.
  calls.length = 0
  await new TaskLauncher({ daemon }).createSession({ ...task, model: null })
  assert.equal(calls.some((call) => call.method === "session/set_config_option"), false)
})

// A harness knows its own models without being asked through a session: `pi --list-models` prints
// them. The session-scoped ACP config option is only one way of finding out, and it is the one a
// task cannot use, because a task has no session until it launches.
test("a harness model listing is parsed however the CLI prints it", async () => {
  const { parseModelListing, createModelCatalogLoader } = await import("../src/harness-models.js")

  assert.deepEqual(parseModelListing('["openrouter/deepseek-v4"]'), [
    { value: "openrouter/deepseek-v4", label: "openrouter/deepseek-v4" }
  ])
  assert.deepEqual(parseModelListing('{"models":[{"id":"openrouter/kimi"}]}'), [
    { value: "openrouter/kimi", label: "openrouter/kimi" }
  ])
  assert.deepEqual(parseModelListing("Available models:\n  - openrouter/kimi\n  * openrouter/deepseek-v4\n"), [
    { value: "openrouter/kimi", label: "openrouter/kimi" },
    { value: "openrouter/deepseek-v4", label: "openrouter/deepseek-v4" }
  ])
  assert.deepEqual(parseModelListing(""), [])
  assert.deepEqual(parseModelListing("no models are configured"), [], "prose is not a model id")

  assert.equal(createModelCatalogLoader({}), undefined, "a harness with no listing command has no loader")

  // A harness that cannot be asked leaves the catalog empty rather than failing the request.
  const failing = createModelCatalogLoader({ modelListing: { command: "nope", args: [] } }, {
    spawnProcess: () => { throw new Error("ENOENT") }
  })
  assert.deepEqual(await failing(), [])

  const listing = createModelCatalogLoader({ modelListing: { command: "pi", args: ["--list-models"] } }, {
    spawnProcess: () => {
      const handlers = {}
      return {
        stdout: { setEncoding() {}, on(_event, handler) { handlers.data = handler } },
        on(event, handler) { handlers[event] = handler },
        kill() {}
      }
    }
  })
  const pending = listing()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(pending instanceof Promise)
})
