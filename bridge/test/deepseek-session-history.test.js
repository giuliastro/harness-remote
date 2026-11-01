import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import * as zlib from "node:zlib"
import { createDeepseekHistoryLoader, decodeDeepseekJournal } from "../src/deepseek-session-history.js"

const zstdAvailable = typeof zlib.zstdCompressSync === "function"
const sessionID = "session-test-history"

function frame(record) {
  return zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`, "utf8"))
}

test("decodes one DSH journal written as one zstd frame per JSON line", { skip: !zstdAvailable }, () => {
  const journal = Buffer.concat([
    frame({ type: "session", version: 4, id: sessionID, cwd: "/work" }),
    frame({ type: "user/message", seq: 1, time: 10, data: { id: "user-1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hello" }] } })
  ])
  const text = decodeDeepseekJournal(journal)
  assert.match(text, /"type":"session"/)
  assert.match(text, /"id":"user-1"/)
  assert.equal(decodeDeepseekJournal(Buffer.from("not zstd")), undefined)
})

test("DSH journal history keeps visible turns and joins tool results into Activity", { skip: !zstdAvailable }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-history-"))
  try {
    const directory = path.join(root, "project", sessionID)
    fs.mkdirSync(directory, { recursive: true })
    const journal = Buffer.concat([
      frame({ type: "session", version: 4, id: sessionID, cwd: "/work" }),
      frame({ type: "user/message", seq: 1, time: 10, data: { id: "injected", role: "user", source: { kind: "time-context" }, content: [{ type: "text", text: "not a turn" }] } }),
      frame({ type: "user/message", seq: 2, time: 20, data: { id: "user-1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hello" }] } }),
      frame({
        type: "assistant/message",
        seq: 3,
        time: 30,
        data: {
          message: {
            id: "assistant-1",
            role: "assistant",
            source: { provider: "deepseek-official", model: "deepseek-flash" },
            content: [
              { type: "reasoning", text: "think" },
              { type: "text", text: "working" },
              { type: "tool-call", id: "call-1", name: "pwsh", arguments: "{\"command\":\"dir\"}" }
            ]
          }
        }
      }),
      frame({ type: "tool/result", seq: 4, time: 40, data: { message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "file.txt" }], isError: false } } }),
      frame({
        type: "assistant/message",
        seq: 5,
        time: 50,
        data: { message: { id: "assistant-2", role: "assistant", source: { provider: "deepseek-official", model: "deepseek-flash" }, content: [{ type: "text", text: "done" }] } }
      })
    ])
    fs.writeFileSync(path.join(directory, "session.v4.jsonl.zstd"), journal)

    const loader = createDeepseekHistoryLoader(root)
    const messages = await loader(sessionID)
    assert.deepEqual(messages.map((message) => [message.info.id, message.info.role]), [
      ["user-1", "user"],
      ["assistant-1", "assistant"],
      ["assistant-2", "assistant"]
    ])
    const tool = messages[1].parts.find((part) => part.type === "tool")
    assert.equal(tool.callID, "call-1")
    assert.equal(tool.tool, "pwsh")
    assert.equal(tool.state.status, "completed")
    assert.equal(tool.state.output, "file.txt")

    const page = await loader.page(sessionID, { limit: 2 })
    assert.deepEqual(page.messages.map((message) => message.info.id), ["assistant-1", "assistant-2"])
    assert.equal(page.hasMore, true)
    assert.equal(page.before, "assistant-1")
    assert.deepEqual(page.model, { providerID: "deepseek-official", modelID: "deepseek-flash" })

    const older = await loader.page(sessionID, { limit: 2, before: page.before })
    assert.deepEqual(older.messages.map((message) => message.info.id), ["user-1"])
    assert.equal(older.hasMore, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
