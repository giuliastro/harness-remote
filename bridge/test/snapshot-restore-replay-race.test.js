import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fsPromises from "node:fs/promises"
import { mkdtemp, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

const SESSION = { sessionId: "claude-session", cwd: process.cwd(), title: "Layout" }
const SNAPSHOT_NAME = `${Buffer.from(SESSION.sessionId).toString("base64url")}.json`

const update = (sessionUpdate, extra) => ({
  method: "session/update",
  params: { sessionId: SESSION.sessionId, update: { sessionUpdate, ...extra } }
})

// Claude's replay: journal ids for users, API ids for text, and no id at all for a turn whose first
// output is a tool call, which the bridge therefore names with a UUID.
const REPLAY = [
  update("user_message_chunk", { messageId: "u1", content: { type: "text", text: "rifai il layout" } }),
  update("tool_call", { toolCallId: "t1", title: "ls", status: "completed" }),
  update("agent_message_chunk", { messageId: "msg_a1", content: { type: "text", text: "fatto" } }),
  update("user_message_chunk", { messageId: "u2", content: { type: "text", text: "vai con la 2" } }),
  update("tool_call", { toolCallId: "t2", title: "git apply", status: "completed" }),
  update("agent_message_chunk", { messageId: "msg_a2", content: { type: "text", text: "applicata" } }),
  update("user_message_chunk", { messageId: "u3", content: { type: "text", text: "sto provando" } }),
  update("agent_message_chunk", { messageId: "msg_a3", content: { type: "text", text: "Ok, fai pure" } })
]

const message = (id, role, text, created, parts = [{ type: "text", text }]) => ({
  info: { id, role, sessionID: SESSION.sessionId, time: { created } },
  parts: parts.map((part, index) => ({ id: `${id}:${index}`, messageID: id, ...part }))
})

// What the previous process saved: its own ids for the turns it ran live.
const SAVED = [
  message("u1", "user", "rifai il layout", 1),
  message("live-tools-1", "assistant", "", 2, [{ type: "tool", callID: "t1", tool: "ls", state: { status: "completed" } }]),
  message("msg_a1", "assistant", "fatto", 3),
  message("u2", "user", "vai con la 2", 4),
  message("live-tools-2", "assistant", "", 5, [{ type: "tool", callID: "t2", tool: "git apply", state: { status: "completed" } }]),
  message("msg_a2", "assistant", "applicata", 6),
  message("live-prompt", "user", "sto provando", 7),
  message("msg_a3", "assistant", "Ok, fai pure", 8)
]

class ReplayingAcp extends EventEmitter {
  sessionCapabilities = {}
  promptCapabilities = {}
  constructor(onReplayStarted) {
    super()
    this.onReplayStarted = onReplayStarted
  }
  async start() {}
  async listSessions() { return [SESSION] }
  notify() {}
  async request(method) {
    if (method !== "session/load") return {}
    for (const [index, notification] of REPLAY.entries()) {
      this.emit("notification", notification)
      if (index === 0) await this.onReplayStarted()
    }
    return {}
  }
}

test("a snapshot read that finishes during a replay is not written over the replayed transcript", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "restore-race-"))
  await writeFile(path.join(directory, SNAPSHOT_NAME), JSON.stringify({ version: 1, messages: SAVED }))

  // At startup the Session list reads every snapshot at once, so one long Session's file can still be
  // in flight when that Session is opened. Its read here takes long enough for a load that does not
  // wait for it to have started replaying.
  let readStarted
  const reading = new Promise((resolve) => { readStarted = resolve })
  const readFile = fsPromises.readFile
  fsPromises.readFile = async (file, ...rest) => {
    const content = await readFile(file, ...rest)
    if (String(file).endsWith(SNAPSHOT_NAME)) {
      readStarted()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return content
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsPromises.readFile = readFile
    syncBuiltinESMExports()
  })

  // The replay is still going when that read finishes.
  const acp = new ReplayingAcp(() => listing)
  const service = new AcpService(acp, { snapshotDirectory: directory, replayAuthoritative: true })
  const listing = service.listSessions()
  await reading
  const messages = await service.messages(SESSION.sessionId)

  assert.deepEqual(
    messages.map((item) => `${item.info.role}:${item.parts.map((part) => part.text ?? part.callID).join("+")}`),
    [
      "user:rifai il layout",
      "assistant:t1",
      "assistant:fatto",
      "user:vai con la 2",
      "assistant:t2",
      "assistant:applicata",
      "user:sto provando",
      "assistant:Ok, fai pure"
    ]
  )
})
