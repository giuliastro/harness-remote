import assert from "node:assert/strict"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createOmpHistoryLoader } from "../src/omp-session-history.js"

function titleSlot(title = "") {
  return { type: "title", v: 1, title, source: "user", updatedAt: "2026-08-26T18:00:00.000Z", pad: "" }
}

function header(sessionID, title = "") {
  return {
    type: "session",
    version: 3,
    id: sessionID,
    title,
    titleSource: title ? "user" : undefined,
    timestamp: "2026-08-26T18:00:00.000Z",
    cwd: "/tmp/project"
  }
}

function user(id, parentId, text, second = 1) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-08-26T18:00:0${second}.000Z`,
    message: { role: "user", content: text }
  }
}

function assistant(id, parentId, text, second = 2) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-08-26T18:00:0${second}.000Z`,
    message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", content: text }
  }
}

async function appendRecords(file, records) {
  await appendFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)
}

test("OMP 18.x title slot and session header are metadata, not fake branch leaves", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp18-header-"))
  const sessionID = "019faa51-header-test"
  const file = path.join(root, `2026-08-26_${sessionID}.jsonl`)
  await writeFile(file, `${[
    titleSlot("Named session"),
    header(sessionID, "Named session"),
    user("u1", null, "hello"),
    assistant("a1", "u1", "world")
  ].map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const history = createOmpHistoryLoader(root)
    const page = await history.page(sessionID, { limit: 20 })
    assert.deepEqual(page.messages.map((message) => message.parts[0].text), ["hello", "world"])
    assert.deepEqual(page.model, { providerID: "openai-codex", modelID: "gpt-5.6-terra" })
    assert.equal(history.needsReplay(sessionID), false, "a normal OMP 18.x Session must not require ACP replay")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an OMP journal created after a negative lookup is visible immediately on the first turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp18-lazy-"))
  const sessionID = "019faa51-lazy-test"
  const file = path.join(root, `2026-08-26_${sessionID}.jsonl`)

  try {
    const history = createOmpHistoryLoader(root)
    assert.deepEqual((await history.page(sessionID, { limit: 20 })).messages, [])
    const before = history.diagnostics().listingScans

    // OMP creates a fresh Session's JSONL lazily. This can happen milliseconds after session/new and
    // after Harness Remote has already scanned the directory once.
    await writeFile(file, `${[
      titleSlot("Fresh OMP"),
      header(sessionID, "Fresh OMP"),
      user("u1", null, "first prompt"),
      assistant("a1", "u1", "first answer")
    ].map((record) => JSON.stringify(record)).join("\n")}\n`)

    const page = await history.page(sessionID, { limit: 20 })
    assert.deepEqual(page.messages.map((message) => message.parts[0].text), ["first prompt", "first answer"])
    assert.ok(history.diagnostics().listingScans > before, "an unknown Session id must re-scan instead of caching a negative lookup")
    assert.equal(history.needsReplay(sessionID), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("ordinary OMP continuation advances the confirmed branch without session/load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp18-linear-"))
  const sessionID = "019faa51-linear-test"
  const file = path.join(root, `2026-08-26_${sessionID}.jsonl`)
  await writeFile(file, `${[
    titleSlot(),
    header(sessionID),
    user("u1", null, "one"),
    assistant("a1", "u1", "answer one")
  ].map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const history = createOmpHistoryLoader(root)
    assert.deepEqual((await history.page(sessionID, { limit: 20 })).messages.map((message) => message.parts[0].text), ["one", "answer one"])

    await appendRecords(file, [user("u2", "a1", "two", 3), assistant("a2", "u2", "answer two", 4)])
    const page = await history.page(sessionID, { limit: 20 })
    assert.deepEqual(page.messages.map((message) => message.parts[0].text), ["one", "answer one", "two", "answer two"])
    assert.equal(history.needsReplay(sessionID), false, "a unique descendant chain is PI-like normal continuation, not branch ambiguity")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("actual sibling replies still require native OMP branch selection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp18-branch-"))
  const sessionID = "019faa51-branch-test"
  const file = path.join(root, `2026-08-26_${sessionID}.jsonl`)
  await writeFile(file, `${[
    titleSlot(),
    header(sessionID),
    user("u1", null, "choose"),
    assistant("a-old", "u1", "old", 2),
    assistant("a-new", "u1", "new", 3)
  ].map((record) => JSON.stringify(record)).join("\n")}\n`)

  try {
    const history = createOmpHistoryLoader(root)
    assert.equal(await history.page(sessionID, { limit: 20 }), undefined)
    assert.equal(history.needsReplay(sessionID), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
