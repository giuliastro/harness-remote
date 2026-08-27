import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createOmpHistoryLoader, mergeOmpLiveHistory } from "../src/omp-session-history.js"

function envelope(id, role, text, created = 1) {
  return {
    info: { id, role, sessionID: "session-1", time: { created } },
    parts: [{ id: `${id}:text:0`, messageID: id, type: "text", text }]
  }
}

async function fixture(prefix, sessionID, records) {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  const nested = path.join(root, "workspace")
  await mkdir(nested)
  const file = path.join(nested, `2026-08-26_${sessionID}.jsonl`)
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)
  return { root, file }
}

test("persisted OMP branch follows the last journal entry exactly like SessionEntryIndex.rebuild", async () => {
  const sessionID = "session-branch"
  const records = [
    { type: "session", version: 3, id: sessionID, cwd: "/tmp/project" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-08-26T10:00:00.000Z", message: { role: "user", content: "Question" } },
    { type: "message", id: "old-a", parentId: "u1", timestamp: "2026-08-26T10:00:01.000Z", message: { role: "assistant", content: "Old branch" } },
    { type: "message", id: "new-a", parentId: "u1", timestamp: "2026-08-26T10:00:02.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6", content: "Selected branch" } },
    { type: "session_exit", id: "exit", parentId: "new-a", timestamp: "2026-08-26T10:00:03.000Z" }
  ]
  const { root } = await fixture("harness-remote-omp-last-leaf-", sessionID, records)
  try {
    const history = createOmpHistoryLoader(root)
    const page = await history.page(sessionID, { limit: 10 })
    assert.deepEqual(page.messages.map((message) => message.parts[0].text), ["Question", "Selected branch"])
    assert.deepEqual(page.model, { providerID: "openai-codex", modelID: "gpt-5.6" })
    assert.equal(history.diagnostics().source, "omp-session-jsonl-native-leaf")
    assert.equal("needsReplay" in history, false, "read path must not expose an ACP replay escape hatch")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an optional current OMP leaf can refine the persisted leaf without becoming a prerequisite", async () => {
  const sessionID = "session-live-leaf"
  const records = [
    { type: "session", version: 3, id: sessionID, cwd: "/tmp/project" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-08-26T10:00:00.000Z", message: { role: "user", content: "Question" } },
    { type: "message", id: "old-a", parentId: "u1", timestamp: "2026-08-26T10:00:01.000Z", message: { role: "assistant", content: "Old branch" } },
    { type: "message", id: "new-a", parentId: "u1", timestamp: "2026-08-26T10:00:02.000Z", message: { role: "assistant", content: "Persisted branch" } }
  ]
  const { root } = await fixture("harness-remote-omp-live-leaf-", sessionID, records)
  try {
    const history = createOmpHistoryLoader(root)
    assert.deepEqual((await history(sessionID)).map((message) => message.parts[0].text), ["Question", "Persisted branch"])
    assert.deepEqual(
      (await history(sessionID, { activeSessionLeaf: "old-a" })).map((message) => message.parts[0].text),
      ["Question", "Old branch"]
    )
    assert.deepEqual(
      (await history(sessionID, { activeSessionLeaf: "missing" })).map((message) => message.parts[0].text),
      ["Question", "Persisted branch"],
      "a stale optional hint must fall back to persisted OMP semantics"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("old OMP v1 journals are readable before OMP migrates them", async () => {
  const sessionID = "session-v1"
  const records = [
    { type: "session", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/tmp/project" },
    { type: "message", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "old question" } },
    { type: "message", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", content: "old answer" } }
  ]
  const { root } = await fixture("harness-remote-omp-v1-", sessionID, records)
  try {
    const history = createOmpHistoryLoader(root)
    const page = await history.page(sessionID, { limit: 20 })
    assert.deepEqual(page.messages.map((message) => message.parts[0].text), ["old question", "old answer"])
    assert.deepEqual(page.messages.map((message) => message.info.id), [
      `omp-legacy:${sessionID}:0`,
      `omp-legacy:${sessionID}:1`
    ])
    assert.deepEqual(page.model, { providerID: "anthropic", modelID: "claude-sonnet-4" })
    assert.equal(history.diagnostics().legacySessions, 1)
    assert.equal(history.authoritativeHistory, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("legacy public ids survive OMP's native v1 to v3 rewrite", async () => {
  const sessionID = "session-v1-rewrite"
  const v1 = [
    { type: "session", cwd: "/tmp/project" },
    { type: "message", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "old question" } },
    { type: "message", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", content: "old answer" } }
  ]
  const { root, file } = await fixture("harness-remote-omp-v1-rewrite-", sessionID, v1)
  try {
    const history = createOmpHistoryLoader(root)
    const first = await history.page(sessionID, { limit: 20 })
    const firstIDs = first.messages.map((message) => message.info.id)

    const v3 = [
      { type: "session", version: 3, id: sessionID, cwd: "/tmp/project" },
      { type: "message", id: "random-a1", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "old question" } },
      { type: "message", id: "random-b2", parentId: "random-a1", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", content: "old answer" } },
      { type: "message", id: "random-c3", parentId: "random-b2", timestamp: "2025-01-01T00:00:03.000Z", message: { role: "user", content: "new prompt" } },
      { type: "message", id: "random-d4", parentId: "random-c3", timestamp: "2025-01-01T00:00:04.000Z", message: { role: "assistant", content: "new answer" } }
    ]
    await writeFile(file, `${v3.map((record) => JSON.stringify(record)).join("\n")}\n`)

    const second = await history.page(sessionID, { limit: 20 })
    assert.deepEqual(second.messages.slice(0, 2).map((message) => message.info.id), firstIDs)
    assert.deepEqual(second.messages.map((message) => message.parts[0].text), [
      "old question", "old answer", "new prompt", "new answer"
    ])
    assert.deepEqual(second.messages.slice(2).map((message) => message.info.id), [
      `omp-legacy:${sessionID}:2`,
      `omp-legacy:${sessionID}:3`
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("legacy paging cursor stays valid across OMP's migration rewrite", async () => {
  const sessionID = "session-v1-page"
  const v1 = [
    { type: "session", cwd: "/tmp/project" },
    { type: "message", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "u0" } },
    { type: "message", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", content: "a0" } },
    { type: "message", timestamp: "2025-01-01T00:00:03.000Z", message: { role: "user", content: "u1" } },
    { type: "message", timestamp: "2025-01-01T00:00:04.000Z", message: { role: "assistant", content: "a1" } }
  ]
  const { root, file } = await fixture("harness-remote-omp-v1-page-", sessionID, v1)
  try {
    const history = createOmpHistoryLoader(root)
    const newest = await history.page(sessionID, { limit: 2 })
    assert.deepEqual(newest.messages.map((message) => message.parts[0].text), ["u1", "a1"])
    assert.ok(newest.before)

    const v3 = [
      { type: "session", version: 3, id: sessionID, cwd: "/tmp/project" },
      { type: "message", id: "m0", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "u0" } },
      { type: "message", id: "m1", parentId: "m0", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", content: "a0" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2025-01-01T00:00:03.000Z", message: { role: "user", content: "u1" } },
      { type: "message", id: "m3", parentId: "m2", timestamp: "2025-01-01T00:00:04.000Z", message: { role: "assistant", content: "a1" } }
    ]
    await writeFile(file, `${v3.map((record) => JSON.stringify(record)).join("\n")}\n`)
    const older = await history.page(sessionID, { limit: 2, before: newest.before })
    assert.deepEqual(older.messages.map((message) => message.parts[0].text), ["u0", "a0"])
    assert.equal(older.hasMore, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("failed sibling attempts stay visible while abandoned successful siblings stay excluded", async () => {
  const sessionID = "session-errors"
  const records = [
    { type: "session", version: 3, id: sessionID, cwd: "/tmp/project" },
    { type: "message", id: "u0", parentId: null, timestamp: "2026-07-26T10:00:00.000Z", message: { role: "user", content: "u0" } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "2026-07-26T10:00:01.000Z", message: { role: "assistant", content: "a0" } },
    { type: "message", id: "u1", parentId: "a0", timestamp: "2026-07-26T10:00:02.000Z", message: { role: "user", content: "retry me" } },
    { type: "message", id: "failed", parentId: "u1", timestamp: "2026-07-26T10:00:03.000Z", message: { role: "assistant", errorMessage: "Interrupted by user", content: [] } },
    { type: "message", id: "abandoned-success", parentId: "u1", timestamp: "2026-07-26T10:00:04.000Z", message: { role: "assistant", content: "wrong answer" } },
    { type: "message", id: "selected-success", parentId: "u1", timestamp: "2026-07-26T10:00:05.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", content: "right answer" } }
  ]
  const { root } = await fixture("harness-remote-omp-errors-", sessionID, records)
  try {
    const history = createOmpHistoryLoader(root)
    const page = await history.page(sessionID, { limit: 10 })
    assert.deepEqual(page.messages.map((message) => message.info.id), ["u0", "a0", "u1", "failed", "selected-success"])
    assert.equal(page.messages.find((message) => message.info.id === "failed")?.info.error?.message, "Interrupted by user")
    assert.ok(!page.messages.some((message) => message.info.id === "abandoned-success"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("branch paging follows the persisted leaf without ACP replay", async () => {
  const sessionID = "session-page"
  const records = [
    { type: "session", version: 3, id: sessionID, cwd: "/tmp/project" },
    { type: "message", id: "u0", parentId: null, timestamp: "2026-07-26T10:00:00.000Z", message: { role: "user", content: "u0" } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "2026-07-26T10:00:01.000Z", message: { role: "assistant", content: "a0" } },
    { type: "message", id: "abandoned-u", parentId: "a0", timestamp: "2026-07-26T10:00:02.000Z", message: { role: "user", content: "abandoned" } },
    { type: "message", id: "abandoned-a", parentId: "abandoned-u", timestamp: "2026-07-26T10:00:03.000Z", message: { role: "assistant", content: "abandoned-a" } },
    { type: "message", id: "u1", parentId: "a0", timestamp: "2026-07-26T10:00:04.000Z", message: { role: "user", content: "u1" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-26T10:00:05.000Z", message: { role: "assistant", content: "a1" } },
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-07-26T10:00:06.000Z", message: { role: "user", content: "u2" } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-07-26T10:00:07.000Z", message: { role: "assistant", content: "a2" } }
  ]
  const { root } = await fixture("harness-remote-omp-page-", sessionID, records)
  try {
    const history = createOmpHistoryLoader(root)
    const first = await history.page(sessionID, { limit: 2 })
    assert.deepEqual(first.messages.map((message) => message.parts[0].text), ["u2", "a2"])
    const second = await history.page(sessionID, { before: first.before, limit: 2 })
    assert.deepEqual(second.messages.map((message) => message.parts[0].text), ["u1", "a1"])
    const third = await history.page(sessionID, { before: second.before, limit: 2 })
    assert.deepEqual(third.messages.map((message) => message.parts[0].text), ["u0", "a0"])
    assert.equal(third.hasMore, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("complete persisted OMP tail replaces a shorter live ACP prefix while busy", () => {
  const persisted = [
    envelope("json-u", "user", "same prompt", 1000),
    envelope("json-a", "assistant", "Complete answer including final words.", 1100)
  ]
  const cached = [
    envelope("live-u", "user", "same prompt", 1001),
    envelope("live-a", "assistant", "Complete answer", 1101)
  ]
  const merged = mergeOmpLiveHistory(persisted, cached)
  assert.deepEqual(merged.map((message) => message.info.id), ["json-u", "json-a"])
  assert.equal(merged[1].parts[0].text, "Complete answer including final words.")
})

test("live OMP tail remains visible while it is ahead of the journal", () => {
  const persisted = [
    envelope("json-u", "user", "same prompt", 1000),
    envelope("json-a", "assistant", "Complete answer", 1100)
  ]
  const cached = [
    envelope("live-u", "user", "same prompt", 1001),
    envelope("live-a", "assistant", "Complete answer still streaming", 1101)
  ]
  const merged = mergeOmpLiveHistory(persisted, cached)
  assert.deepEqual(merged.map((message) => message.info.id), ["json-u", "live-a"])
  assert.equal(merged[1].parts[0].text, "Complete answer still streaming")
})

test("reports the last model on the persisted OMP branch", async () => {
  const sessionID = "session-model"
  const records = [
    { type: "session", version: 3, id: sessionID, cwd: "/tmp/project" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-07-26T10:00:00.000Z", message: { role: "user", content: "Question" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-26T10:00:01.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", content: "Answer" } },
    { type: "model_change", id: "model-2", parentId: "a1", timestamp: "2026-07-26T10:00:02.000Z", model: "openai-codex/gpt-5.6" }
  ]
  const { root } = await fixture("harness-remote-omp-model-", sessionID, records)
  try {
    const page = await createOmpHistoryLoader(root).page(sessionID, { limit: 10 })
    assert.deepEqual(page.model, { providerID: "openai-codex", modelID: "gpt-5.6" })
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
    assert.equal((await loadHistory(sessionID)).length, 2)
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
    const messages = await createOmpHistoryLoader(root)(sessionID)
    assert.deepEqual(messages[0].parts.map((part) => part.type), ["text"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
