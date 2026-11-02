import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { harnessProfile } from "../src/harness-profiles.js"

// A live turn is cached as one message; session/load replays it split per API message, so its
// tool-only pieces have no text and must not take another reply's id, time or Interrupted flag.
const sessionID = "s1"
const { replayAuthoritative } = harnessProfile("claude")
const T0 = Date.parse("2026-10-30T15:00:00Z")
const T1 = Date.parse("2026-10-30T16:00:00Z")
const user = (id, created, text) => ({ info: { id, role: "user", sessionID, time: { created } }, parts: [{ id: `${id}:t`, type: "text", text }] })
const reply = (id, created, parts, interrupted) => ({ info: { id, role: "assistant", sessionID, time: { created }, ...(interrupted ? { interrupted } : {}) }, parts })
const tool = (callID) => ({ id: callID, type: "tool", callID, tool: "Bash", state: { status: "completed", input: {} } })
const said = (messageId, text) => ({ sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text } })
const thought = (messageId) => ({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: "looking" } })
const called = (toolCallId) => ({ sessionUpdate: "tool_call", toolCallId, title: "make", status: "completed" })
const answered = (messageId, text) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } })

async function reload(snapshot, updates) {
  const directory = await mkdtemp(path.join(tmpdir(), "hr-claude-replay-identity-"))
  await writeFile(path.join(directory, `${Buffer.from(sessionID).toString("base64url")}.json`), JSON.stringify({ version: 1, messages: snapshot }))
  const adapter = new class extends EventEmitter {
    async listSessions() { return [{ sessionId: sessionID, cwd: "/repo" }] }
    async request(method) {
      assert.equal(method, "session/load")
      for (const update of updates) this.emit("notification", { method: "session/update", params: { sessionId: sessionID, update } })
      return { configOptions: [] }
    }
  }()
  const service = new AcpService(adapter, { snapshotDirectory: directory, replayAuthoritative })
  try {
    return await service.messages(sessionID)
  } finally {
    while (service.diagnostics().snapshotWrites > 0) await new Promise((resolve) => setTimeout(resolve, 10))
    await rm(directory, { recursive: true, force: true })
  }
}

test("a reload after a Stop keeps the Stop on the stopped reply, not on an earlier tool-only piece", async () => {
  const messages = await reload(
    [user("u-1", T0, "check the build"), reply("live-1", T0 + 1000, [tool("toolu_a"), { id: "live-1:t", type: "text", text: "Build is green." }]),
      user("u-2", T1, "run it again"), reply("a-2", T1 + 1000, [tool("toolu_b")], true)],
    [said("user-1", "check the build"), thought("msg_1a"), called("toolu_a"), answered("msg_1b", "Build is green."),
      said("user-2", "run it again"), thought("msg_2a"), called("toolu_b")]
  )
  assert.deepEqual(messages.map(({ info }) => [info.id, info.interrupted ?? false, info.time.created]), [
    ["u-1", false, T0],
    ["msg_1a", false, T0 + 999],
    ["live-1", false, T0 + 1000],
    ["u-2", false, T1],
    ["a-2", true, T1 + 1000]
  ])
})

test("a stopped reply replayed split per API message keeps its id, time and Interrupted flag", async () => {
  const messages = await reload(
    [user("u-0", T0, "old prompt"), reply("a-0", T0 + 1000, [tool("toolu_a"), tool("toolu_b")], true)],
    [said("user-0", "old prompt"), thought("msg_a"), called("toolu_a"), thought("msg_b"), called("toolu_b")]
  )
  const first = messages.find((message) => message.parts.some((part) => part.callID === "toolu_a"))
  assert.deepEqual([first?.info.id, first?.info.interrupted, first?.info.time.created], ["a-0", true, T0 + 1000])
})
