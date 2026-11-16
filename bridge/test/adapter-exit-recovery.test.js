import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

const SESSION = { sessionId: "claude-session", cwd: process.cwd(), title: "Long task" }

const update = (sessionUpdate, extra) => ({
  method: "session/update",
  params: { sessionId: SESSION.sessionId, update: { sessionUpdate, ...extra } }
})

/**
 * Behaves like claude-agent-acp in one process: it replays what it stored on session/load, refuses
 * a prompt for a Session it never opened, and is not restarted by a request once it has exited.
 */
class ClaudeLikeAcp extends EventEmitter {
  sessionCapabilities = {}
  promptCapabilities = {}
  running = false
  open = new Set()
  journal = [
    { role: "user", id: "u1", text: "first" },
    { role: "assistant", id: "msg_1", text: "FINISHED" }
  ]
  loads = 0
  replies = 0

  async start() { this.running = true }
  async listSessions() { return [SESSION] }
  notify() {}

  exit() {
    this.running = false
    this.open.clear()
    this.emit("exit", new Error("ACP adapter exited (1)"))
  }

  async request(method, params) {
    if (!this.running) throw new Error("ACP adapter is not running")
    if (method === "session/load") {
      this.loads += 1
      for (const entry of this.journal) {
        const kind = entry.role === "user" ? "user_message_chunk" : "agent_message_chunk"
        this.emit("notification", update(kind, { messageId: entry.id, content: { type: "text", text: entry.text } }))
      }
      this.open.add(params.sessionId)
      return {}
    }
    if (method === "session/prompt") {
      if (!this.open.has(params.sessionId)) throw new Error("Internal error: Session not found")
      const text = params.prompt.map((part) => part.text).join("")
      const id = `msg_reply_${++this.replies}`
      this.journal.push({ role: "user", id: `u_${id}`, text }, { role: "assistant", id, text: `re: ${text}` })
      this.emit("notification", update("agent_message_chunk", { messageId: id, content: { type: "text", text: `re: ${text}` } }))
      return { stopReason: "end_turn" }
    }
    return {}
  }
}

const transcript = (messages) => messages.map((message) => `${message.info.role}:${message.parts.map((part) => part.text).join("|")}`)

test("a prompt after the adapter exited reopens the Session before it is sent", async () => {
  const acp = new ClaudeLikeAcp()
  await acp.start()
  const service = new AcpService(acp, { recoverMissingSessionOnPrompt: true, replayAuthoritative: true })
  await service.messages(SESSION.sessionId)

  acp.exit()
  await service.promptAndWait(SESSION.sessionId, "next")

  assert.equal(acp.loads, 2)
  assert.deepEqual(transcript(await service.messages(SESSION.sessionId)), [
    "user:first", "assistant:FINISHED", "user:next", "assistant:re: next"
  ])
})

test("a Session the adapter lost keeps the prompt and gets its reply as a message of its own", async () => {
  const acp = new ClaudeLikeAcp()
  await acp.start()
  const service = new AcpService(acp, { recoverMissingSessionOnPrompt: true, replayAuthoritative: true })
  await service.messages(SESSION.sessionId)

  // The adapter forgot the Session without exiting, so only the prompt's refusal reveals it.
  acp.open.clear()
  await service.promptAndWait(SESSION.sessionId, "next")

  assert.equal(acp.loads, 2)
  assert.deepEqual(transcript(await service.messages(SESSION.sessionId)), [
    "user:first", "assistant:FINISHED", "user:next", "assistant:re: next"
  ])
})

test("an adapter that dies mid-turn leaves the turn failed, not quietly finished", async () => {
  const acp = new ClaudeLikeAcp()
  await acp.start()
  // The turn hangs until the adapter exits; its journal holds the prompt and nothing after it.
  let rejectPrompt
  const request = acp.request.bind(acp)
  acp.request = async (method, params) => {
    if (method !== "session/prompt") return request(method, params)
    if (!acp.open.has(params.sessionId)) throw new Error("Internal error: Session not found")
    acp.journal.push({ role: "user", id: "u_hang", text: "go" })
    return new Promise((resolve, reject) => { rejectPrompt = reject })
  }
  const service = new AcpService(acp, { recoverMissingSessionOnPrompt: true, replayAuthoritative: true })
  await service.messages(SESSION.sessionId)
  await service.prompt(SESSION.sessionId, "go")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(service.status(SESSION.sessionId).type, "busy")

  rejectPrompt(new Error("ACP adapter exited (1)"))
  acp.exit()
  await acp.start()
  await new Promise((resolve) => setTimeout(resolve, 50))

  // Reading the Session reloads it from the adapter's replay, which has no record of the failure.
  const messages = await service.messages(SESSION.sessionId)
  assert.equal(service.status(SESSION.sessionId).type, "idle")
  assert.deepEqual(transcript(messages).slice(0, 3), ["user:first", "assistant:FINISHED", "user:go"])
  const failed = messages.at(-1)
  assert.equal(failed.info.role, "assistant")
  assert.match(failed.info.error?.message ?? "", /stopped unexpectedly during this turn \(exit 1\)/)
})
