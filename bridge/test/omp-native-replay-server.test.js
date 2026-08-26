import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createOmpHistoryLoader } from "../src/omp-session-history.js"
import { createBridgeServer } from "../src/server.js"

class AmbiguousOmpAcp extends EventEmitter {
  agentInfo = { version: "18.0.6" }
  loads = 0

  async start() {}

  async listSessions() {
    return [{
      sessionId: "session-1",
      title: "Native OMP",
      cwd: process.cwd(),
      updatedAt: "2026-08-26T10:00:00.000Z"
    }]
  }

  async request(method) {
    if (method !== "session/load") return {}
    this.loads += 1
    for (const message of [
      { role: "user", id: "acp-u0", text: "first" },
      { role: "assistant", id: "acp-a0", text: "first answer" },
      { role: "user", id: "acp-u1", text: "retry this" },
      { role: "assistant", id: "acp-a1", text: "selected answer" }
    ]) {
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            messageId: message.id,
            content: { type: "text", text: message.text }
          }
        }
      })
    }
    return {
      configOptions: [{
        id: "model",
        currentValue: "openai-codex/gpt-5.6-terra",
        options: [{ value: "openai-codex/gpt-5.6-terra", name: "GPT-5.6 Terra" }]
      }]
    }
  }

  notify() {}
}

function authHeaders() {
  return { authorization: `Basic ${Buffer.from("omp:secret").toString("base64")}` }
}

async function startServer(historyLoader) {
  const acp = new AmbiguousOmpAcp()
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
    baseURL: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test("cold OMP read replays the native selected branch and returns stable JSONL truth in the same response", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-native-replay-"))
  const records = [
    { type: "message", id: "u0", parentId: null, timestamp: "2026-08-26T10:00:00.000Z", message: { role: "user", content: "first" } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "2026-08-26T10:00:01.000Z", message: { role: "assistant", content: "first answer" } },
    { type: "message", id: "u1", parentId: "a0", timestamp: "2026-08-26T10:00:02.000Z", message: { role: "user", content: "retry this" } },
    { type: "message", id: "failed", parentId: "u1", timestamp: "2026-08-26T10:00:03.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", errorMessage: "Interrupted by user", content: [] } },
    { type: "message", id: "abandoned", parentId: "u1", timestamp: "2026-08-26T10:00:04.000Z", message: { role: "assistant", content: "abandoned answer" } },
    { type: "message", id: "selected", parentId: "u1", timestamp: "2026-08-26T10:00:05.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", content: "selected answer" } }
  ]
  await writeFile(path.join(root, "2026-08-26_session-1.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  const historyLoader = createOmpHistoryLoader(root)
  const bridge = await startServer(historyLoader)
  try {
    const response = await fetch(`${bridge.baseURL}/session/session-1/message?limit=100`, { headers: authHeaders() })
    assert.equal(response.status, 200)
    const messages = await response.json()

    assert.equal(bridge.acp.loads, 1, "cold ambiguous history must use one native session/load rather than waiting for a Send")
    assert.deepEqual(messages.map((message) => message.info.id), ["u0", "a0", "u1", "failed", "selected"])
    assert.equal(messages.find((message) => message.info.id === "failed")?.info.error?.message, "Interrupted by user")
    assert.ok(!messages.some((message) => message.info.id === "abandoned"), "an unselected successful sibling must stay hidden")

    const rawModel = response.headers.get("x-session-model")
    assert.ok(rawModel, "the first successful read must carry the native Session model")
    assert.deepEqual(JSON.parse(decodeURIComponent(rawModel)), { providerID: "openai-codex", modelID: "gpt-5.6-terra" })

    const second = await fetch(`${bridge.baseURL}/session/session-1/message?limit=100`, { headers: authHeaders() })
    assert.equal(second.status, 200)
    assert.equal(bridge.acp.loads, 1, "once branch truth is confirmed, reopen must remain journal-only")
    assert.deepEqual((await second.json()).map((message) => message.info.id), ["u0", "a0", "u1", "failed", "selected"])
  } finally {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})
