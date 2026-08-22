import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import http from "node:http"
import test from "node:test"
import { createAgentRoutingServer } from "../src/agent-router.js"

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

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

class BridgeServer extends EventEmitter {}

function daemonWith(entries, states = {}) {
  return {
    hostEntry(id) { return entries[id] },
    registry: {
      host(id) {
        const value = states[id]
        if (!value) return undefined
        return typeof value === "string" ? { state: value } : value
      }
    },
    snapshot() {
      return {
        agents: Object.entries(states).map(([id, value]) => typeof value === "string"
          ? { id, backend: id, state: value }
          : { id, backend: value.backend ?? id, ...value })
      }
    }
  }
}

function routedServer(managed, options = {}) {
  return createAgentRoutingServer({
    daemon: daemonWith({ opencode: { id: "opencode", kind: "http", host: managed } }, { opencode: "available" }),
    config: { username: "", password: "", corsOrigins: [], ...options.config },
    primaryAgentID: "codex",
    bridgeServer: new BridgeServer(),
    ...options
  })
}

test("primary ACP agent prefix reuses the normalized bridge routes", async () => {
  const bridgeServer = new BridgeServer()
  bridgeServer.on("request", (request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ url: request.url }))
  })
  const server = createAgentRoutingServer({
    daemon: daemonWith({}),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/session?directory=%2Fwork`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { url: "/session?directory=%2Fwork" })
  } finally {
    await close(server)
  }
})

test("known unsupported ACP detail reads return empty data without hitting the bridge", async () => {
  let bridgeHits = 0
  const bridgeServer = new BridgeServer()
  bridgeServer.on("request", (_request, response) => {
    bridgeHits += 1
    response.writeHead(500)
    response.end()
  })
  const daemon = daemonWith(
    { codex: { id: "codex", kind: "acp" } },
    {
      codex: {
        state: "available",
        backend: "codex",
        capabilities: { questions: false, permissions: false }
      }
    }
  )
  const server = createAgentRoutingServer({
    daemon,
    config: { username: "outer", password: "secret", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer
  })
  const port = await listen(server)
  const headers = { Authorization: basic("outer", "secret") }
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/question`)
    assert.equal(unauthorized.status, 401)

    const question = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/question`, { headers })
    assert.equal(question.status, 200)
    assert.deepEqual(await question.json(), [])

    const permission = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/permission?directory=%2Fwork`, { headers })
    assert.equal(permission.status, 200)
    assert.deepEqual(await permission.json(), [])

    const vcs = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/vcs?directory=%2Fwork`, { headers })
    assert.equal(vcs.status, 200)
    assert.deepEqual(await vcs.json(), {})

    assert.equal(bridgeHits, 0)
  } finally {
    await close(server)
  }
})

test("a non-primary ACP agent is dispatched to its own bridge instead of the primary sessions", async () => {
  const primary = new BridgeServer()
  primary.on("request", (_request, response) => response.end("primary"))
  const pi = new BridgeServer()
  pi.on("request", (request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ agent: "pi", url: request.url }))
  })
  const server = createAgentRoutingServer({
    daemon: daemonWith({ pi: { id: "pi", kind: "acp" } }, { pi: "configured" }),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: primary,
    acpBridgeServer: (agentID) => agentID === "pi" ? pi : undefined
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/pi/session?directory=%2Fwork`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { agent: "pi", url: "/session?directory=%2Fwork" })
  } finally {
    await close(server)
  }
})

test("managed HTTP routing replaces client credentials with host credentials", async () => {
  let upstreamRequest
  const upstream = http.createServer((request, response) => {
    upstreamRequest = { url: request.url, authorization: request.headers.authorization }
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ ok: true }))
  })
  const upstreamPort = await listen(upstream)
  const managed = {
    readinessHost: "127.0.0.1",
    port: upstreamPort,
    username: "internal-user",
    password: "internal-secret"
  }
  const server = routedServer(managed, {
    config: { username: "outer-user", password: "outer-secret" }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/opencode/session?directory=%2Fwork`, {
      headers: { Authorization: basic("outer-user", "outer-secret") }
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(upstreamRequest.url, "/session?directory=%2Fwork")
    assert.equal(upstreamRequest.authorization, basic("internal-user", "internal-secret"))
    assert.notEqual(upstreamRequest.authorization, basic("outer-user", "outer-secret"))
  } finally {
    await close(server)
    await close(upstream)
  }
})

test("managed HTTP agent routes keep daemon authentication", async () => {
  let proxied = false
  const managed = { readinessHost: "127.0.0.1", port: 4096, username: "internal", password: "secret" }
  const server = routedServer(managed, {
    config: { username: "outer", password: "secret" },
    proxyRequest: async () => { proxied = true }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/opencode/session`)
    assert.equal(response.status, 401)
    assert.equal(proxied, false)
  } finally {
    await close(server)
  }
})

test("configured managed HTTP agents start on first authenticated request", async () => {
  const state = { value: "configured" }
  let starts = 0
  let proxied = 0
  const managed = {
    async start() {
      starts += 1
      state.value = "available"
    }
  }
  const daemon = {
    hostEntry(id) { return id === "opencode" ? { id, kind: "http", host: managed } : undefined },
    registry: { host(id) { return id === "opencode" ? { state: state.value } : undefined } },
    snapshot() { return { agents: [{ id: "opencode", backend: "opencode", state: state.value }] } }
  }
  const server = createAgentRoutingServer({
    daemon,
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: new BridgeServer(),
    proxyRequest: async ({ response }) => {
      proxied += 1
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ ok: true }))
    }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/opencode/session`)
    assert.equal(response.status, 200)
    assert.equal(starts, 1)
    assert.equal(proxied, 1)
    assert.equal(state.value, "available")
  } finally {
    await close(server)
  }
})

test("failed first-use managed HTTP startup returns 503 without proxying", async () => {
  let proxied = 0
  const managed = { async start() { throw new Error("OpenCode boot failed") } }
  const server = createAgentRoutingServer({
    daemon: daemonWith({ opencode: { id: "opencode", kind: "http", host: managed } }, { opencode: "configured" }),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: new BridgeServer(),
    proxyRequest: async () => { proxied += 1 }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/opencode/session`)
    assert.equal(response.status, 503)
    assert.match((await response.json()).error, /OpenCode boot failed/)
    assert.equal(proxied, 0)
  } finally {
    await close(server)
  }
})

test("unavailable managed HTTP agents retry their idempotent start path", async () => {
  const state = { value: "unavailable" }
  let starts = 0
  let proxied = 0
  const managed = {
    async start() {
      starts += 1
      state.value = "available"
    }
  }
  const daemon = {
    hostEntry(id) { return id === "opencode" ? { id, kind: "http", host: managed } : undefined },
    registry: { host(id) { return id === "opencode" ? { state: state.value } : undefined } },
    snapshot() { return { agents: [{ id: "opencode", backend: "opencode", state: state.value }] } }
  }
  const server = createAgentRoutingServer({
    daemon,
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: new BridgeServer(),
    proxyRequest: async ({ response }) => {
      proxied += 1
      response.writeHead(200)
      response.end()
    }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/opencode/session`)
    assert.equal(response.status, 200)
    assert.equal(starts, 1)
    assert.equal(proxied, 1)
  } finally {
    await close(server)
  }
})

test("unavailable and unknown agents fail without contacting a managed host when restart cannot recover", async () => {
  let proxied = 0
  const managed = { readinessHost: "127.0.0.1", port: 4096 }
  const server = createAgentRoutingServer({
    daemon: daemonWith({ opencode: { id: "opencode", kind: "http", host: managed } }, { opencode: "unavailable" }),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: new BridgeServer(),
    proxyRequest: async () => { proxied += 1 }
  })
  const port = await listen(server)
  try {
    const unavailable = await fetch(`http://127.0.0.1:${port}/v1/agents/opencode/session`)
    assert.equal(unavailable.status, 503)
    const unknown = await fetch(`http://127.0.0.1:${port}/v1/agents/missing/session`)
    assert.equal(unknown.status, 404)
    assert.equal(proxied, 0)
  } finally {
    await close(server)
  }
})

test("managed SSE reconnect soak keeps one upstream subscription until daemon shutdown", async () => {
  let upstreamConnections = 0
  let activeUpstream = 0
  let maxActiveUpstream = 0
  let upstreamClosed = 0
  const upstream = http.createServer((request, response) => {
    upstreamConnections += 1
    activeUpstream += 1
    maxActiveUpstream = Math.max(maxActiveUpstream, activeUpstream)
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write(": upstream connected\n\n")
    request.once("close", () => {
      activeUpstream -= 1
      upstreamClosed += 1
    })
  })
  const upstreamPort = await listen(upstream)
  const server = routedServer({ readinessHost: "127.0.0.1", port: upstreamPort })
  const port = await listen(server)
  const connectAndDrop = () => new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/v1/agents/opencode/global/event`, (response) => {
      response.once("data", () => {
        request.destroy()
        resolve()
      })
    })
    request.once("error", (error) => {
      if (error.code !== "ECONNRESET") reject(error)
    })
  })
  try {
    await connectAndDrop()
    for (let attempt = 0; attempt < 50 && upstreamConnections === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(upstreamConnections, 1)

    for (let index = 0; index < 25; index += 1) await connectAndDrop()
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(upstreamConnections, 1, "downstream reconnects must not multiply OpenCode GlobalBus subscribers")
    assert.equal(maxActiveUpstream, 1)
    assert.equal(upstreamClosed, 0, "the daemon owns the upstream stream across phone reconnects")
  } finally {
    await close(server)
    for (let attempt = 0; attempt < 50 && upstreamClosed === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(upstreamClosed, 1, "daemon shutdown must release the one upstream listener")
    await close(upstream)
  }
})

test("an upstream reset is isolated to the proxied request", async () => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.write("{")
    response.socket.destroy()
  })
  const upstreamPort = await listen(upstream)
  const server = routedServer({ readinessHost: "127.0.0.1", port: upstreamPort })
  const port = await listen(server)
  try {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/agents/opencode/session`)
      await response.text()
    } catch {
      // Either the headers or body can observe the upstream reset; the daemon must survive both shapes.
    }
    const second = await fetch(`http://127.0.0.1:${port}/v1/agents/missing/session`)
    assert.equal(second.status, 404)
  } finally {
    await close(server)
    await close(upstream)
  }
})