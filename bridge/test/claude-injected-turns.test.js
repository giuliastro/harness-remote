import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { harnessProfile } from "../src/harness-profiles.js"

const sessionID = "claude-injected"

// Taken from a real Claude Code journal: a subagent's report and a message from another session are
// stored as user-role entries (isMeta, origin.kind "peer"), and when the Session resumed after its
// process ended mid-tool-call, Claude Code added a synthetic "No response requested." reply.
// session/load replays all of them as plain message chunks, without that metadata.
const handback = "Another Claude session sent a message:\n<agent-message from=\"a795bd6e785f73951\">\n[Subagent hand-back] The report follows:\n  ## 1. Duplicate bug history\n</agent-message>"
const crossSession = "Another Claude session sent a message:\n<cross-session-message from=\"local_75955445\" from-name=\"Fix MiMo detected but unlaunchable on Windows\">\nPR #682's test will fail once #683 is merged.\n</cross-session-message>"
const compaction = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request"

class ClaudeReplay extends EventEmitter {
  async listSessions() { return [{ sessionId: sessionID, cwd: "/repo" }] }
  async request(method) {
    assert.equal(method, "session/load")
    const update = (value) => this.emit("notification", { method: "session/update", params: { sessionId: sessionID, update: value } })
    const user = (messageId, text) => update({ sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text } })
    const agent = (messageId, text) => update({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } })
    user("u1", "test PR 682")
    user("u2", crossSession)
    agent("msg_1", "Noted, fixing the test.")
    user("u3", compaction)
    agent("msg_2", "Continuing.")
    user("u4", "fix the duplicates")
    user("u5", handback)
    update({ sessionUpdate: "tool_call", toolCallId: "toolu_bash", title: "Bash", status: "pending" })
    agent("msg_3", "No response requested.")
    agent("msg_4", "The test app is open.")
    return { configOptions: [] }
  }
}

function transcript(messages) {
  return messages.flatMap((message) => message.parts.map((part) => `${message.info.role}:${part.type === "tool" ? part.callID : part.text}`))
}

const expected = [
  "user:test PR 682",
  "assistant:Noted, fixing the test.",
  "assistant:Continuing.",
  "user:fix the duplicates",
  "assistant:toolu_bash",
  "assistant:The test app is open."
]

async function settle(service) {
  while (service.diagnostics().snapshotWrites > 0) await new Promise((resolve) => setTimeout(resolve, 10))
}

test("a Claude replay never shows harness-written messages as turns of the person", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hr-claude-injected-"))
  const service = new AcpService(new ClaudeReplay(), {
    snapshotDirectory: directory,
    replayAuthoritative: harnessProfile("claude").replayAuthoritative
  })
  try {
    assert.deepEqual(transcript(await service.messages(sessionID)), expected)
  } finally {
    await settle(service)
    await rm(directory, { recursive: true, force: true })
  }
})

test("a snapshot saved before the filter existed is cleaned when it is restored", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hr-claude-injected-snapshot-"))
  const snapshotPath = path.join(directory, `${Buffer.from(sessionID).toString("base64url")}.json`)
  const text = (id, role, value) => ({ info: { id, role, sessionID }, parts: [{ id: `${id}:text`, type: "text", text: value }] })
  await writeFile(snapshotPath, JSON.stringify({
    version: 1,
    messages: [
      text("u1", "user", "test PR 682"),
      text("u2", "user", crossSession),
      text("a1", "assistant", "Noted, fixing the test."),
      text("u3", "user", handback),
      text("a2", "assistant", "No response requested."),
      text("a3", "assistant", "The test app is open.")
    ]
  }))
  const service = new AcpService(new ClaudeReplay(), {
    snapshotDirectory: directory,
    replayAuthoritative: harnessProfile("claude").replayAuthoritative
  })
  try {
    // The replay is authoritative for Claude; the restored copy must be clean on every path anyway.
    assert.deepEqual(transcript(await service.messages(sessionID)), expected)
    await settle(service)
    const saved = JSON.parse(await readFile(snapshotPath, "utf8"))
    assert.deepEqual(transcript(saved.messages), expected)
  } finally {
    await settle(service)
    await rm(directory, { recursive: true, force: true })
  }
})
