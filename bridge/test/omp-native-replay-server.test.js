import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createOmpHistoryLoader } from "../src/omp-session-history.js"
import { createBridgeServer } from "../src/server.js"

class NativeOmpAcp extends EventEmitter {
  agentInfo = { version: "18.0.6" }
  loads = 0
  resumes = 0
  prompts = []

  async start() {}

  async listSessions() {
    return [{
      sessionId: "session-1",
      title: "Native OMP",
      cwd: process.cwd(),
      updatedAt: "2026-08-26T10:00:00.000Z"
    }]
  }

  async request(method, params) {
    if (method === "session/load") {
      this.loads += 1
      throw new Error("read path must not call session/load")
    }
    if (method === "session/resume") {
      this.resumes += 1
      assert.equal(params.sessionId, "session-1")
      return {
        configOptions: [{
          id: "model",
          currentValue: "openai-codex/gpt-5.6-terra",
          options: [{ value: "openai-codex/gpt-5.6-terra", name: "GPT-5.6 Terra" }]
        }]
      }
    }
    if (method === "session/prompt") {
      this.prompts.push(params.sessionId)
      return { stopReason: "end_turn" }
    }
    return {}
  }

  notify() {}
}

function authHeaders() {
  return { authorization: `Basic ${Buffer.from("omp:secret").toString("base64")}` }
}

async function startServer(historyLoader) {
  const acp = new NativeOmpAcp()
  const server = createBridgeServer({
    acp,
    serviceOptions: { historyLoader },
    config: {
      backend: "omp",
      host: "127.0.0.1",
      port: 0,
      username: "omp",
      password: "secret",
      roots: [process.cwd()]
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return {
    acp,
    service: server.acpService,
    baseURL: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test("OMP history read stays journal-only and writer claim uses session/resume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-native-resume-"))
  const records = [
    { type: "session", version: 3, id: "session-1", cwd: process.cwd() },
    { type: "message", id: "u0", parentId: null, timestamp: "2026-08-26T10:00:00.000Z", message: { role: "user", content: "first" } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "2026-08-26T10:00:01.000Z", message: { role: "assistant", content: "first answer" } },
    { type: "message", id: "u1", parentId: "a0", timestamp: "2026-08-26T10:00:02.000Z", message: { role: "user", content: "retry this" } },
    { type: "message", id: "abandoned", parentId: "u1", timestamp: "2026-08-26T10:00:03.000Z", message: { role: "assistant", content: "abandoned answer" } },
    { type: "message", id: "selected", parentId: "u1", timestamp: "2026-08-26T10:00:04.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", content: "selected answer" } }
  ]
  await writeFile(path.join(root, "2026-08-26_session-1.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  const historyLoader = createOmpHistoryLoader(root)
  const bridge = await startServer(historyLoader)
  try {
    const response = await fetch(`${bridge.baseURL}/session/session-1/message?limit=100`, { headers: authHeaders() })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).map((message) => message.info.id), ["u0", "a0", "u1", "selected"])
    assert.equal(bridge.acp.loads, 0, "opening an OMP Session must not replay or acquire it")
    assert.equal(bridge.acp.resumes, 0, "reading is observational and must not acquire a writer")

    await bridge.service.claimSession("session-1")
    assert.equal(bridge.acp.resumes, 1, "the first real writer claim uses OMP's native resume")
    assert.equal(bridge.acp.loads, 0, "claiming OMP must not replay the whole transcript")

    await bridge.service.prompt("session-1", "continue")
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(bridge.acp.prompts, ["session-1"])
    assert.equal(bridge.acp.loads, 0)
    assert.equal(bridge.acp.resumes, 1)

    const reopened = await fetch(`${bridge.baseURL}/session/session-1/message?limit=100`, { headers: authHeaders() })
    assert.equal(reopened.status, 200)
    assert.equal(bridge.acp.loads, 0, "post-prompt reads remain journal-authoritative")
  } finally {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("an OMP journal read failure never falls back to session/load", async () => {
  const historyLoader = async () => {
    throw new Error("simulated JSONL rewrite window")
  }
  historyLoader.authoritativeHistory = true
  historyLoader.neverReplayOnRead = true

  const bridge = await startServer(historyLoader)
  try {
    const response = await fetch(`${bridge.baseURL}/session/session-1/message?limit=100`, { headers: authHeaders() })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), [])
    assert.equal(bridge.acp.loads, 0, "a transient journal failure must never acquire OMP through session/load")
    assert.equal(bridge.acp.resumes, 0, "a transcript GET must remain observational even on failure")
  } finally {
    await bridge.close()
  }
})

test("old OMP v1 transcript is visible through HTTP without any native load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-native-v1-"))
  const records = [
    { type: "session", cwd: process.cwd(), timestamp: "2025-01-01T00:00:00.000Z" },
    { type: "message", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "legacy prompt" } },
    { type: "message", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", content: "legacy answer" } }
  ]
  await writeFile(path.join(root, "2025-01-01_session-1.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  const bridge = await startServer(createOmpHistoryLoader(root))
  try {
    const response = await fetch(`${bridge.baseURL}/session/session-1/message?limit=100`, { headers: authHeaders() })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).map((message) => message.parts[0].text), ["legacy prompt", "legacy answer"])
    assert.equal(bridge.acp.loads, 0)
    assert.equal(bridge.acp.resumes, 0)
    const rawModel = response.headers.get("x-session-model")
    assert.deepEqual(JSON.parse(decodeURIComponent(rawModel)), { providerID: "openai-codex", modelID: "gpt-5.6-terra" })
  } finally {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})
