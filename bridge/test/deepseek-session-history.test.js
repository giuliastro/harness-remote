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

test("merging a DeepSeek tool turn never writes the reply into the loader's cached messages", { skip: !zstdAvailable }, async () => {
  const { mergeFragmentedPiSnapshot } = await import("../src/acp-service.js")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-merge-"))
  try {
    const directory = path.join(root, "project", sessionID)
    fs.mkdirSync(directory, { recursive: true })
    // A DeepSeek tool turn: reasoning and the tool call in one UUID message, the reply in the next.
    const toolMessage = "0e8a9276-e8f1-4b68-aaf7-07c70a96960b"
    const replyMessage = "7082d780-ab44-4971-af32-933a5e0e9cd5"
    fs.writeFileSync(path.join(directory, "session.v4.jsonl.zstd"), Buffer.concat([
      frame({ type: "session", version: 4, id: sessionID, cwd: "/work" }),
      frame({ type: "user/message", seq: 1, time: 10, data: { id: "438e1624-3241-4eb1-9489-39a62d40fdb4", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Di nuovo" }] } }),
      frame({ type: "assistant/message", seq: 2, time: 20, data: { message: { id: toolMessage, role: "assistant", content: [
        { type: "reasoning", text: "again" },
        { type: "tool-call", id: "call-1", name: "pwsh", arguments: "{}" }
      ] } } }),
      frame({ type: "tool/result", seq: 3, time: 30, data: { message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] } } }),
      frame({ type: "assistant/message", seq: 4, time: 40, data: { message: { id: replyMessage, role: "assistant", content: [{ type: "text", text: "Ciao di nuovo!" }] } } })
    ]))

    const loader = createDeepseekHistoryLoader(root)
    // The service merges the full history on load (the same cached objects each time) ...
    mergeFragmentedPiSnapshot(await loader(sessionID))
    mergeFragmentedPiSnapshot(await loader(sessionID))
    // ... and the app then reads its page from that same cache.
    const page = await loader.page(sessionID, { limit: 50 })
    const replies = page.messages.flatMap((message) => message.parts.filter((part) => part.type === "text" && message.info.role === "assistant").map((part) => part.text))
    assert.deepEqual(replies, ["Ciao di nuovo!"], "the page served to the app must carry the reply once")
    assert.deepEqual(page.messages.find((message) => message.info.id === toolMessage).parts.map((part) => part.type), ["reasoning", "tool"])

    const merged = mergeFragmentedPiSnapshot(await loader(sessionID))
    assert.deepEqual(merged.map((message) => message.info.id), ["438e1624-3241-4eb1-9489-39a62d40fdb4", toolMessage])
    assert.deepEqual(merged[1].parts.map((part) => part.type), ["reasoning", "tool", "text"], "the merged view still joins the reply to its turn")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
