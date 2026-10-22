import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { harnessProfile } from "../src/harness-profiles.js"

const sessionID = "claude-reloaded"

// The live stream records a whole Claude turn as one bridge-owned message; session/load replays the
// same turn split per Anthropic API message, under the adapter's own `msg_…` ids.
const liveTurn = [
  { info: { id: "13e2d233-5be0-4be3-8b1d-8f91de6f1418", role: "user", sessionID }, parts: [{ id: "u:text", type: "text", text: "Why no QR?" }] },
  {
    info: { id: "20472a25-d979-430f-894b-3c9554437d2f", role: "assistant", sessionID },
    parts: [
      { id: "toolu_grep", type: "tool", tool: "grep", callID: "toolu_grep", state: { status: "completed", input: {} } },
      { id: "a:text:1", type: "text", text: "Let me check." },
      { id: "toolu_shell", type: "tool", tool: "Terminal", callID: "toolu_shell", state: { status: "completed", input: {} } },
      { id: "a:text:3", type: "text", text: "qrcode-terminal is not installed." }
    ]
  }
]

class ClaudeReplay extends EventEmitter {
  async listSessions() { return [{ sessionId: sessionID, cwd: "/repo" }] }
  async request(method) {
    assert.equal(method, "session/load")
    const update = (value) => this.emit("notification", { method: "session/update", params: { sessionId: sessionID, update: value } })
    update({ sessionUpdate: "user_message_chunk", messageId: "user-1", content: { type: "text", text: "Why no QR?" } })
    update({ sessionUpdate: "tool_call", toolCallId: "toolu_grep", title: "grep", status: "completed" })
    update({ sessionUpdate: "agent_message_chunk", messageId: "msg_a", content: { type: "text", text: "Let me check." } })
    update({ sessionUpdate: "tool_call", toolCallId: "toolu_shell", title: "Terminal", status: "completed" })
    update({ sessionUpdate: "agent_message_chunk", messageId: "msg_b", content: { type: "text", text: "qrcode-terminal is not installed." } })
    return { configOptions: [] }
  }
}

function transcript(messages) {
  return messages.flatMap((message) => message.parts.map((part) => `${message.info.role}:${part.type === "tool" ? part.callID : part.text}`))
}

test("Claude native replay replaces a live turn instead of appending its split copy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hr-claude-replay-"))
  const snapshotPath = path.join(directory, `${Buffer.from(sessionID).toString("base64url")}.json`)
  await writeFile(snapshotPath, JSON.stringify({ version: 1, messages: liveTurn }))
  const service = new AcpService(new ClaudeReplay(), {
    snapshotDirectory: directory,
    replayAuthoritative: harnessProfile("claude").replayAuthoritative
  })
  try {
    const expected = [
      "user:Why no QR?",
      "assistant:toolu_grep",
      "assistant:Let me check.",
      "assistant:toolu_shell",
      "assistant:qrcode-terminal is not installed."
    ]
    assert.deepEqual(transcript(await service.messages(sessionID)), expected)
    while (service.diagnostics().snapshotWrites > 0) await new Promise((resolve) => setTimeout(resolve, 10))
    const saved = JSON.parse(await readFile(snapshotPath, "utf8"))
    assert.deepEqual(transcript(saved.messages), expected)
  } finally {
    while (service.diagnostics().snapshotWrites > 0) await new Promise((resolve) => setTimeout(resolve, 10))
    await rm(directory, { recursive: true, force: true })
  }
})
