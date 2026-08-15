import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createBridgeServer } from "../src/server.js"
import { AcpService, isHarnessInjectedText } from "../src/acp-service.js"

class FakeAcp extends EventEmitter {
  agentInfo = { version: "17.0.7" }
  starts = 0
  loadStarts = 0
  #resolveLoadStarted
  #releaseLoad
  loadStarted = new Promise((resolve) => {
    this.#resolveLoadStarted = resolve
  })

  async start() {
    this.starts += 1
  }

  async listSessions() {
    return [{ sessionId: "session-1", title: "Test", cwd: process.cwd(), updatedAt: "2026-07-22T00:00:00.000Z" }]
  }

  async request(method) {
    if (method !== "session/load") return {}
    this.loadStarts += 1
    if (this.loadStarts === 1) {
      this.#resolveLoadStarted()
      await new Promise((resolve) => {
        this.#releaseLoad = resolve
      })
    }
    return {
      configOptions: [{
        id: "model",
        currentValue: "omp/default",
        options: [{ value: "omp/default", name: "OMP Default" }]
      }]
    }
  }

  releaseLoad() {
    this.#releaseLoad?.()
  }

  notify() {}
}

class ReplayAcp extends EventEmitter {
  agentInfo = { version: "17.0.8" }
  session = { sessionId: "session-1", title: "Persisted", cwd: process.cwd(), updatedAt: "2026-07-23T00:00:00.000Z" }

  async start() {}

  async listSessions() {
    return [this.session]
  }

  async request(method) {
    if (method === "session/load") {
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: "persisted-user",
            content: { type: "text", text: "Persist this prompt" }
          }
        }
      })
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Check persisted state." }
          }
        }
      })
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "read",
            status: "pending",
            rawInput: { path: "/tmp/state" },
            _meta: { toolName: "read" }
          }
        }
      })
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "persisted state" } }]
          }
        }
      })
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Persist this response" }
          }
        }
      })
    }
    return {}
  }

  notify() {}
}

class FreshnessAcp extends EventEmitter {
  agentInfo = { version: "17.0.8" }
  revision = "2026-07-23T00:00:00.000Z"
  loadStarts = 0
  history = [
    { role: "user", id: "first-user", text: "First prompt" },
    { role: "assistant", id: "first-assistant", text: "First response" }
  ]

  async start() {}


  async listSessions() {
    return [{ sessionId: "session-1", title: "Freshness", cwd: process.cwd(), updatedAt: this.revision }]
  }

  async request(method) {
    if (method === "session/load") {
      this.loadStarts += 1
      this.#replay(this)
    }
    return {}
  }

  #replay() {
    for (const message of this.history) {
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: message.role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
            messageId: message.id,
            content: { type: "text", text: message.text }
          }
        }
      })
    }
  }

  advance() {
    this.revision = "2026-07-23T00:01:00.000Z"
    this.history.push(
      { role: "user", id: "second-user", text: "Second prompt" },
      { role: "assistant", id: "second-assistant", text: "Second response" }
    )
  }

  appendWithoutRevision() {
    this.history.push(
      { role: "user", id: "third-user", text: "Third prompt" },
      { role: "assistant", id: "third-assistant", text: "Third response" }
    )
  }

  notify() {}
}

/** Mirrors observed OMP 17.1.3 behaviour: listings carry no title and prompts are never echoed back. */
class RealisticOmpAcp extends EventEmitter {
  agentInfo = { version: "17.1.3" }
  #sessions = []
  #history = new Map()

  async start() {}

  async listSessions() {
    return this.#sessions.map(({ sessionId, cwd, updatedAt }) => ({ sessionId, cwd, updatedAt }))
  }

  async request(method, params) {
    if (method === "session/new") {
      const sessionId = `omp-${this.#sessions.length + 1}`
      this.#sessions.push({ sessionId, cwd: params.cwd, updatedAt: "2026-07-25T00:00:00.000Z" })
      this.#history.set(sessionId, [])
      return { sessionId, configOptions: [] }
    }
    if (method === "session/prompt") {
      const history = this.#history.get(params.sessionId) ?? []
      const index = history.length
      history.push({ role: "user", id: `u${index}`, text: params.prompt[0].text })
      const reply = { role: "assistant", id: `a${index}`, text: "Bridge reply" }
      history.push(reply)
      this.#history.set(params.sessionId, history)
      this.#emitChunk(params.sessionId, reply)
      return { stopReason: "end_turn" }
    }
    if (method === "session/load") {
      for (const message of this.#history.get(params.sessionId) ?? []) this.#emitChunk(params.sessionId, message)
      return { configOptions: [] }
    }
    return {}
  }

  #emitChunk(sessionId, message) {
    this.emit("notification", {
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: message.role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          messageId: message.id,
          content: { type: "text", text: message.text }
        }
      }
    })
  }

  notify() {}
}

/** Holds each turn open so a second prompt arrives while the first is still running. */
class HeldTurnOmpAcp extends EventEmitter {
  agentInfo = { version: "17.1.3" }
  prompts = []
  models = []
  #releases = []
  #started = []

  async start() {}

  async listSessions() {
    return [{ sessionId: "session-1", cwd: process.cwd(), updatedAt: "2026-07-25T00:00:00.000Z" }]
  }

  async request(method, params) {
    if (method === "session/prompt") {
      this.prompts.push(params.prompt[0].text)
      this.#started.shift()?.()
      await new Promise((resolve) => this.#releases.push(resolve))
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: `a${this.prompts.length}`,
            content: { type: "text", text: `reply to ${params.prompt[0].text}` }
          }
        }
      })
      return { stopReason: "end_turn" }
    }
    if (method === "session/set_config_option") {
      this.models.push(params.value)
      return {}
    }
    if (method === "session/load") {
      return {
        configOptions: [{
          id: "model",
          currentValue: "omp/first",
          options: [{ value: "omp/first", name: "First" }, { value: "omp/second", name: "Second" }]
        }]
      }
    }
    return {}
  }

  /** Resolves once the next turn has actually reached the agent. */
  turnStarted() {
    return new Promise((resolve) => this.#started.push(resolve))
  }

  releaseTurn() {
    this.#releases.shift()?.()
  }
}

class ExtensionActionAcp extends EventEmitter {
  agentInfo = { version: "17.1.3" }
  processID = 4242
  prompts = []
  commands
  loads = 0
  fullHistory = [
    { role: "user", id: "user-1", text: "Change the file" },
    { role: "assistant", id: "assistant-1", text: "Changed the file" }
  ]
  history = [...this.fullHistory]

  constructor({ commands = true } = {}) {
    super()
    this.commands = commands
  }

  async start() {}

  async listSessions() {
    return [{ sessionId: "session-1", title: "Actions", cwd: process.cwd(), updatedAt: "2026-07-31T00:00:00.000Z" }]
  }

  async request(method, params) {
    if (method === "session/prompt") {
      const command = params.prompt[0].text
      this.prompts.push(command)
      if (command === "/undo" && this.history.length === this.fullHistory.length) this.history = [this.fullHistory[0]]
      if (command === "/redo" && this.history.length < this.fullHistory.length) this.history = [...this.fullHistory]
      return { stopReason: "end_turn" }
    }
    if (method !== "session/load") return {}
    this.loads += 1
    this.emit("notification", {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: this.commands
            ? [
                { name: "undo", description: "Revert file changes and session context for the last turn" },
                { name: "redo", description: "Restore the most recently undone turn" }
              ]
            : [{ name: "help", description: "Show help" }]
        }
      }
    })
    for (const message of this.history) {
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            messageId: `${message.id}-replay-${this.loads}`,
            content: { type: "text", text: message.text }
          }
        }
      })
    }
    return { configOptions: [] }
  }

  notify() {}
}

async function startServer({ acp = new FakeAcp(), ...options } = {}) {
  const server = createBridgeServer({
    acp,
    config: {
      host: "127.0.0.1",
      port: 0,
      username: "omp",
      password: "secret",
      roots: [process.cwd()],
      ...options
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return {
    acp,
    baseURL: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function authHeaders() {
  return { authorization: `Basic ${Buffer.from("omp:secret").toString("base64")}` }
}

function jsonHeaders() {
  return { ...authHeaders(), "content-type": "application/json" }
}

async function readJSON(baseURL, path, init) {
  const response = await fetch(`${baseURL}${path}`, { headers: authHeaders(), ...init })
  return response.json()
}

function conversation(messages) {
  return messages.map((message) => `${message.info.role}: ${message.parts[0].text}`)
}

async function waitForIdle(baseURL, sessionID) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const statuses = await readJSON(baseURL, "/session/status")
    if (statuses[sessionID]?.type === "idle") return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("the session never returned to idle")
}

test("queues a prompt sent while the agent is still working", async () => {
  const acp = new HeldTurnOmpAcp()
  const bridge = await startServer({ acp })
  const sendPrompt = (text, model) => fetch(`${bridge.baseURL}/session/session-1/prompt_async`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ parts: [{ type: "text", text }], model })
  })
  try {
    const firstStarted = acp.turnStarted()
    assert.equal((await sendPrompt("first")).status, 200)
    await firstStarted

    // Previously this returned 400 "The OMP session is already running".
    assert.equal((await sendPrompt("second", { providerID: "omp", modelID: "second" })).status, 200)
    assert.deepEqual(acp.prompts, ["first"], "the queued prompt must not reach the agent yet")
    assert.deepEqual(acp.models, [], "a queued model change must not affect the running turn")

    assert.deepEqual(conversation(await readJSON(bridge.baseURL, "/session/session-1/message")), [
      "user: first",
      "user: second"
    ], "a queued prompt is visible while it waits")
    const statuses = await readJSON(bridge.baseURL, "/session/status")
    assert.equal(statuses["session-1"].type, "busy")

    const secondStarted = acp.turnStarted()
    acp.releaseTurn()
    await secondStarted
    assert.deepEqual(acp.prompts, ["first", "second"], "the queued prompt runs once the turn ends")
    assert.deepEqual(acp.models, ["omp/second"], "its model is applied on dequeue")

    acp.releaseTurn()
    await waitForIdle(bridge.baseURL, "session-1")
    // Showing a queued prompt the moment it is sent means both user messages precede the
    // first reply, the way any chat looks when two messages are fired off in a row.
    // Reopening the session replays OMP's own history, which is strictly interleaved.
    assert.deepEqual(conversation(await readJSON(bridge.baseURL, "/session/session-1/message")), [
      "user: first",
      "user: second",
      "assistant: reply to first",
      "assistant: reply to second"
    ])
  } finally {
    acp.releaseTurn()
    acp.releaseTurn()
    await bridge.close()
  }
})

test("discards queued prompts when the session is aborted", async () => {
  const acp = new HeldTurnOmpAcp()
  const bridge = await startServer({ acp })
  const sendPrompt = (text) => fetch(`${bridge.baseURL}/session/session-1/prompt_async`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ parts: [{ type: "text", text }] })
  })
  try {
    const started = acp.turnStarted()
    await sendPrompt("running")
    await started
    await sendPrompt("queued")

    await fetch(`${bridge.baseURL}/session/session-1/abort`, { method: "POST", headers: authHeaders() })
    assert.deepEqual(conversation(await readJSON(bridge.baseURL, "/session/session-1/message")), [
      "user: running"
    ], "a cancelled queue must not leave a message that was never sent")

    acp.releaseTurn()
    await waitForIdle(bridge.baseURL, "session-1")
    assert.deepEqual(acp.prompts, ["running"], "a cancelled prompt must never reach the agent")
  } finally {
    acp.releaseTurn()
    await bridge.close()
  }
})

test("keeps the submitted prompt in history when the session is reopened", async () => {
  const bridge = await startServer({ acp: new RealisticOmpAcp() })
  try {
    const created = await readJSON(bridge.baseURL, "/session", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ title: "Reopen check" })
    })
    await readJSON(bridge.baseURL, `/session/${created.id}/prompt_async`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ parts: [{ type: "text", text: "Explain the bridge" }] })
    })
    await waitForIdle(bridge.baseURL, created.id)

    const live = conversation(await readJSON(bridge.baseURL, `/session/${created.id}/message`))
    assert.deepEqual(live, ["user: Explain the bridge", "assistant: Bridge reply"])

    const reopened = conversation(await readJSON(bridge.baseURL, `/session/${created.id}/message?refresh=1`))
    assert.deepEqual(reopened, live, "reopening must not drop the prompt the user just sent")

    const reopenedAgain = conversation(await readJSON(bridge.baseURL, `/session/${created.id}/message?refresh=1`))
    assert.deepEqual(reopenedAgain, live)
  } finally {
    await bridge.close()
  }
})

test("gives every OMP session a distinguishable title", async () => {
  const bridge = await startServer({ acp: new RealisticOmpAcp() })
  try {
    const named = await readJSON(bridge.baseURL, "/session", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ title: "Named by the app" })
    })
    const unnamed = await readJSON(bridge.baseURL, "/session", { method: "POST", headers: jsonHeaders(), body: "{}" })
    await readJSON(bridge.baseURL, `/session/${unnamed.id}/prompt_async`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ parts: [{ type: "text", text: "Refactor the parser\nsecond line" }] })
    })
    await waitForIdle(bridge.baseURL, unnamed.id)

    const titles = (await readJSON(bridge.baseURL, "/session")).map((session) => session.title)
    assert.deepEqual(titles, ["Named by the app", "Refactor the parser"])
    assert.equal(new Set(titles).size, titles.length, "OMP sessions must not all share one placeholder title")
  } finally {
    await bridge.close()
  }
})

test("matches session directories across path separator forms", async () => {
  const bridge = await startServer({ acp: new RealisticOmpAcp() })
  try {
    await readJSON(bridge.baseURL, "/session", { method: "POST", headers: jsonHeaders(), body: "{}" })
    const posixStyle = process.cwd().replaceAll("\\", "/")
    const listed = await readJSON(bridge.baseURL, `/session?directory=${encodeURIComponent(posixStyle)}`)
    assert.equal(listed.length, 1, "a directory written with forward slashes must still match")
  } finally {
    await bridge.close()
  }
})

test("beats on the event stream so an idle session is not mistaken for a dead one", async () => {
  const bridge = await startServer({ heartbeatMs: 25 })
  const controller = new AbortController()
  try {
    const response = await fetch(`${bridge.baseURL}/global/event`, {
      headers: authHeaders(),
      signal: controller.signal
    })
    assert.equal(response.headers.get("content-type"), "text/event-stream")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = ""
    // No session activity at all: everything arriving here must be a heartbeat.
    while (!received.includes(": ping")) {
      const { value, done } = await reader.read()
      if (done) break
      received += decoder.decode(value, { stream: true })
    }
    assert.match(received, /: ping/, "an idle stream must still produce traffic")
  } finally {
    controller.abort()
    await bridge.close()
  }
})

test("allows only explicitly configured browser origins", async () => {
  const bridge = await startServer({ corsOrigins: ["http://192.168.1.64:5199"] })
  try {
    const preflight = await fetch(`${bridge.baseURL}/session`, {
      method: "OPTIONS",
      headers: {
        origin: "http://192.168.1.64:5199",
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true"
      }
    })
    assert.equal(preflight.status, 204, "the preflight must succeed without credentials")
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://192.168.1.64:5199")
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true")
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true")
    assert.equal(preflight.headers.get("vary"), "Origin")

    const allowed = await fetch(`${bridge.baseURL}/global/health`, {
      headers: { ...authHeaders(), origin: "http://192.168.1.64:5199" }
    })
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://192.168.1.64:5199")

    const foreign = await fetch(`${bridge.baseURL}/global/health`, {
      headers: { ...authHeaders(), origin: "http://evil.example" }
    })
    assert.equal(foreign.headers.get("access-control-allow-origin"), null, "unlisted origins must not be granted access")
    assert.equal(foreign.status, 200)
  } finally {
    await bridge.close()
  }
})

test("keeps browser origins blocked until --cors is configured", async () => {
  const bridge = await startServer()
  try {
    const response = await fetch(`${bridge.baseURL}/global/health`, {
      headers: { ...authHeaders(), origin: "http://192.168.1.64:5199" }
    })
    assert.equal(response.headers.get("access-control-allow-origin"), null)
  } finally {
    await bridge.close()
  }
})

test("requires Basic Auth before exposing bridge endpoints", async () => {
  const bridge = await startServer()
  try {
    const response = await fetch(`${bridge.baseURL}/global/health`)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get("www-authenticate"), 'Basic realm="Harness Remote Bridge"')
  } finally {
    await bridge.close()
  }
})

test("serves health and OpenCode-compatible sessions with authentication", async () => {
  const bridge = await startServer()
  try {
    const health = await fetch(`${bridge.baseURL}/global/health`, { headers: authHeaders() })
    assert.deepEqual(await health.json(), { healthy: true, backend: "omp", version: "17.0.7" })
    const sessions = await fetch(`${bridge.baseURL}/session`, { headers: authHeaders() })
    const body = await sessions.json()
    assert.equal(body.length, 1)
    assert.equal(body[0].id, "session-1")
    assert.equal(body[0].status, "idle")
  } finally {
    await bridge.close()
  }
})

test("reports the configured ACP backend", async () => {
  const bridge = await startServer({ backend: "pi" })
  try {
    const health = await fetch(`${bridge.baseURL}/global/health`, { headers: authHeaders() })
    assert.deepEqual(await health.json(), { healthy: true, backend: "pi", version: "17.0.7" })
  } finally {
    await bridge.close()
  }
})

test("reports capabilities from the selected harness profile", async () => {
  const omp = await startServer({ backend: "omp" })
  const pi = await startServer({ backend: "pi" })
  const codex = await startServer({ backend: "codex" })
  try {
    const ompCapabilities = await readJSON(omp.baseURL, "/v1/capabilities")
    const piCapabilities = await readJSON(pi.baseURL, "/v1/capabilities")
    const codexCapabilities = await readJSON(codex.baseURL, "/v1/capabilities")
    assert.equal(ompCapabilities.models, true)
    assert.equal(ompCapabilities.todos, true)
    assert.equal(ompCapabilities.commands, true)
    assert.equal(ompCapabilities.actions, true)
    assert.equal(piCapabilities.models, true)
    assert.equal(piCapabilities.todos, false)
    assert.equal(piCapabilities.commands, true)
    assert.equal(piCapabilities.actions, false)
    // Codex mirrors Claude's flat model ids and OMP's slash-command catalog, so the app must
    // trust the canonical OMP-style values the bridge exposes.
    assert.equal(codexCapabilities.models, true)
    assert.equal(codexCapabilities.todos, true)
    assert.equal(codexCapabilities.commands, true)
    assert.equal(codexCapabilities.actions, false)
  } finally {
    await Promise.all([omp.close(), pi.close(), codex.close()])
  }
})

test("does not advertise extension actions when OMP did not load their commands", async () => {
  const bridge = await startServer({ acp: new ExtensionActionAcp({ commands: false }) })
  try {
    assert.deepEqual(await readJSON(bridge.baseURL, "/session/session-1/action"), [])
    const response = await fetch(`${bridge.baseURL}/session/session-1/action/undo`, {
      method: "POST",
      headers: jsonHeaders(),
      body: "{}"
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /not available/)
  } finally {
    await bridge.close()
  }
})

test("does not advertise extension actions without authoritative state", async () => {
  const acp = new ExtensionActionAcp()
  const bridge = await startServer({ acp })
  try {
    assert.deepEqual(await readJSON(bridge.baseURL, "/session/session-1/action"), [])
    const response = await fetch(`${bridge.baseURL}/session/session-1/action/undo`, {
      method: "POST",
      headers: jsonHeaders(),
      body: "{}"
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /not available/)
    assert.deepEqual(acp.prompts, [])
  } finally {
    await bridge.close()
  }
})

test("uses extension revisions and availability as authoritative action state", async () => {
  const acp = new ExtensionActionAcp()
  let actionState = {
    actions: [{ id: "undo", enabled: true }, { id: "redo", enabled: false }],
    sessionRevision: "1:assistant-1",
    activeSessionLeaf: "assistant-1"
  }
  let nextUndoIsNoOp = false
  const request = acp.request.bind(acp)
  acp.request = async (method, params) => {
    const result = await request(method, params)
    if (method !== "session/prompt") return result
    const command = params.prompt[0].text
    if (command === "/undo") {
      acp.history = [...acp.fullHistory]
      actionState = nextUndoIsNoOp
        ? {
            ...actionState,
            actionResult: { id: "undo", applied: false, token: "action-no-op" }
          }
        : {
            actions: [{ id: "undo", enabled: false }, { id: "redo", enabled: true }],
            sessionRevision: "0:user-1",
            activeSessionLeaf: "user-1"
          }
    } else if (command === "/redo") {
      actionState = {
        actions: [{ id: "undo", enabled: true }, { id: "redo", enabled: false }],
        sessionRevision: "1:assistant-1",
        activeSessionLeaf: "assistant-1"
      }
    }
    return result
  }
  const provider = {
    id: "omp-undo-redo",
    requiredCommands: ["undo", "redo"],
    actions: [
      { id: "undo", command: "undo", enabledByDefault: true },
      { id: "redo", command: "redo", enabledByDefault: false }
    ],
    loadState: async () => actionState
  }
  const service = new AcpService(acp, { actionProviders: [provider] })

  assert.deepEqual(await service.actions("session-1"), [
    { id: "undo", source: "omp-undo-redo", enabled: true },
    { id: "redo", source: "omp-undo-redo", enabled: false }
  ])
  const undo = await service.invokeAction("session-1", "undo")
  assert.equal(undo.applied, true, "the revision change is authoritative even when replayed text is unchanged")
  assert.equal(undo.sessionRevision, "0:user-1")
  assert.equal(undo.actions.find((action) => action.id === "redo").enabled, true)
  assert.deepEqual((await service.messages("session-1")).map((message) => message.parts[0].text), [
    "Change the file",
    "Changed the file"
  ])

  const redo = await service.invokeAction("session-1", "redo")
  assert.equal(redo.applied, true)
  assert.equal(redo.actions.find((action) => action.id === "redo").enabled, false)

  nextUndoIsNoOp = true
  const noOp = await service.invokeAction("session-1", "undo")
  assert.equal(noOp.applied, false, "a fresh explicit extension result must report a no-op")
})

test("loads an external session from the extension-selected tree leaf", async () => {
  const acp = new ExtensionActionAcp()
  let selectedLeaf
  const provider = {
    id: "omp-undo-redo",
    requiredCommands: ["undo", "redo"],
    actions: [],
    loadState: async () => ({
      actions: [{ id: "undo", enabled: false }, { id: "redo", enabled: true }],
      sessionRevision: "0:user-1",
      activeSessionLeaf: "user-1"
    })
  }
  const historyLoader = async (_sessionID, options) => {
    selectedLeaf = options.activeSessionLeaf
    return [{
      info: { id: "user-1", role: "user", sessionID: "session-1", time: { created: Date.now() } },
      parts: [{ id: "user-1:text", type: "text", text: "Change the file" }]
    }]
  }
  const service = new AcpService(acp, { actionProviders: [provider], historyLoader })

  assert.deepEqual((await service.messages("session-1")).map((message) => message.parts[0].text), ["Change the file"])
  assert.equal(selectedLeaf, "user-1")
  assert.equal(acp.loads, 0, "external history should not activate or replay the ACP session")
})

test("replays ACP history when extension state is unavailable", async () => {
  const acp = new ExtensionActionAcp()
  let selectedLeaf = "not-called"
  let stateProcessID
  const provider = {
    id: "omp-undo-redo",
    requiredCommands: ["undo", "redo"],
    actions: [{ id: "undo", command: "undo", enabledByDefault: true }],
    loadState: async ({ processID }) => {
      stateProcessID = processID
      return undefined
    }
  }
  const historyLoader = async (_sessionID, options) => {
    selectedLeaf = options.activeSessionLeaf
    return []
  }
  const service = new AcpService(acp, { actionProviders: [provider], historyLoader })

  assert.deepEqual((await service.messages("session-1")).map((message) => message.parts[0].text), [
    "Change the file",
    "Changed the file"
  ])
  assert.equal(selectedLeaf, undefined)
  assert.equal(stateProcessID, 4242)
  assert.equal(acp.loads, 1, "ACP must supply active branch when no authoritative leaf exists")
  assert.deepEqual(await service.actions("session-1"), [])
})

test("renames and hides ACP sessions through OpenCode-compatible endpoints", async () => {
  const bridge = await startServer()
  try {
    const renamed = await fetch(`${bridge.baseURL}/session/session-1`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ title: "Renamed from mobile" })
    })
    assert.equal(renamed.status, 200)
    assert.equal((await renamed.json()).title, "Renamed from mobile")
    assert.equal((await readJSON(bridge.baseURL, "/session"))[0].title, "Renamed from mobile")

    const deleted = await fetch(`${bridge.baseURL}/session/session-1`, {
      method: "DELETE",
      headers: authHeaders()
    })
    assert.equal(deleted.status, 200)
    assert.equal(await deleted.json(), true)
    assert.deepEqual(await readJSON(bridge.baseURL, "/session"), [])

    const messages = await fetch(`${bridge.baseURL}/session/session-1/message`, { headers: authHeaders() })
    assert.equal(messages.status, 400)
    assert.match((await messages.json()).error, /Harness session not found/)
  } finally {
    await bridge.close()
  }
})

test("persists renamed and deleted sessions across bridge restarts", async () => {
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "harness-remote-session-state-"))
  try {
    const renamed = new AcpService(new FakeAcp(), { snapshotDirectory })
    await renamed.renameSession("session-1", "Persistent title")
    await renamed.flushSnapshots()

    const deleted = new AcpService(new FakeAcp(), { snapshotDirectory })
    assert.equal((await deleted.listSessions())[0].title, "Persistent title")
    await deleted.deleteSession("session-1")
    await deleted.flushSnapshots()

    const restored = new AcpService(new FakeAcp(), { snapshotDirectory })
    assert.deepEqual(await restored.listSessions(), [])
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
})

test("keeps a newly created ACP session usable while the app requests refreshed history", async () => {
  class NewSessionAcp extends EventEmitter {
    async start() {}
    async listSessions() {
      return []
    }
    async request(method) {
      if (method === "session/new") return { sessionId: "new-session", configOptions: [] }
      if (method === "session/load") throw new Error("a newly created session must not be loaded again")
      return {}
    }
    notify() {}
  }

  const service = new AcpService(new NewSessionAcp(), { reloadOnHistoryRefresh: false })
  await service.createSession({ directory: process.cwd(), title: "New session" })
  assert.deepEqual(await service.messages("new-session", true), [])
  assert.equal((await service.listSessions()).at(0)?.id, "new-session")
})

test("keeps PI session ordering stable when the adapter refreshes every timestamp", async () => {
  class VolatileTimestampAcp extends EventEmitter {
    timestamp = "2026-07-28T13:00:00.000Z"
    async listSessions() {
      return [{ sessionId: "session-1", cwd: process.cwd(), updatedAt: this.timestamp }]
    }
    notify() {}
  }

  const acp = new VolatileTimestampAcp()
  const service = new AcpService(acp, { preserveListedTimestamps: true })
  const initial = (await service.listSessions())[0].time.updated
  acp.timestamp = "2026-07-28T13:00:01.000Z"
  assert.equal((await service.listSessions())[0].time.updated, initial)
})

test("assigns a stable timestamp when PI omits session update times", async () => {
  class UntimedAcp extends EventEmitter {
    async listSessions() {
      return [{ sessionId: "session-1", cwd: process.cwd() }]
    }
    notify() {}
  }

  const service = new AcpService(new UntimedAcp(), { preserveListedTimestamps: true })
  const initial = (await service.listSessions())[0].time.updated
  assert.equal((await service.listSessions())[0].time.updated, initial)
})
test("confines file browsing to configured roots", async () => {
  const bridge = await startServer()
  try {
    const allowed = await fetch(`${bridge.baseURL}/file?path=${encodeURIComponent(process.cwd())}`, { headers: authHeaders() })
    assert.equal(allowed.status, 200)
    const outside = await fetch(`${bridge.baseURL}/file?path=${encodeURIComponent(path.dirname(process.cwd()))}`, { headers: authHeaders() })
    assert.equal(outside.status, 400)
    assert.match((await outside.json()).error, /configured --root boundary/)
  } finally {
    await bridge.close()
  }
})

test("waits for a concurrent ACP session load before returning configured models", async () => {
  const bridge = await startServer()
  try {
    const messages = fetch(`${bridge.baseURL}/session/session-1/message`, { headers: authHeaders() })
    await bridge.acp.loadStarted

    let modelsSettled = false
    const models = fetch(`${bridge.baseURL}/config/providers?directory=${encodeURIComponent(process.cwd())}&sessionID=session-1`, { headers: authHeaders() })
      .then(async (response) => {
        modelsSettled = true
        return response.json()
      })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(modelsSettled, false)

    bridge.acp.releaseLoad()
    assert.deepEqual(await models, {
      providers: [{
        id: "omp",
        name: "omp",
        models: {
          default: { id: "default", name: "OMP Default", status: "active" }
        }
      }],
      default: { omp: "default" }
    })
    await messages
    assert.equal(bridge.acp.loadStarts, 1)
  } finally {
    bridge.acp.releaseLoad()
    await bridge.close()
  }
})

test("records the submitted user prompt before asynchronous ACP assistant updates", async () => {
  const bridge = await startServer()
  try {
    const prompt = fetch(`${bridge.baseURL}/session/session-1/prompt_async`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "Explain the fix" }] })
    })
    await bridge.acp.loadStarted
    bridge.acp.releaseLoad()
    assert.equal((await prompt).status, 200)

    bridge.acp.emit("notification", {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "acp-assistant-message",
          content: { type: "text", text: "The messages are now ordered." }
        }
      }
    })
    bridge.acp.emit("notification", {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "acp-user-message",
          content: { type: "text", text: "Explain the fix" }
        }
      }
    })

    const messages = await fetch(`${bridge.baseURL}/session/session-1/message`, { headers: authHeaders() })
    assert.deepEqual((await messages.json()).map((message) => ({
      role: message.info.role,
      text: message.parts[0].text
    })), [
      { role: "user", text: "Explain the fix" },
      { role: "assistant", text: "The messages are now ordered." }
    ])
  } finally {
    bridge.acp.releaseLoad()
    await bridge.close()
  }
})

test("replays persistent user and assistant history when reopening an OMP session", async () => {
  const bridge = await startServer({ acp: new ReplayAcp() })
  try {
    const response = await fetch(`${bridge.baseURL}/session/session-1/message`, { headers: authHeaders() })
    const messages = await response.json()
    assert.deepEqual(messages.map((message) => ({
      role: message.info.role,
      parts: message.parts.map((part) => ({ type: part.type, text: part.text }))
    })), [
      { role: "user", parts: [{ type: "text", text: "Persist this prompt" }] },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Check persisted state." },
          { type: "tool", text: undefined },
          { type: "text", text: "Persist this response" }
        ]
      }
    ])
    assert.deepEqual(messages[1].parts[1].state, {
      status: "completed",
      input: { path: "/tmp/state" },
      title: "read",
      output: "persisted state",
      time: messages[1].parts[1].state.time
    })
  } finally {
    await bridge.close()
  }
})

test("does not publish replay notifications as live session activity", async () => {
  const acp = new ReplayAcp()
  const omp = new AcpService(acp)
  const events = []
  omp.subscribe((event) => events.push(event))
  const originalUpdatedAt = acp.session.updatedAt

  await omp.messages("session-1", true)

  assert.equal(acp.session.updatedAt, originalUpdatedAt)
  assert.deepEqual(events, [])
})

test("keeps the persisted snapshot stable until an explicit history refresh", async () => {
  const acp = new FreshnessAcp()
  const bridge = await startServer({ acp })
  try {
    const first = await fetch(`${bridge.baseURL}/session/session-1/message`, { headers: authHeaders() })
    assert.equal((await first.json()).length, 2)
    assert.equal(acp.loadStarts, 1)

    acp.advance()
    const backgroundPoll = await fetch(`${bridge.baseURL}/session/session-1/message`, { headers: authHeaders() })
    assert.deepEqual((await backgroundPoll.json()).map((message) => message.parts[0].text), [
      "First prompt",
      "First response"
    ])
    assert.equal(acp.loadStarts, 1)

    const reopened = await fetch(`${bridge.baseURL}/session/session-1/message?refresh=1`, { headers: authHeaders() })
    assert.deepEqual((await reopened.json()).map((message) => message.parts[0].text), [
      "First prompt",
      "First response",
      "Second prompt",
      "Second response"
    ])
    assert.equal(acp.loadStarts, 2)

    acp.appendWithoutRevision()
    const unchangedRevision = await fetch(`${bridge.baseURL}/session/session-1/message`, { headers: authHeaders() })
    assert.deepEqual((await unchangedRevision.json()).map((message) => message.parts[0].text), [
      "First prompt",
      "First response",
      "Second prompt",
      "Second response"
    ])
    assert.equal(acp.loadStarts, 2)
  } finally {
    await bridge.close()
  }
})

test("keeps the last snapshot when an ACP refresh replays no messages", async () => {
  class EmptyRefreshAcp extends EventEmitter {
    loads = 0

    async start() {}

    async listSessions() {
      return [{ sessionId: "session-1", cwd: process.cwd(), updatedAt: "2026-07-26T00:00:00.000Z" }]
    }

    async request(method) {
      if (method !== "session/load") return {}
      this.loads += 1
      if (this.loads === 1) {
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "persisted-assistant",
              content: { type: "text", text: "Persisted response" }
            }
          }
        })
      }
      return {}
    }

    notify() {}
  }

  const driver = new AcpService(new EmptyRefreshAcp())
  assert.deepEqual((await driver.messages("session-1")).map((message) => message.parts[0].text), ["Persisted response"])
  assert.deepEqual((await driver.messages("session-1", true)).map((message) => message.parts[0].text), ["Persisted response"])
})

test("restores messages from disk when ACP replay is empty or partial after restart", async () => {
  class SnapshotReplayAcp extends EventEmitter {
    constructor(replayMessages, todoContent, todoStatus = "in_progress") {
      super()
      this.replayMessages = replayMessages
      this.todoContent = todoContent
      this.todoStatus = todoStatus
    }

    async start() {}

    async listSessions() {
      return [{ sessionId: "session-1", cwd: process.cwd(), updatedAt: "2026-07-26T00:00:00.000Z" }]
    }

    async request(method) {
      if (method !== "session/load") return {}
      for (const text of this.replayMessages) {
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: `persisted-${text}`,
              content: { type: "text", text }
            }
          }
        })
      }
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "plan",
            entries: [{ content: this.todoContent, status: this.todoStatus, priority: "medium" }]
          }
        }
      })
      return {}
    }

    notify() {}
  }

  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "harness-remote-snapshots-"))
  try {
    const expectedMessages = ["First", "Second", "Third"]
    const first = new AcpService(new SnapshotReplayAcp(expectedMessages, "Old todo"), { snapshotDirectory })
    assert.deepEqual((await first.messages("session-1")).map((message) => message.parts[0].text), expectedMessages)
    await first.flushSnapshots()

    const emptyReplay = new AcpService(new SnapshotReplayAcp([], "Current todo"), { snapshotDirectory })
    assert.deepEqual((await emptyReplay.messages("session-1")).map((message) => message.parts[0].text), expectedMessages)
    assert.deepEqual((await emptyReplay.todos("session-1")).map((todo) => todo.content), ["Current todo"])
    await emptyReplay.flushSnapshots()

    const partialReplay = new AcpService(new SnapshotReplayAcp(["Second", "Third"], "Newest todo", "completed"), { snapshotDirectory })
    assert.deepEqual((await partialReplay.messages("session-1")).map((message) => message.parts[0].text), expectedMessages)
    assert.deepEqual((await partialReplay.todos("session-1")).map((todo) => todo.content), ["Newest todo"])
    await partialReplay.flushSnapshots()

    const stalePlanReplay = new AcpService(new SnapshotReplayAcp([], "Newest todo", "pending"), { snapshotDirectory })
    assert.deepEqual((await stalePlanReplay.todos("session-1")).map((todo) => todo.status), ["completed"])
    await stalePlanReplay.flushSnapshots()
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
})

test("reads external history without loading and interrupting the ACP session", async () => {
  const message = (id, text) => ({
    info: { id, role: "assistant", sessionID: "session-1", time: { created: Date.now() } },
    parts: [{ id: `${id}:text`, type: "text", text }]
  })
  class MissingMiddleAcp extends EventEmitter {
    loads = 0
    async start() {}

    async listSessions() {
      return [{ sessionId: "session-1", cwd: process.cwd(), updatedAt: "2026-07-26T00:00:00.000Z" }]
    }

    async request(method) {
      if (method === "session/load") this.loads += 1
      return {}
    }

    notify() {}
  }

  let persistedHistory = [
    message("native-first", "First"),
    message("native-second", "Second"),
    message("native-third", "Third")
  ]
  const historyLoader = async () => persistedHistory
  const acp = new MissingMiddleAcp()
  const driver = new AcpService(acp, { historyLoader })
  assert.deepEqual((await driver.messages("session-1")).map((item) => item.parts[0].text), ["First", "Second", "Third"])
  persistedHistory = [...persistedHistory, message("native-fourth", "Fourth")]
  assert.deepEqual(
    (await driver.messages("session-1")).map((item) => item.parts[0].text),
    ["First", "Second", "Third", "Fourth"],
    "external history must refresh and preserve native order without an explicit refresh flag"
  )
  assert.equal(acp.loads, 0)
})

test("reports models for an external session without losing its history", async () => {
  // Displaying an external session skips the ACP load on purpose, but config options only
  // arrive with that load — so every session survived a bridge restart reporting no models,
  // and switching model failed because it validates against that same list.
  const message = (id, text) => ({
    info: { id, role: "assistant", sessionID: "session-1", time: { created: Date.now() } },
    parts: [{ id: `${id}:text`, type: "text", text }]
  })
  class ConfigOptionAcp extends EventEmitter {
    loads = 0
    selected = []
    async start() {}

    async listSessions() {
      return [{ sessionId: "session-1", cwd: process.cwd(), updatedAt: "2026-07-26T00:00:00.000Z" }]
    }

    async request(method, params) {
      if (method === "session/set_config_option") {
        this.selected.push(params.value)
        return {}
      }
      if (method !== "session/load") return {}
      this.loads += 1
      return {
        configOptions: [{
          id: "model",
          currentValue: "lm/one",
          options: [{ value: "lm/one", name: "One" }, { value: "lm/two", name: "Two" }]
        }]
      }
    }

    notify() {}
  }
  const acp = new ConfigOptionAcp()
  const driver = new AcpService(acp, { historyLoader: async () => [message("native-first", "First")] })

  assert.deepEqual((await driver.messages("session-1")).map((item) => item.parts[0].text), ["First"])
  assert.equal(acp.loads, 0, "displaying an external session must not load it")

  assert.deepEqual((await driver.models("session-1")).map((option) => option.value), ["lm/one", "lm/two"])
  assert.equal(acp.loads, 1, "the options are fetched once, only when asked for")

  assert.deepEqual(
    (await driver.messages("session-1")).map((item) => item.parts[0].text),
    ["First"],
    "fetching config options must not discard the external history"
  )

  await driver.setModel("session-1", "lm/two")
  assert.deepEqual(acp.selected, ["lm/two"], "switching model must work on a session this process did not create")

  await driver.models("session-1")
  assert.equal(acp.loads, 1, "options already held must not trigger another load")
})

test("keeps an external transcript readable when the harness refuses the load that models needs", async () => {
  // Codex allows one writer per conversation and refuses `session/load` for any thread another
  // client holds open, so config options are genuinely unavailable there. The app asks for the
  // transcript and the models together on every open, and a single in-flight load shared between
  // them handed that refusal to the transcript too — so those sessions would not open at all.
  class RefusingAcp extends EventEmitter {
    loads = 0
    async start() {}

    async listSessions() {
      return [{ sessionId: "session-1", cwd: process.cwd(), updatedAt: "2026-08-07T00:00:00.000Z" }]
    }

    async request(method) {
      if (method !== "session/load") return {}
      this.loads += 1
      throw new Error("thread session-1 already has an active writer")
    }

    notify() {}
  }
  const history = [{
    info: { id: "native-first", role: "user", sessionID: "session-1", time: { created: Date.now() } },
    parts: [{ id: "native-first:text", type: "text", text: "First" }]
  }]
  const acp = new RefusingAcp()
  const driver = new AcpService(acp, { historyLoader: async () => history })

  const [messages, models] = await Promise.all([
    driver.messages("session-1"),
    driver.models("session-1").then(() => "loaded", () => "refused")
  ])
  assert.deepEqual(messages.map((item) => item.parts[0].text), ["First"], "the transcript must survive a refused load")
  assert.equal(models, "refused", "models are genuinely unavailable while another client holds the thread")

  assert.deepEqual(
    (await driver.messages("session-1")).map((item) => item.parts[0].text),
    ["First"],
    "a later read must not inherit the earlier refusal either"
  )
})

test("merges bridge-only legacy prompts into native external history by timestamp", async () => {
  class ExternalAcp extends EventEmitter {
    async start() {}
    async listSessions() {
      return [{ sessionId: "external-1", cwd: process.cwd(), updatedAt: "2026-07-26T10:00:00.000Z" }]
    }
    async request() {
      return {}
    }
    notify() {}
  }
  const envelope = (id, role, text, created) => ({
    info: { id, role, sessionID: "external-1", time: { created } },
    parts: [{ id: `${id}:text`, type: "text", text }]
  })
  const nativeHistory = [
    envelope("native-first", "user", "First", 1_000),
    envelope("native-last", "assistant", "Last", 3_000)
  ]
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "harness-remote-external-"))
  const snapshotPath = path.join(snapshotDirectory, `${Buffer.from("external-1").toString("base64url")}.json`)
  await writeFile(snapshotPath, JSON.stringify({
    version: 1,
    messages: [
      envelope("native-first", "user", "First", 1_000),
      envelope("bridge-only", "user", "Bridge only", 2_000)
    ],
    todos: [{ id: "stale", content: "Stale external todo", status: "pending", priority: "medium" }],
  }))
  try {
    const driver = new AcpService(new ExternalAcp(), {
      snapshotDirectory,
      historyLoader: async () => nativeHistory,
    })
    assert.deepEqual(
      (await driver.messages("external-1")).map((item) => item.parts[0].text),
      ["First", "Bridge only", "Last"]
    )
    assert.deepEqual(await driver.todos("external-1"), [])
    await driver.flushSnapshots()
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
})

test("continues sessions created by another OMP client and reacquires them after restart", async () => {
  class OwnershipAcp extends EventEmitter {
    sessions = [{ sessionId: "desktop-session", cwd: process.cwd(), updatedAt: "2026-07-26T00:00:00.000Z" }]
    prompts = []
    loads = []
    async start() {}

    async listSessions() {
      return this.sessions
    }

    async request(method, params) {
      if (method === "session/new") {
        const session = { sessionId: "mobile-session", cwd: params.cwd, updatedAt: "2026-07-26T00:00:00.000Z" }
        this.sessions.push(session)
        return { sessionId: session.sessionId, configOptions: [] }
      }
      if (method === "session/load") {
        this.loads.push(params.sessionId)
        return {}
      }
      if (method === "session/prompt") {
        this.prompts.push(params.sessionId)
        return {}
      }
      return {}
    }

    notify() {}
  }

  const persistedMessage = (sessionID, text = "Existing history", created = 1_000) => ({
    info: { id: `${sessionID}-history-${created}`, role: "assistant", sessionID, time: { created } },
    parts: [{ id: `${sessionID}-history-${created}:text`, type: "text", text }]
  })
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "harness-remote-ownership-"))
  const acp = new OwnershipAcp()
  const nativeHistory = new Map()
  const historyLoader = async (sessionID) => nativeHistory.get(sessionID) ?? [persistedMessage(sessionID)]
  const driver = new AcpService(acp, { historyLoader, snapshotDirectory })

  assert.equal((await driver.listSessions()).find((session) => session.id === "desktop-session")?.external, true)
  await driver.prompt("desktop-session", "Continue from the app")
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(acp.loads, ["desktop-session"])
  assert.deepEqual(acp.prompts, ["desktop-session"])
  assert.equal((await driver.listSessions()).find((session) => session.id === "desktop-session")?.external, undefined)

  nativeHistory.set("desktop-session", [
    persistedMessage("desktop-session"),
    persistedMessage("desktop-session", "Concurrent desktop reply", 9_000_000_000_000)
  ])
  assert.deepEqual(
    (await driver.messages("desktop-session", true)).map((message) => message.parts[0].text),
    ["Existing history", "Continue from the app", "Concurrent desktop reply"]
  )

  await driver.createSession({ directory: process.cwd(), title: "Mobile", model: undefined })
  await driver.flushSnapshots()
  const restarted = new AcpService(acp, { historyLoader, snapshotDirectory })
  assert.equal((await restarted.listSessions()).find((session) => session.id === "mobile-session")?.external, true)
  await restarted.prompt("mobile-session", "Continue after restart")
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(acp.loads, ["desktop-session", "desktop-session", "mobile-session"])
  assert.deepEqual(acp.prompts, ["desktop-session", "mobile-session"])
  await restarted.flushSnapshots()
  await rm(snapshotDirectory, { recursive: true, force: true })
})

// A harness that injects its own bookkeeping into the model's context sends it as a user turn, and
// the adapter forwards it as a user_message_chunk. Rendered as-is the app attributes harness
// internals to the person holding the phone: observed live on the Claude Code backend, where a
// background-task notification appeared as a message the user had supposedly written.
test("hides harness-injected blocks from the transcript without hiding a message that quotes one", () => {
  assert.equal(isHarnessInjectedText("<task-notification><task-id>abc</task-id></task-notification>"), true)
  assert.equal(isHarnessInjectedText("  <system-reminder>remember this</system-reminder>\n"), true)
  assert.equal(
    isHarnessInjectedText("<task-notification>a</task-notification><system-reminder>b</system-reminder>"),
    true,
    "several blocks back to back are still nothing but bookkeeping"
  )
  // The report itself was a message quoting one of these while asking about it. That must survive.
  assert.equal(
    isHarnessInjectedText("this appeared as if I wrote it: <task-notification>x</task-notification> why?"),
    false
  )
  assert.equal(isHarnessInjectedText("deploy the <task-notification> tag docs"), false)
  assert.equal(isHarnessInjectedText("ordinary prompt"), false)
})

test("drops an injected user chunk while keeping the surrounding conversation", async () => {
  class ChatAcp extends EventEmitter {
    agentInfo = { version: "0.63.0" }
    async start() {}
    async listSessions() {
      return [{ sessionId: "session-1", cwd: process.cwd(), updatedAt: "2026-07-28T00:00:00.000Z" }]
    }
    async request() {
      return {}
    }
    notify() {}
  }

  const acp = new ChatAcp()
  const service = new AcpService(acp)
  await service.listSessions()
  const send = (messageId, text) => acp.emit("notification", {
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: { sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text } }
    }
  })

  send("u1", "a real question")
  send("u2", "<task-notification><task-id>abc</task-id><status>stopped</status></task-notification>")
  send("u3", "and a follow-up")

  const texts = (await service.messages("session-1")).map((message) =>
    message.parts.filter((part) => part.type === "text").map((part) => part.text).join("")
  )
  assert.deepEqual(texts, ["a real question", "and a follow-up"], "the injected block must not become a user message")
})

// Claude Code's adapter names models with bare ids rather than `provider/model`. The response
// builder split on "/" and required both halves, so every option was dropped and the backend looked
// like it exposed no models — the reason its profile carried `models: false`. Both directions are
// asserted here: the list the app receives, and the value that reaches the agent when one is picked.
class FlatModelAcp extends EventEmitter {
  agentInfo = { version: "0.63.0" }
  models = []

  async start() {}

  async listSessions() {
    return [{ sessionId: "session-1", cwd: process.cwd(), updatedAt: "2026-07-28T00:00:00.000Z" }]
  }

  async request(method, params) {
    if (method === "session/load" || method === "session/new") {
      return {
        sessionId: "session-1",
        configOptions: [{
          id: "model",
          currentValue: "default",
          options: [
            { value: "default", name: "Default (recommended)", description: "Sonnet 5 · Efficient for routine tasks" },
            { value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks" },
            { value: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context" }
          ]
        }]
      }
    }
    if (method === "session/set_config_option") {
      this.models.push(params.value)
      return {}
    }
    if (method === "session/prompt") return { stopReason: "end_turn" }
    return {}
  }

  notify() {}
}

test("offers models a harness names without a provider prefix, and sets them back verbatim", async () => {
  const acp = new FlatModelAcp()
  const bridge = await startServer({ acp, backend: "claude" })
  try {
    const listed = await fetch(`${bridge.baseURL}/config/providers?sessionID=session-1`, { headers: authHeaders() })
    const body = await listed.json()
    assert.equal(body.providers.length, 1, "bare ids must not be discarded")
    const provider = body.providers[0]
    assert.equal(provider.id, "claude", "a bare id is presented under the backend's own name")
    assert.equal(provider.name, "claude")
    assert.deepEqual(Object.keys(provider.models).sort(), ["default", "opus[1m]", "sonnet"])
    assert.equal(provider.models.sonnet.name, "Sonnet")
    // The harness puts the model version in the description; dropping it left the picker showing
    // "Sonnet" with no way to tell which Sonnet.
    assert.equal(provider.models["opus[1m]"].description, "Opus 5 with 1M context")
    assert.equal(provider.models.sonnet.description, "Sonnet 5 · Efficient for routine tasks")
    assert.equal(body.default[provider.id], "default", "the current model is reported as the default")

    // The app sends back the pair it was given; the agent must receive the original ACP value.
    const prompted = await fetch(`${bridge.baseURL}/session/session-1/prompt_async`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ parts: [{ type: "text", text: "hello" }], model: { providerID: provider.id, modelID: "opus[1m]" } })
    })
    assert.equal(prompted.status, 200)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(acp.models, ["opus[1m]"], "a bare id must not be re-joined into provider/model")
  } finally {
    await bridge.close()
  }
})

test("keeps provider/model values untouched for the harnesses that use them", async () => {
  const acp = new HeldTurnOmpAcp()
  const bridge = await startServer({ acp })
  try {
    const listed = await fetch(`${bridge.baseURL}/config/providers?sessionID=session-1`, { headers: authHeaders() })
    const body = await listed.json()
    assert.equal(body.providers[0].id, "omp", "a value with a provider part still yields that provider")
    assert.equal(body.providers[0].name, "omp")
    assert.deepEqual(Object.keys(body.providers[0].models).sort(), ["first", "second"])
    assert.equal(body.providers[0].models.first.description, undefined, "a harness that describes nothing must not gain an empty line")
  } finally {
    await bridge.close()
  }
})

/** Advertises a skill command alongside the extension ones, as OMP does. */
class SkillCommandAcp extends ExtensionActionAcp {
  async request(method, params) {
    const result = await super.request(method, params)
    if (method === "session/load") {
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "model", description: "Show current model selection" },
              { name: "skill:memory", description: "Runtime-boundary guidance for memory" }
            ]
          }
        }
      })
    }
    return result
  }
}

test("serves the harness command catalog and marks skills by source", async () => {
  const bridge = await startServer({ acp: new SkillCommandAcp() })
  try {
    const scoped = await readJSON(bridge.baseURL, "/command?sessionID=session-1")
    assert.deepEqual(scoped, [
      { name: "model", description: "Show current model selection", source: "command" },
      { name: "skill:memory", description: "Runtime-boundary guidance for memory", source: "skill" }
    ])
    // The app asks for the picker without a session, so the newest catalog has to answer.
    assert.deepEqual(await readJSON(bridge.baseURL, "/command"), scoped)
  } finally {
    await bridge.close()
  }
})

test("sends a picked command to the harness as slash-prefixed prompt text", async () => {
  const acp = new SkillCommandAcp()
  const bridge = await startServer({ acp })
  try {
    await readJSON(bridge.baseURL, "/session/session-1/command", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ command: "skill:memory", arguments: "status" })
    })
    assert.ok(acp.prompts.includes("/skill:memory status"), `prompts were ${JSON.stringify(acp.prompts)}`)

    await readJSON(bridge.baseURL, "/session/session-1/command", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ command: "model" })
    })
    assert.ok(acp.prompts.includes("/model"), "a command with no arguments must not gain a trailing space")

    const rejected = await fetch(`${bridge.baseURL}/session/session-1/command`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ arguments: "status" })
    })
    assert.equal(rejected.status, 400)
  } finally {
    await bridge.close()
  }
})

test("fills the command catalog once a session is loaded, so a cold bridge recovers", async () => {
  const bridge = await startServer({ acp: new SkillCommandAcp() })
  try {
    // The app fetches the picker at mount, before any session exists. An idle bridge has
    // nothing to advertise yet, and answering with a stale or invented list would be worse.
    assert.deepEqual(await readJSON(bridge.baseURL, "/command"), [])

    await readJSON(bridge.baseURL, "/session/session-1/message")

    const afterLoad = await readJSON(bridge.baseURL, "/command")
    assert.deepEqual(afterLoad.map((command) => command.name), ["model", "skill:memory"])
  } finally {
    await bridge.close()
  }
})
