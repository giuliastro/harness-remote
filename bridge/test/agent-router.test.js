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
      host(id) { return states[id] ? { state: states[id] } : undefined }
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

test("unavailable and unknown agents fail without contacting a managed host", async () => {
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

test("disconnecting an SSE client closes the managed upstream connection", async () => {
  let upstreamClosed = false
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write(": connected\n\n")
    request.once("close", () => { upstreamClosed = true })
  })
  const upstreamPort = await listen(upstream)
  const server = routedServer({ readinessHost: "127.0.0.1", port: upstreamPort })
  const port = await listen(server)
  try {
    await new Promise((resolve, reject) => {
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
    for (let attempt = 0; attempt < 20 && !upstreamClosed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(upstreamClosed, true)
  } finally {
    await close(server)
    await close(upstream)
  }
})

test("an upstream reset is isolated to the proxied request", async () => {
  const upstream = http.createServer((request, response) => {
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
