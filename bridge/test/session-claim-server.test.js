import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createSessionClaimServer } from "../src/session-claim-server.js"
import { SessionOperationLedger } from "../src/session-operation-ledger.js"

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

async function withLedger(run) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-route-"))
  try {
    const ledger = new SessionOperationLedger({ machineID: "machine-test", stateDirectory })
    return await run(ledger)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
}

function promptBody(overrides = {}) {
  return {
    clientRequestId: "request-1",
    text: "Continue the native session once",
    directory: "/repo",
    ...overrides
  }
}

function stopBody(overrides = {}) {
  return {
    clientRequestId: "stop-request-1",
    directory: "/repo",
    operationToken: "turn-message-42",
    ...overrides
  }
}

async function postPrompt(port, body = promptBody()) {
  return fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-123/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
}

async function postStop(port, body = stopBody()) {
  return fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-123/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
}

test("native Session claim targets the exact agent and existing Session id", async () => {
  const calls = []
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession(agentID, sessionID) { calls.push([agentID, sessionID]) }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-123/claim`, { method: "POST" })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { claimed: true, sessionID: "native-123" })
    assert.deepEqual(calls, [["codex", "native-123"]])
  } finally {
    await close(server)
  }
})

test("native writer refusal is a conflict and never falls through to another route", async () => {
  const innerServer = new EventEmitter()
  let delegated = false
  innerServer.on("request", () => { delegated = true })
  const server = createSessionClaimServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() { throw new Error("session is already active in another writer") }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-locked/claim`, { method: "POST" })
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /active in another writer/)
    assert.equal(delegated, false)
  } finally {
    await close(server)
  }
})

test("replaying one accepted client request id dispatches one native prompt", async () => withLedger(async (operationLedger) => {
  const calls = []
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession(agentID, sessionID, input) { calls.push([agentID, sessionID, input.text, input.directory]) }
  })
  const port = await listen(server)
  try {
    const first = await postPrompt(port)
    const replay = await postPrompt(port)
    assert.equal(first.status, 200)
    assert.equal(replay.status, 200)
    assert.equal((await first.json()).status, "accepted")
    assert.equal((await replay.json()).status, "accepted")
    assert.deepEqual(calls, [["codex", "native-123", "Continue the native session once", "/repo"]])
  } finally {
    await close(server)
  }
}))

test("concurrent retries converge before a second native prompt can start", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  let releaseDispatch
  let markStarted
  const dispatchStarted = new Promise((resolve) => { markStarted = resolve })
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve })
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession() {
      dispatches += 1
      markStarted()
      await dispatchGate
    }
  })
  const port = await listen(server)
  try {
    const firstPromise = postPrompt(port)
    await dispatchStarted
    const retry = await postPrompt(port)
    assert.equal(retry.status, 202)
    assert.equal((await retry.json()).status, "pending")
    assert.equal(dispatches, 1)

    releaseDispatch()
    const first = await firstPromise
    assert.equal(first.status, 200)
    assert.equal((await first.json()).status, "accepted")
    assert.equal(dispatches, 1)
  } finally {
    releaseDispatch?.()
    await close(server)
  }
}))

test("same client request id with different prompt is rejected without redispatch", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession() { dispatches += 1 }
  })
  const port = await listen(server)
  try {
    assert.equal((await postPrompt(port)).status, 200)
    const conflict = await postPrompt(port, promptBody({ text: "A different prompt" }))
    assert.equal(conflict.status, 409)
    assert.match((await conflict.json()).error, /already used for a different native Session operation/)
    assert.equal(dispatches, 1)
  } finally {
    await close(server)
  }
}))

test("ambiguous native delivery is retained as uncertain and is never replayed", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession() {
      dispatches += 1
      const error = new Error("native transport disconnected after dispatch")
      error.ambiguous = true
      throw error
    }
  })
  const port = await listen(server)
  try {
    const first = await postPrompt(port)
    assert.equal(first.status, 202)
    assert.equal((await first.json()).status, "uncertain")
    const replay = await postPrompt(port)
    assert.equal(replay.status, 202)
    assert.equal((await replay.json()).status, "uncertain")
    assert.equal(dispatches, 1)
  } finally {
    await close(server)
  }
}))

test("definite pre-accept rejection removes the ledger entry so the same request can retry", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession() {
      dispatches += 1
      if (dispatches === 1) {
        const error = new Error("native Session rejected before prompt acceptance")
        error.code = "session_prompt_rejected"
        throw error
      }
    }
  })
  const port = await listen(server)
  try {
    const rejected = await postPrompt(port)
    assert.equal(rejected.status, 409)
    const retry = await postPrompt(port)
    assert.equal(retry.status, 200)
    assert.equal((await retry.json()).status, "accepted")
    assert.equal(dispatches, 2)
  } finally {
    await close(server)
  }
}))

test("replaying one accepted Stop request dispatches one native cancel", async () => withLedger(async (operationLedger) => {
  const calls = []
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async stopSession(agentID, sessionID, input) { calls.push([agentID, sessionID, input.directory, input.operationToken]) }
  })
  const port = await listen(server)
  try {
    const first = await postStop(port)
    const replay = await postStop(port)
    assert.equal(first.status, 200)
    assert.equal(replay.status, 200)
    assert.equal((await first.json()).status, "accepted")
    assert.equal((await replay.json()).status, "accepted")
    assert.deepEqual(calls, [["codex", "native-123", "/repo", "turn-message-42"]])
  } finally {
    await close(server)
  }
}))

test("concurrent Stop retries converge before a second native cancel can start", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  let releaseDispatch
  let markStarted
  const dispatchStarted = new Promise((resolve) => { markStarted = resolve })
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve })
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async stopSession() {
      dispatches += 1
      markStarted()
      await dispatchGate
    }
  })
  const port = await listen(server)
  try {
    const firstPromise = postStop(port)
    await dispatchStarted
    const retry = await postStop(port)
    assert.equal(retry.status, 202)
    assert.equal((await retry.json()).status, "pending")
    assert.equal(dispatches, 1)

    releaseDispatch()
    const first = await firstPromise
    assert.equal(first.status, 200)
    assert.equal((await first.json()).status, "accepted")
    assert.equal(dispatches, 1)
  } finally {
    releaseDispatch?.()
    await close(server)
  }
}))

test("a Stop request id cannot be reused for a later turn token", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async stopSession() { dispatches += 1 }
  })
  const port = await listen(server)
  try {
    assert.equal((await postStop(port)).status, 200)
    const conflict = await postStop(port, stopBody({ operationToken: "later-turn-message-99" }))
    assert.equal(conflict.status, 409)
    assert.match((await conflict.json()).error, /already used for a different native Session operation/)
    assert.equal(dispatches, 1)
  } finally {
    await close(server)
  }
}))

test("ambiguous Stop delivery is retained as uncertain and never replayed", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async stopSession() {
      dispatches += 1
      const error = new Error("cancel transport disconnected after dispatch")
      error.ambiguous = true
      throw error
    }
  })
  const port = await listen(server)
  try {
    const first = await postStop(port)
    assert.equal(first.status, 202)
    assert.equal((await first.json()).status, "uncertain")
    const replay = await postStop(port)
    assert.equal(replay.status, 202)
    assert.equal((await replay.json()).status, "uncertain")
    assert.equal(dispatches, 1)
  } finally {
    await close(server)
  }
}))

test("Stop before ACP claim is a conflict and never becomes accepted", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async stopSession() {
      dispatches += 1
      const error = new Error("native Session must be claimed before Stop")
      error.code = "session_not_claimed"
      throw error
    }
  })
  const port = await listen(server)
  try {
    const rejected = await postStop(port)
    assert.equal(rejected.status, 409)
    assert.equal(dispatches, 1)
    const retry = await postStop(port)
    assert.equal(retry.status, 409)
    assert.equal(dispatches, 2)
  } finally {
    await close(server)
  }
}))

test("unknown agent maps to 404 and unrelated requests delegate unchanged", async () => {
  const innerServer = new EventEmitter()
  innerServer.on("request", (_request, response) => {
    response.writeHead(204)
    response.end()
  })
  const server = createSessionClaimServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {
      const error = new Error("Unknown agent: missing")
      error.code = "unknown_agent"
      throw error
    }
  })
  const port = await listen(server)
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/v1/agents/missing/session/native-1/claim`, { method: "POST" })
    assert.equal(missing.status, 404)
    const delegated = await fetch(`http://127.0.0.1:${port}/v1/projects`)
    assert.equal(delegated.status, 204)
  } finally {
    await close(server)
  }
})

test("native Session operation routes accept POST only", async () => {
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {}
  })
  const port = await listen(server)
  try {
    for (const action of ["claim", "prompt", "stop"]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/agents/pi/session/native-1/${action}`)
      assert.equal(response.status, 405)
      assert.equal(response.headers.get("allow"), "POST, OPTIONS")
    }
  } finally {
    await close(server)
  }
})

const SAMPLE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQiDqBFTEMLQkAFKhSgZfuVK8AAAAASUVORK5CYII="

function imagePart(overrides = {}) {
  return { type: "file", mime: "image/png", filename: "screenshot.png", url: `data:image/png;base64,${SAMPLE_PNG_BASE64}`, ...overrides }
}

test("a prompt carries its images to the harness", async () => withLedger(async (operationLedger) => {
  const dispatched = []
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    operationLedger,
    async promptSession(agentID, sessionID, input) { dispatched.push({ agentID, sessionID, input }) }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/claude/session/native-1/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptBody({ parts: [imagePart()] }))
    })
    assert.equal(response.status, 200)
    assert.equal(dispatched.length, 1)
    assert.equal(dispatched[0].input.attachments.length, 1)
    assert.equal(dispatched[0].input.attachments[0].mime, "image/png")
    assert.equal(dispatched[0].input.attachments[0].filename, "screenshot.png")
    // The base64 payload is what an ACP image block needs, not the data: URL wrapper.
    assert.equal(dispatched[0].input.attachments[0].data, SAMPLE_PNG_BASE64)
  } finally {
    await close(server)
  }
}))

test("an image with no words is a prompt", async () => withLedger(async (operationLedger) => {
  let dispatched = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    operationLedger,
    async promptSession() { dispatched += 1 }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/claude/session/native-2/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptBody({ text: "", parts: [imagePart()] }))
    })
    assert.equal(response.status, 200)
    assert.equal(dispatched, 1)
  } finally {
    await close(server)
  }
}))

test("the same words with a different image is a different prompt", async () => withLedger(async (operationLedger) => {
  // Without the attachments in the mutation signature the second send reuses the first request id
  // and is answered as a duplicate, so the second image is never seen.
  let dispatched = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    operationLedger,
    async promptSession() { dispatched += 1 }
  })
  const port = await listen(server)
  try {
    const send = (parts) => fetch(`http://127.0.0.1:${port}/v1/agents/claude/session/native-3/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptBody({ clientRequestId: "same-id", parts }))
    })
    assert.equal((await send([imagePart()])).status, 200)
    const conflict = await send([imagePart({ url: `data:image/png;base64,${SAMPLE_PNG_BASE64}AA==` })])
    assert.equal(conflict.status, 409)
    assert.equal(dispatched, 1)
  } finally {
    await close(server)
  }
}))

test("an unsupported attachment type is refused as a bad request", async () => withLedger(async (operationLedger) => {
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    operationLedger,
    async promptSession() { throw new Error("must not dispatch") }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/claude/session/native-4/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptBody({ parts: [imagePart({ mime: "application/pdf" })] }))
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /Unsupported attachment type/)
  } finally {
    await close(server)
  }
}))
