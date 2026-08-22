import assert from "node:assert/strict"
import test from "node:test"
import { TaskLauncher } from "../src/task-launcher.js"

function task(overrides = {}) {
  return {
    id: "task-12345678",
    agentId: "codex",
    prompt: "Implement the fix",
    model: { providerID: "openai", modelID: "gpt-x", variant: "high" },
    workspace: { mode: "project", path: "/repo" },
    ...overrides
  }
}

test("ACP task launch applies selected model before prompting", async () => {
  const calls = []
  const host = {
    async start() {},
    async request(method, params) {
      calls.push({ method, params })
      if (method === "session/new") {
        return {
          sessionId: "session-1",
          configOptions: [{
            id: "model",
            options: [
              { value: "openai/gpt-y" },
              { value: "openai/gpt-x" }
            ]
          }]
        }
      }
      if (method === "session/set_config_option") return {}
      if (method === "session/prompt") return { stopReason: "end_turn" }
      throw new Error(`unexpected method ${method}`)
    }
  }
  const daemon = {
    hostEntry: () => ({ kind: "acp", host }),
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({ daemon })
  const selected = task()
  const run = await launcher.createSession(selected)

  assert.equal(run.sessionId, "session-1")
  assert.deepEqual(calls.slice(0, 2), [
    { method: "session/new", params: { cwd: "/repo", mcpServers: [] } },
    {
      method: "session/set_config_option",
      params: { sessionId: "session-1", configId: "model", value: "openai/gpt-x" }
    }
  ])

  await launcher.startPrompt(selected, run)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.at(-1).method, "session/prompt")
})

test("ACP task launch uses the bridge session service so the task remains visible with its messages", async () => {
  const calls = []
  const service = {
    async createSession(input) {
      calls.push(["create", input])
      return { id: "service-session" }
    },
    async promptAndWait(sessionID, text) {
      calls.push(["prompt", sessionID, text])
    },
    async messages() {
      return [
        { info: { role: "user" }, parts: [{ type: "text", text: "Implement the fix" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Done." }] }
      ]
    }
  }
  const daemon = {
    hostEntry: () => ({ kind: "acp", host: {} }),
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({ daemon, acpService: () => service })
  const selected = task({ agentId: "omp" })
  const run = await launcher.createSession(selected)
  let completed = false
  await launcher.startPrompt(selected, run, { onCompleted: () => { completed = true } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(calls, [
    ["create", { directory: "/repo", title: "Task task-123", model: "openai/gpt-x" }],
    ["prompt", "service-session", "Implement the fix"]
  ])
  assert.equal(completed, true)
})

test("ACP task outcome keeps Claude-style final text after reasoning and tool activity", async () => {
  const service = {
    async promptAndWait() {},
    async messages() {
      return [
        {
          info: { id: "user-1", role: "user" },
          parts: [{ type: "text", text: "Implement the fix" }]
        },
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [
            { type: "text", text: "I will inspect this first." },
            { type: "reasoning", text: "Need to find the relevant code." },
            { type: "tool", tool: "Read", state: { status: "completed" } },
            { type: "text", text: "Implemented the fix and opened PR #276." },
            { type: "file", filename: "report.txt" }
          ]
        }
      ]
    }
  }
  const daemon = {
    hostEntry: () => ({ kind: "acp", host: {} }),
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({ daemon, acpService: () => service })
  let completed

  await launcher.startPrompt(task({ agentId: "claude" }), { sessionId: "claude-session" }, {
    onCompleted: (result) => { completed = result }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(completed, { outcome: "Implemented the fix and opened PR #276." })
})

test("ACP task outcome does not promote pre-tool narration when no final answer was emitted", async () => {
  const service = {
    async promptAndWait() {},
    async messages() {
      return [
        {
          info: { id: "user-1", role: "user" },
          parts: [{ type: "text", text: "Implement the fix" }]
        },
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [
            { type: "text", text: "I will inspect this first." },
            { type: "tool", tool: "Edit", state: { status: "completed" } }
          ]
        }
      ]
    }
  }
  const daemon = {
    hostEntry: () => ({ kind: "acp", host: {} }),
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({ daemon, acpService: () => service })
  let completed

  await launcher.startPrompt(task({ agentId: "claude" }), { sessionId: "claude-session" }, {
    onCompleted: (result) => { completed = result }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(completed, { outcome: undefined })
})

test("managed HTTP task launch sends selected model and variant", async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options })
    if (url.includes("/session?")) {
      return { ok: true, async json() { return { id: "http-session" } } }
    }
    return {
      ok: true,
      async json() {
        return { info: { id: "message-1" }, parts: [{ type: "text", text: "Done." }] }
      }
    }
  }
  const host = {
    readinessHost: "127.0.0.1",
    port: 4096,
    username: "harness",
    password: "secret",
    async start() {}
  }
  const daemon = {
    hostEntry: () => ({ kind: "http", host }),
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({ daemon, fetchImpl })
  const selected = task({ agentId: "opencode" })
  const run = await launcher.createSession(selected)

  const createBody = JSON.parse(requests[0].options.body)
  assert.deepEqual(createBody, { title: "Task task-123" })
  assert.equal(run.sessionId, "http-session")

  await launcher.startPrompt(selected, run)
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(requests[1].url, /\/message\?directory=/)
  const promptBody = JSON.parse(requests[1].options.body)
  assert.deepEqual(promptBody.model, { providerID: "openai", modelID: "gpt-x" })
  assert.equal(promptBody.variant, "high")
})

test("managed HTTP task reports a clear failure when the agent stops after activity without a final answer", async () => {
  const host = { readinessHost: "127.0.0.1", port: 4096, async start() {} }
  const daemon = {
    hostEntry: () => ({ kind: "http", host }),
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({
    daemon,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          info: { id: "message-1" },
          parts: [
            { type: "text", text: "I will inspect this first." },
            { type: "tool", tool: "Edit", state: { status: "completed" } },
            { type: "step-finish", reason: "stop" }
          ]
        }
      }
    })
  })
  const failures = []

  await launcher.startPrompt(task({ agentId: "opencode" }), {
    sessionId: "http-session",
    base: "http://127.0.0.1:4096",
    authorization: undefined
  }, { onFailed: (error) => failures.push(error.message) })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(failures, ["opencode stopped before producing a final response"])
})

test("managed HTTP task recovers when the waiting fetch fails after OpenCode accepted the prompt", async () => {
  const host = { readinessHost: "127.0.0.1", port: 4096, async start() {} }
  const daemon = {
    hostEntry: () => ({ kind: "http", host }),
    registry: { host: () => ({ state: "available" }) }
  }
  let statusReads = 0
  let messageReads = 0
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST" && url.includes("/message?directory=")) throw new TypeError("fetch failed")
    if (url.includes("/session/status?")) {
      statusReads += 1
      return {
        ok: true,
        async json() { return { "http-session": { type: statusReads === 1 ? "busy" : "idle" } } }
      }
    }
    if (url.includes("/session/http-session/message?limit=40")) {
      messageReads += 1
      return {
        ok: true,
        async json() {
          return messageReads === 1
            ? [
                { info: { role: "user" }, parts: [{ type: "text", text: "Implement the fix" }] },
                { info: { role: "assistant" }, parts: [{ type: "reasoning", text: "Working" }] }
              ]
            : [
                { info: { role: "user" }, parts: [{ type: "text", text: "Implement the fix" }] },
                { info: { role: "assistant" }, parts: [
                  { type: "reasoning", text: "Working" },
                  { type: "step-finish", reason: "stop" },
                  { type: "text", text: "Recovered final response." }
                ] }
              ]
        }
      }
    }
    throw new Error(`unexpected request ${url}`)
  }
  const launcher = new TaskLauncher({
    daemon,
    fetchImpl,
    httpRecoveryPollMs: 0,
    httpRecoveryGraceMs: 20,
    httpRecoveryTimeoutMs: 500,
    sleepImpl: async () => {}
  })
  const completed = []
  const failures = []

  await launcher.startPrompt(task({ agentId: "opencode" }), {
    sessionId: "http-session",
    base: "http://127.0.0.1:4096",
    authorization: undefined
  }, {
    onCompleted: (result) => completed.push(result),
    onFailed: (error) => failures.push(error.message)
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(failures, [])
  assert.deepEqual(completed, [{ outcome: "Recovered final response." }])
  assert.ok(statusReads >= 2)
  assert.ok(messageReads >= 2)
})

test("managed HTTP task launch reports a provider failure after the prompt is accepted", async () => {
  const host = { readinessHost: "127.0.0.1", port: 4096, async start() {} }
  const daemon = {
    hostEntry: () => ({ kind: "http", host }),
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({
    daemon,
    fetchImpl: async () => ({ ok: false, status: 402, async json() { return { error: "Provider credit exhausted" } } })
  })
  const failures = []

  await launcher.startPrompt(task({ agentId: "opencode" }), {
    sessionId: "http-session",
    base: "http://127.0.0.1:4096",
    authorization: undefined
  }, { onFailed: (error) => failures.push(error.message) })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(failures, ["Starting opencode task failed with HTTP 402: Provider credit exhausted"])
})
