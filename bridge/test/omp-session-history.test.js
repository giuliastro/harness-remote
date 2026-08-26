import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createOmpHistoryLoader } from "../src/omp-session-history.js"

function replayMessage(id, role, text, created = 1) {
  return {
    info: { id, role, sessionID: "replay", time: { created } },
    parts: [{ id: `${id}:text:0`, messageID: id, type: "text", text }]
  }
}

test("ambiguous OMP history uses native ACP replay instead of guessing a terminal sibling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-history-"))
  const nested = path.join(root, "workspace")
  await mkdir(nested)
  const sessionID = "session-1"
  const records = [
    { type: "message", id: "user-1", parentId: null, timestamp: "2026-07-26T10:00:00.000Z", message: { role: "user", content: "Question" } },
    { type: "message", id: "abandoned-assistant", parentId: "user-1", timestamp: "2026-07-26T10:00:00.500Z", message: { role: "assistant", content: [{ type: "text", text: "Abandoned answer" }] } },
    { type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-07-26T10:00:01.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Answer" }] } },
    { type: "message", id: "tool-1", parentId: "assistant-1", message: { role: "toolResult", content: [{ type: "text", text: "hidden tool output" }] } }
  ]
  await writeFile(path.join(nested, `2026-07-26_${sessionID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const loadHistory = createOmpHistoryLoader(root)
    assert.deepEqual(await loadHistory(sessionID), [], "two terminal siblings must not be resolved by append order")
    assert.equal(loadHistory.needsReplay(sessionID), true)
    assert.equal(await loadHistory.page(sessionID, { limit: 10 }), undefined, "paged history must fall back to native ACP branch replay")

    const selected = await loadHistory.reconcileReplay(sessionID, [
      replayMessage("acp-user", "user", "Question", 1),
      replayMessage("acp-assistant", "assistant", "Answer", 2)
    ])
    assert.equal(
      selected,
      "tool-1",
      "the selected native branch may terminate in a non-conversational record after the assistant reply"
    )
    assert.equal(loadHistory.needsReplay(sessionID), false)

    const page = await loadHistory.page(sessionID, { limit: 10 })
    assert.deepEqual(page.messages.map((message) => [message.info.id, message.info.role]), [
      ["user-1", "user"],
      ["assistant-1", "assistant"]
    ])
    assert.deepEqual(page.messages[1].parts.map((part) => [part.type, part.text]), [
      ["reasoning", "hidden"],
      ["text", "Answer"]
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an optional OMP undo leaf is only a hint when the journal is ambiguous", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-stale-leaf-"))
  const sessionID = "session-stale-leaf"
  const records = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-07-26T10:00:00.000Z", message: { role: "user", content: "Question" } },
    { type: "message", id: "old-a", parentId: "u1", timestamp: "2026-07-26T10:00:01.000Z", message: { role: "assistant", content: "Old branch" } },
    { type: "message", id: "new-a", parentId: "u1", timestamp: "2026-07-26T10:00:02.000Z", message: { role: "assistant", content: "Selected branch" } }
  ]
  await writeFile(path.join(root, `2026-07-26_${sessionID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const loadHistory = createOmpHistoryLoader(root)
    assert.deepEqual(
      await loadHistory(sessionID, { activeSessionLeaf: "old-a" }),
      [],
      "a stale extension leaf must not override native branch replay"
    )
    const selected = await loadHistory.reconcileReplay(sessionID, [
      replayMessage("u", "user", "Question"),
      replayMessage("a", "assistant", "Selected branch", 2)
    ])
    assert.equal(selected, "new-a")
    assert.deepEqual((await loadHistory.page(sessionID, { limit: 10 })).messages.map((message) => message.parts[0].text), ["Question", "Selected branch"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("uses a journal's only terminal leaf when the optional OMP extension is absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-linear-history-"))
  const sessionID = "session-linear"
  const records = [
    { type: "message", id: "user-1", parentId: null, timestamp: "2026-07-26T10:00:00.000Z", message: { role: "user", content: "Question" } },
    { type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-07-26T10:00:01.000Z", message: { role: "assistant", content: "Answer" } }
  ]
  await writeFile(path.join(root, `2026-07-26_${sessionID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const loadHistory = createOmpHistoryLoader(root)
    assert.deepEqual((await loadHistory(sessionID)).map((message) => message.parts[0].text), ["Question", "Answer"])
    assert.equal(loadHistory.needsReplay(sessionID), false, "a linear journal stays read-only and needs no ACP load")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reports the last model selected on the confirmed OMP journal branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-model-history-"))
  const sessionID = "session-model"
  const records = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-07-26T10:00:00.000Z", message: { role: "user", content: "Question" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-26T10:00:01.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", content: "Answer" } },
    { type: "model_change", id: "model-2", parentId: "a1", timestamp: "2026-07-26T10:00:02.000Z", model: "openai-codex/gpt-5.6" }
  ]
  await writeFile(path.join(root, `2026-07-26_${sessionID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const loadHistory = createOmpHistoryLoader(root)
    const page = await loadHistory.page(sessionID, { limit: 10 })
    assert.deepEqual(page.model, { providerID: "openai-codex", modelID: "gpt-5.6" })
    assert.deepEqual(page.messages.map((message) => message.parts[0].text), ["Question", "Answer"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("failed sibling attempts remain visible while abandoned successful siblings stay excluded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-errors-"))
  const sessionID = "session-errors"
  const records = [
    { type: "message", id: "u0", parentId: null, timestamp: "2026-07-26T10:00:00.000Z", message: { role: "user", content: "u0" } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "2026-07-26T10:00:01.000Z", message: { role: "assistant", content: "a0" } },
    { type: "message", id: "u1", parentId: "a0", timestamp: "2026-07-26T10:00:02.000Z", message: { role: "user", content: "retry me" } },
    { type: "message", id: "failed", parentId: "u1", timestamp: "2026-07-26T10:00:03.000Z", message: { role: "assistant", errorMessage: "Interrupted by user", content: [] } },
    { type: "message", id: "abandoned-success", parentId: "u1", timestamp: "2026-07-26T10:00:04.000Z", message: { role: "assistant", content: "wrong answer" } },
    { type: "message", id: "selected-success", parentId: "u1", timestamp: "2026-07-26T10:00:05.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", content: "right answer" } }
  ]
  await writeFile(path.join(root, `2026-07-26_${sessionID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const loadHistory = createOmpHistoryLoader(root)
    assert.equal(await loadHistory.page(sessionID, { limit: 10 }), undefined)
    assert.equal(await loadHistory.reconcileReplay(sessionID, [
      replayMessage("r0", "user", "u0"),
      replayMessage("r1", "assistant", "a0", 2),
      replayMessage("r2", "user", "retry me", 3),
      replayMessage("r3", "assistant", "right answer", 4)
    ]), "selected-success")

    const page = await loadHistory.page(sessionID, { limit: 10 })
    assert.deepEqual(page.messages.map((message) => message.info.id), ["u0", "a0", "u1", "failed", "selected-success"])
    assert.equal(page.messages.find((message) => message.info.id === "failed")?.info.error?.message, "Interrupted by user")
    assert.ok(!page.messages.some((message) => message.info.id === "abandoned-success"))
    assert.deepEqual(page.model, { providerID: "openai-codex", modelID: "gpt-5.6-terra" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("confirmed branch paging is stable and carries its branch in the cursor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-page-"))
  const sessionID = "session-page"
  const records = [
    { type: "message", id: "u0", parentId: null, timestamp: "2026-07-26T10:00:00.000Z", message: { role: "user", content: "u0" } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "2026-07-26T10:00:01.000Z", message: { role: "assistant", content: "a0" } },
    { type: "message", id: "u1", parentId: "a0", timestamp: "2026-07-26T10:00:02.000Z", message: { role: "user", content: "u1" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-26T10:00:03.000Z", message: { role: "assistant", content: "a1" } },
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-07-26T10:00:04.000Z", message: { role: "user", content: "u2" } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-07-26T10:00:05.000Z", message: { role: "assistant", content: "a2" } },
    { type: "message", id: "abandoned-u", parentId: "a0", timestamp: "2026-07-26T10:00:06.000Z", message: { role: "user", content: "abandoned-u" } },
    { type: "message", id: "abandoned-a", parentId: "abandoned-u", timestamp: "2026-07-26T10:00:07.000Z", message: { role: "assistant", content: "abandoned-a" } }
  ]
  await writeFile(path.join(root, `2026-07-26_${sessionID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const loadHistory = createOmpHistoryLoader(root)
    assert.equal(await loadHistory.page(sessionID, { limit: 2 }), undefined)
    await loadHistory.reconcileReplay(sessionID, [
      replayMessage("x0", "user", "u0"), replayMessage("x1", "assistant", "a0", 2),
      replayMessage("x2", "user", "u1", 3), replayMessage("x3", "assistant", "a1", 4),
      replayMessage("x4", "user", "u2", 5), replayMessage("x5", "assistant", "a2", 6)
    ])

    const first = await loadHistory.page(sessionID, { limit: 2 })
    assert.deepEqual(first.messages.map((message) => message.parts[0].text), ["u2", "a2"])
    assert.equal(first.hasMore, true)
    assert.ok(first.before)

    const second = await loadHistory.page(sessionID, { before: first.before, limit: 2 })
    assert.deepEqual(second.messages.map((message) => message.parts[0].text), ["u1", "a1"])
    assert.equal(second.hasMore, true)

    const third = await loadHistory.page(sessionID, { before: second.before, limit: 2 })
    assert.deepEqual(third.messages.map((message) => message.parts[0].text), ["u0", "a0"])
    assert.equal(third.hasMore, false)
    assert.equal(third.before, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("replays a persisted image so an attachment survives reopening the session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-image-"))
  const sessionID = "session-image"
  const data = "UklGRpwAAABXRUJQVlA4IJAAAAAQDQCd"
  const records = [
    {
      type: "message", id: "user-1", parentId: null, timestamp: "2026-08-08T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "what colour is this?" }, { type: "image", data, mimeType: "image/webp" }] }
    },
    {
      type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-08-08T10:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Magenta" }] }
    }
  ]
  await writeFile(path.join(root, `2026-08-08_${sessionID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const loadHistory = createOmpHistoryLoader(root)
    const messages = await loadHistory(sessionID)
    const user = messages.find((message) => message.info.role === "user")
    assert.deepEqual(user.parts.map((part) => part.type), ["text", "file"])
    const file = user.parts[1]
    assert.equal(file.mime, "image/webp")
    assert.equal(file.url, `data:image/webp;base64,${data}`)
    assert.equal(file.messageID, "user-1")
    assert.equal((await loadHistory(sessionID)).length, 2, "replay must stay stable across calls")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("ignores an image record carrying no payload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-image-empty-"))
  const sessionID = "session-empty-image"
  const records = [{
    type: "message", id: "user-1", parentId: null, timestamp: "2026-08-08T10:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png" }] }
  }]
  await writeFile(path.join(root, `2026-08-08_${sessionID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const loadHistory = createOmpHistoryLoader(root)
    const messages = await loadHistory(sessionID)
    assert.deepEqual(messages[0].parts.map((part) => part.type), ["text"], "an empty image must not become a broken thumbnail")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
