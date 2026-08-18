import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { AcpService } from "../src/acp-service.js"

class LateReplayAcp extends EventEmitter {
  async listSessions() {
    return [{ sessionId: "pi-session", cwd: process.cwd(), title: "PI history", updatedAt: new Date().toISOString() }]
  }

  async request(method, params) {
    if (method !== "session/load") throw new Error(`Unexpected request: ${method}`)
    const sessionId = params.sessionId
    this.emit("notification", {
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-1",
          content: { type: "text", text: "First prompt" }
        }
      }
    })
    setTimeout(() => {
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "assistant-1",
            content: { type: "text", text: "First answer" }
          }
        }
      })
    }, 20)
    return { configOptions: [] }
  }
}

test("PI replay settle captures assistant chunks emitted after session/load resolves", async () => {
  const service = new AcpService(new LateReplayAcp(), { replaySettleMs: 60 })
  const messages = await service.messages("pi-session", true)
  assert.deepEqual(
    messages.map((message) => ({ role: message.info.role, text: message.parts.map((part) => part.text ?? "").join("") })),
    [
      { role: "user", text: "First prompt" },
      { role: "assistant", text: "First answer" }
    ]
  )
})
