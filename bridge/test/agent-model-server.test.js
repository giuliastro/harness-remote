import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { createAgentModelServer } from "../src/agent-model-server.js"

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function config() {
  return { username: "harness", password: "secret", corsOrigins: [] }
}

function auth() {
  return { Authorization: `Basic ${Buffer.from("harness:secret").toString("base64")}` }
}

test("GET agent models returns the daemon refresh result", async () => {
  const calls = []
  const daemon = {
    async listModels(agentID, options) {
      calls.push({ agentID, options })
      return {
        models: [{ providerID: "openai", providerName: "OpenAI", modelID: "gpt-x", modelName: "GPT X", isDefault: true }],
        stale: false,
        refreshedAt: "2026-08-14T20:00:00.000Z"
      }
    }
  }
  const innerServer = http.createServer((_request, response) => {
    response.writeHead(500)
    response.end("should not be reached")
  })
  const server = createAgentModelServer({ innerServer, config: config(), daemon, taskStore: {} })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/agents/pi/models`, { headers: auth() })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.stale, false)
    assert.deepEqual(body.models.map((model) => model.modelID), ["gpt-x"])
    assert.deepEqual(calls, [{ agentID: "pi", options: { allowStale: true } }])
  } finally {
    await close(server)
  }
})

test("task launch is rejected before reaching the launcher when its model disappeared", async () => {
  let delegated = 0
  const error = new Error("Selected model is no longer available: openai/removed")
  error.code = "model_unavailable"
  const daemon = {
    async validateModel(agentID, model) {
      assert.equal(agentID, "pi")
      assert.deepEqual(model, { providerID: "openai", modelID: "removed" })
      throw error
    }
  }
  const taskStore = {
    async get(id) {
      assert.equal(id, "task-1")
      return { id, agentId: "pi", model: { providerID: "openai", modelID: "removed" } }
    }
  }
  const innerServer = http.createServer((_request, response) => {
    delegated += 1
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ launched: true }))
  })
  const server = createAgentModelServer({ innerServer, config: config(), daemon, taskStore })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/tasks/task-1/launch`, { method: "POST", headers: auth() })
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /no longer available/)
    assert.equal(delegated, 0, "an obsolete selection must never reach TaskRunController")
  } finally {
    await close(server)
  }
})

test("task launch delegates after a fresh validation succeeds", async () => {
  let validations = 0
  let delegated = 0
  const daemon = {
    async validateModel() { validations += 1 }
  }
  const taskStore = {
    async get() { return { id: "task-2", agentId: "claude", model: { providerID: "claude", modelID: "sonnet" } } }
  }
  const innerServer = http.createServer((_request, response) => {
    delegated += 1
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ launched: true }))
  })
  const server = createAgentModelServer({ innerServer, config: config(), daemon, taskStore })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/tasks/task-2/launch`, { method: "POST", headers: auth() })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).launched, true)
    assert.equal(validations, 1)
    assert.equal(delegated, 1)
  } finally {
    await close(server)
  }
})
