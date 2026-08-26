import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createOmpHistoryLoader } from "../src/omp-session-history.js"

async function withJournal(records, run) {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-recovery-"))
  const sessionID = "session-recovery"
  await writeFile(
    path.join(root, `2026-08-26_${sessionID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  )
  try {
    await run(createOmpHistoryLoader(root), sessionID)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const records = [
  {
    type: "session_init",
    id: "init",
    parentId: null,
    timestamp: "2026-08-26T12:00:00.000Z",
    resolvedModel: "openai/gpt-default"
  },
  {
    type: "message",
    id: "user-1",
    parentId: "init",
    timestamp: "2026-08-26T12:00:01.000Z",
    message: { role: "user", content: "Fix it" }
  },
  {
    type: "message",
    id: "failed-1",
    parentId: "user-1",
    timestamp: "2026-08-26T12:00:02.000Z",
    message: {
      role: "assistant",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      content: [],
      stopReason: "error",
      errorMessage: "Provider request failed"
    }
  },
  {
    type: "message",
    id: "assistant-1",
    parentId: "user-1",
    timestamp: "2026-08-26T12:00:03.000Z",
    message: { role: "assistant", content: "Final answer" }
  },
  // A later abandoned sibling must not leak back into the selected branch just because it is newer.
  {
    type: "message",
    id: "abandoned-success",
    parentId: "user-1",
    timestamp: "2026-08-26T12:00:04.000Z",
    message: { role: "assistant", content: "Wrong sibling" }
  },
  {
    type: "message",
    id: "abandoned-error",
    parentId: "user-1",
    timestamp: "2026-08-26T12:00:05.000Z",
    message: { role: "assistant", content: [], errorMessage: "Later abandoned error" }
  }
]

test("production OMP history never guesses a terminal sibling when activeSessionLeaf is unavailable", async () => {
  await withJournal(records, async (loader, sessionID) => {
    loader.pageRequiresActiveLeaf = true

    assert.deepEqual(await loader(sessionID), [])
    assert.deepEqual(
      await loader.page(sessionID, { limit: 20 }),
      { messages: [], before: null, hasMore: false }
    )
  })
})

test("OMP reopen keeps failed attempts on the selected prompt without resurrecting abandoned answers", async () => {
  await withJournal(records, async (loader, sessionID) => {
    const messages = await loader(sessionID, { activeSessionLeaf: "assistant-1" })

    assert.deepEqual(
      messages.map((message) => [message.info.id, message.info.role, message.info.error?.message, message.parts.at(-1)?.text]),
      [
        ["user-1", "user", undefined, "Fix it"],
        ["failed-1", "assistant", "Provider request failed", undefined],
        ["assistant-1", "assistant", undefined, "Final answer"]
      ]
    )
    assert.equal(messages.some((message) => message.info.id === "abandoned-success"), false)
    assert.equal(messages.some((message) => message.info.id === "abandoned-error"), false)
  })
})

test("OMP newest-page recovery keeps the red failure and the model used by that visible attempt", async () => {
  await withJournal(records, async (loader, sessionID) => {
    const page = await loader.page(sessionID, { activeSessionLeaf: "assistant-1", limit: 3 })

    assert.deepEqual(page.messages.map((message) => message.info.id), ["user-1", "failed-1", "assistant-1"])
    assert.equal(page.messages[1].info.error?.message, "Provider request failed")
    assert.deepEqual(page.model, { providerID: "openai-codex", modelID: "gpt-5.6-luna" })
    assert.equal(page.hasMore, false)
    assert.equal(page.before, null)
  })
})
