import assert from "node:assert/strict"
import test from "node:test"
import { TaskLauncher } from "../src/task-launcher.js"

function task(overrides = {}) {
  return {
    id: "task-12345678",
    agentId: "codex",
    prompt: "Continue the fix",
    model: { providerID: "openai", modelID: "gpt-x" },
    workspace: { mode: "project", path: "/repo" },
    run: { id: "run-2", sequence: 2, agentId: "codex", model: { providerID: "openai", modelID: "gpt-x" } },
    ...overrides
  }
}

test("ACP resume adopts and verifies the previous native Session instead of creating another one", async () => {
  const calls = []
  const service = {
    async adoptTaskSession(sessionID, details) {
      calls.push(["adopt", sessionID, details])
      return true
    },
    async models(sessionID) {
      calls.push(["probe", sessionID])
      return [{ value: "openai/gpt-x" }]
    },
    async setModel(sessionID, model) {
      calls.push(["model", sessionID, model])
    }
  }
  const daemon = {
    hostEntry: () => ({ kind: "acp", host: {} }),
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({ daemon, acpService: () => service })
  const resumed = await launcher.resumeSession(task(), {
    id: "run-1",
    agentId: "codex",
    sessionId: "native-1",
    transport: "acp",
    model: { providerID: "openai", modelID: "gpt-old" }
  })

  assert.equal(resumed.sessionId, "native-1")
  assert.equal(resumed.transport, "acp")
  assert.deepEqual(calls, [
    ["adopt", "native-1", { title: "Task task-123 · Run 2" }],
    ["probe", "native-1"],
    ["model", "native-1", "openai/gpt-x"]
  ])
})

test("ACP resume refuses a Session that the harness can no longer adopt", async () => {
  const daemon = {
    hostEntry: () => ({ kind: "acp", host: {} }),
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({
    daemon,
    acpService: () => ({ async adoptTaskSession() { return false } })
  })

  await assert.rejects(
    () => launcher.resumeSession(task(), { agentId: "codex", sessionId: "missing", transport: "acp" }),
    (error) => error.code === "session_unavailable"
  )
})

test("managed HTTP resume reconstructs connection details for the existing Session", async () => {
  let started = 0
  const host = {
    readinessHost: "127.0.0.1",
    port: 4096,
    username: "harness",
    password: "secret",
    async start() { started += 1 }
  }
  const daemon = {
    hostEntry: () => ({ kind: "http", host }),
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({ daemon })
  const selected = task({
    agentId: "opencode",
    run: { id: "run-2", sequence: 2, agentId: "opencode", model: { providerID: "openai", modelID: "gpt-x" } }
  })

  const resumed = await launcher.resumeSession(selected, {
    id: "run-1",
    agentId: "opencode",
    sessionId: "http-existing",
    transport: "http"
  })
  assert.equal(started, 1)
  assert.equal(resumed.sessionId, "http-existing")
  assert.equal(resumed.base, "http://127.0.0.1:4096")
  assert.match(resumed.authorization, /^Basic /)
})
