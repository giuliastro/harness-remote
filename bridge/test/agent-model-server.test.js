import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { createAgentModelServer } from "../src/agent-model-server.js"

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
function config() { return { username: "harness", password: "secret", corsOrigins: [] } }
function auth() { return { Authorization: `Basic ${Buffer.from("harness:secret").toString("base64")}` } }

test("GET agent models returns daemon refresh result", async () => {
  const calls = []
  const daemon = {
    async listModels(agentID, options) {
      calls.push({ agentID, options })
      return { models: [{ providerID: "openai", providerName: "OpenAI", modelID: "gpt-x", modelName: "GPT X", isDefault: true }], stale: false, refreshedAt: "2026-08-14T20:00:00.000Z" }
    }
  }
  const innerServer = http.createServer((_request, response) => { response.writeHead(500); response.end("should not be reached") })
  const server = createAgentModelServer({ innerServer, config: config(), daemon, taskStore: {} })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/agents/pi/models`, { headers: auth() })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.models.map((model) => model.modelID), ["gpt-x"])
    assert.deepEqual(calls, [{ agentID: "pi", options: { allowStale: true, refresh: false } }])
  } finally { await close(server) }
})

test("cold ACP catalog returns loading before the caller transport budget expires", async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  let calls = 0
  const daemon = {
    listModels() {
      calls += 1
      return pending
    },
    modelDiagnostics() {
      return { source: "acp-config-options", inFlight: true, refreshedAt: null, lastError: null }
    }
  }
  const innerServer = http.createServer((_request, response) => { response.writeHead(500); response.end("should not be reached") })
  const server = createAgentModelServer({ innerServer, config: config(), daemon, taskStore: {} })
  const base = await listen(server)
  try {
    const started = Date.now()
    const response = await fetch(`${base}/v1/agents/pi/models?waitMs=15`, { headers: auth() })
    assert.equal(response.status, 202)
    assert.ok(Date.now() - started < 500)
    assert.equal(response.headers.get("retry-after"), "1")
    const body = await response.json()
    assert.equal(body.loading, true)
    assert.equal(body.source, "acp-config-options")
    assert.equal(calls, 1)
  } finally {
    release({ models: [], stale: false, refreshedAt: null })
    await close(server)
  }
})

test("task launch is rejected when selected model disappeared", async () => {
  let delegated = 0
  const error = new Error("Selected model is no longer available: openai/removed")
  error.code = "model_unavailable"
  const daemon = { async validateModel() { throw error } }
  const taskStore = { async get() { return { id: "task-1", agentId: "pi", model: { providerID: "openai", modelID: "removed" } } } }
  const innerServer = http.createServer((_request, response) => { delegated += 1; response.writeHead(200); response.end("{}") })
  const server = createAgentModelServer({ innerServer, config: config(), daemon, taskStore })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/tasks/task-1/launch`, { method: "POST", headers: auth() })
    assert.equal(response.status, 409)
    assert.equal(delegated, 0)
  } finally { await close(server) }
})

test("task launch delegates after fresh model validation", async () => {
  let validations = 0
  let delegated = 0
  const daemon = { async validateModel() { validations += 1 } }
  const taskStore = { async get() { return { id: "task-2", agentId: "claude", model: { providerID: "claude", modelID: "sonnet" } } } }
  const innerServer = http.createServer((_request, response) => { delegated += 1; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ launched: true })) })
  const server = createAgentModelServer({ innerServer, config: config(), daemon, taskStore })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/tasks/task-2/launch`, { method: "POST", headers: auth() })
    assert.equal(response.status, 200)
    assert.equal(validations, 1)
    assert.equal(delegated, 1)
  } finally { await close(server) }
})