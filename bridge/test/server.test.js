import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import path from "node:path"
import test from "node:test"
import { createBridgeServer } from "../src/server.js"
import { OmpService } from "../src/omp-service.js"

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
            sessionUpdate: "agent_message_chunk",
            messageId: "persisted-assistant",
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

test("allows only explicitly configured browser origins", async () => {
  const bridge = await startServer({ corsOrigins: ["http://192.168.1.64:5199"] })
  try {
    const preflight = await fetch(`${bridge.baseURL}/session`, {
      method: "OPTIONS",
      headers: { origin: "http://192.168.1.64:5199", "access-control-request-method": "GET" }
    })
    assert.equal(preflight.status, 204, "the preflight must succeed without credentials")
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://192.168.1.64:5199")
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true")
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
    assert.equal(response.headers.get("www-authenticate"), 'Basic realm="OMP Bridge"')
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
    assert.deepEqual((await response.json()).map((message) => ({
      role: message.info.role,
      text: message.parts[0].text
    })), [
      { role: "user", text: "Persist this prompt" },
      { role: "assistant", text: "Persist this response" }
    ])
  } finally {
    await bridge.close()
  }
})

test("does not publish replay notifications as live session activity", async () => {
  const acp = new ReplayAcp()
  const omp = new OmpService(acp)
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
