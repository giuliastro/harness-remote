import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

class PiHistoryAcp extends EventEmitter {
  constructor() {
    super()
    this.title = "PI native title"
    this.loadCount = 0
    this.prompts = []
  }

  async listSessions() {
    return [{ sessionId: "pi-session", cwd: process.cwd(), title: this.title, updatedAt: new Date().toISOString() }]
  }

  async request(method, params) {
    if (method === "session/load") {
      this.loadCount += 1
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "user_message_chunk", messageId: "user-1", content: { type: "text", text: "First prompt" } }
        }
      })
      if (this.loadCount > 1) {
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", messageId: "assistant-1", content: { type: "text", text: "Persisted PI answer" } }
          }
        })
      }
      return { configOptions: [] }
    }
    if (method === "session/prompt") {
      const text = params.prompt?.[0]?.text ?? ""
      this.prompts.push(text)
      if (text.startsWith("/name ")) this.title = text.slice(6)
      return { stopReason: "end_turn" }
    }
    throw new Error(`Unexpected request: ${method}`)
  }
}

const visible = (messages) => messages.map((message) => ({
  role: message.info.role,
  text: message.parts.map((part) => part.text ?? "").join("")
}))

test("PI refresh replays native history instead of keeping an incomplete cache", async () => {
  const acp = new PiHistoryAcp()
  const service = new AcpService(acp, { reloadOnHistoryRefresh: true, preferListedTitles: true })

  assert.deepEqual(visible(await service.messages("pi-session", true)), [{ role: "user", text: "First prompt" }])
  assert.deepEqual(visible(await service.messages("pi-session", true)), [
    { role: "user", text: "First prompt" },
    { role: "assistant", text: "Persisted PI answer" }
  ])
  assert.equal(acp.loadCount, 2)
})

test("PI list and rename use PI's native display name", async () => {
  const acp = new PiHistoryAcp()
  const service = new AcpService(acp, {
    reloadOnHistoryRefresh: true,
    preferListedTitles: true,
    nativeRenameCommand: "name"
  })

  assert.equal((await service.listSessions())[0].title, "PI native title")
  const renamed = await service.renameSession("pi-session", "Renamed from Harness Remote")
  assert.equal(acp.prompts.at(-1), "/name Renamed from Harness Remote")
  assert.equal(renamed.title, "Renamed from Harness Remote")
  assert.equal((await service.listSessions())[0].title, "Renamed from Harness Remote")
})
