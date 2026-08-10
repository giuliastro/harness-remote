import assert from "node:assert/strict"
import test from "node:test"
import { mergeExternalHistory } from "../src/acp-service.js"

function message(id, text, created, extras = {}) {
  return {
    info: { id, role: "user", sessionID: "session-1", time: { created } },
    parts: [{ id: `${id}:text`, messageID: id, type: "text", text, ...extras }]
  }
}

test("deduplicates replayed messages even when ids and timestamps differ", () => {
  const persisted = [message("persisted-1", "same prompt", 1_000)]
  const cached = [message("replayed-1", "same prompt", 120_000)]

  assert.deepEqual(
    mergeExternalHistory(persisted, cached).map((item) => item.info.id),
    ["persisted-1"]
  )
})

test("preserves legitimate repeated prompts by matching semantic occurrences one-for-one", () => {
  const persisted = [message("persisted-1", "repeat me", 1_000)]
  const cached = [
    message("replayed-1", "repeat me", 120_000),
    message("actual-repeat", "repeat me", 180_000)
  ]

  assert.deepEqual(
    mergeExternalHistory(persisted, cached).map((item) => item.info.id),
    ["persisted-1", "actual-repeat"]
  )
})

test("semantic matching ignores transient part ids but keeps meaningful part differences", () => {
  const persisted = [message("persisted-1", "same prompt", 1_000)]
  const replayed = message("replayed-1", "same prompt", 120_000)
  replayed.parts[0].id = "different-part-id"
  replayed.parts[0].messageID = "different-message-id"

  assert.equal(mergeExternalHistory(persisted, [replayed]).length, 1)

  const distinct = message("distinct", "same prompt", 180_000, { type: "reasoning" })
  assert.equal(mergeExternalHistory(persisted, [distinct]).length, 2)
})
