import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpPromptEchoFilter } from "../src/acp-prompt-echo-filter.js"
import { AcpService } from "../src/acp-service.js"

class DuplicatePromptEchoAcp extends EventEmitter {
  promptCapabilities = {}

  async start() {}

  async listSessions() {
    return [{
      sessionId: "session-1",
      cwd: process.cwd(),
      title: "Task echo regression",
      updatedAt: "2026-08-20T08:00:00.000Z"
    }]
  }

  async request(method, params) {
    if (method === "session/new") {
      return { sessionId: "session-1", configOptions: [] }
    }
    if (method === "session/prompt") {
      const emitEcho = (messageId) => this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            messageId,
            content: { type: "text", text: "Continue the task" }
          }
        }
      })
      emitEcho("echo-1")
      emitEcho("echo-2")
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "answer-1",
            content: { type: "text", text: "Done" }
          }
        }
      })
      return { stopReason: "end_turn" }
    }
    throw new Error(`Unexpected request: ${method}`)
  }

  notify() {}
}

function textOf(message) {
  return (message.parts ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("")
}

function filteredService(acp) {
  return new AcpService(new AcpPromptEchoFilter(acp, { tailMs: 10 }))
}

test("a repeated ACP echo of one live prompt is still rendered only once", async () => {
  const service = filteredService(new DuplicatePromptEchoAcp())
  const session = await service.createSession({ directory: process.cwd(), title: "Task echo regression" })

  await service.promptAndWait(session.id, "Continue the task")
  const messages = await service.messages(session.id)
  const userPrompts = messages.filter((message) => message.info.role === "user").map(textOf)

  assert.deepEqual(userPrompts, ["Continue the task"])
  assert.equal(messages.filter((message) => message.info.role === "assistant").map(textOf).at(-1), "Done")
})

test("two separate turns with identical user text remain two real prompts", async () => {
  let promptCount = 0
  class SeparateTurnsAcp extends DuplicatePromptEchoAcp {
    async request(method, params) {
      if (method !== "session/prompt") return super.request(method, params)
      promptCount += 1
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: `echo-turn-${promptCount}`,
            content: { type: "text", text: "Same text" }
          }
        }
      })
      return { stopReason: "end_turn" }
    }
  }

  const service = filteredService(new SeparateTurnsAcp())
  const session = await service.createSession({ directory: process.cwd(), title: "Repeated prompt regression" })
  await service.promptAndWait(session.id, "Same text")
  await service.promptAndWait(session.id, "Same text")

  const userPrompts = (await service.messages(session.id))
    .filter((message) => message.info.role === "user")
    .map(textOf)
  assert.deepEqual(userPrompts, ["Same text", "Same text"])
})

test("a closed session releases its prompt echo so a replayed history message passes through", async () => {
  const acp = new DuplicatePromptEchoAcp()
  const filter = new AcpPromptEchoFilter(acp, { tailMs: 10 })
  const service = new AcpService(filter)
  const session = await service.createSession({ directory: process.cwd(), title: "Project eviction regression" })
  const forwarded = []
  const lifecycle = []
  filter.on("notification", (event) => forwarded.push(event))
  filter.on("sessions-closed", (sessionIDs) => lifecycle.push(sessionIDs))

  await service.promptAndWait(session.id, "Continue the task")
  assert.equal(forwarded.filter((notification) =>
    notification.params?.update?.sessionUpdate === "user_message_chunk"
  ).length, 0, "the active prompt echo is filtered")

  acp.emit("sessions-closed", ["session-1"])
  assert.deepEqual(lifecycle, [["session-1"]], "the lifecycle event is forwarded")

  const historicalReplay = {
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "history-replay-1",
        content: { type: "text", text: "Continue the task" }
      }
    }
  }
  acp.emit("notification", historicalReplay)

  assert.ok(forwarded.includes(historicalReplay),
    "the replayed historical message is no longer mistaken for an echo")
})
