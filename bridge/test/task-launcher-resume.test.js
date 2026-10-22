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

test("TaskLauncher.abort returns false when session id is absent", async () => {
  const launcher = new TaskLauncher()
  assert.equal(await launcher.abort({ run: {} }), false)
  assert.equal(await launcher.abort({}), false)
})

test("TaskLauncher.abort stops ACP session via acpService", async () => {
  const aborted = []
  const launcher = new TaskLauncher({
    acpService: () => ({
      async abort(sessionID) { aborted.push(sessionID) }
    })
  })
  const res = await launcher.abort({
    agentId: "codex",
    run: { sessionId: "sess-acp", transport: "acp" }
  })
  assert.equal(res, true)
  assert.deepEqual(aborted, ["sess-acp"])
})

test("TaskLauncher.abort stops managed HTTP session via fetchImpl", async () => {
  const requests = []
  const host = {
    readinessHost: "127.0.0.1",
    port: 4096,
    username: "user",
    password: "pass",
    async start() {}
  }
  const daemon = {
    hostEntry: () => ({ kind: "http", host })
  }
  const fetchImpl = async (url, opts) => {
    requests.push({ url, opts })
    return { ok: true, status: 200 }
  }
  const launcher = new TaskLauncher({ daemon, fetchImpl })
  const res = await launcher.abort({
    agentId: "opencode",
    workspace: { path: "/repo" },
    run: { sessionId: "sess-http", transport: "http" }
  })
  assert.equal(res, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "http://127.0.0.1:4096/session/sess-http/abort?directory=%2Frepo")
  assert.equal(requests[0].opts.method, "POST")
  assert.match(requests[0].opts.headers.Authorization, /^Basic /)
})

test("TaskLauncher.abort throws for unsupported transport", async () => {
  const launcher = new TaskLauncher()
  await assert.rejects(
    () => launcher.abort({ agentId: "custom", run: { sessionId: "sess-unknown", transport: "unknown" } }),
    /unsupported native session transport/
  )
})

test("TaskLauncher.abort rejects an identified native session whose transport is missing", async () => {
  const launcher = new TaskLauncher()
  await assert.rejects(
    () => launcher.abort({ id: "task-1", agentId: "codex", run: { sessionId: "sess-legacy" } }),
    (error) => error.code === "native_abort_unconfirmed" && /native session transport is missing/.test(error.message)
  )
})
