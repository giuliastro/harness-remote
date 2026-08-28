import assert from "node:assert/strict"
import test from "node:test"
import {
  nativeSessionTranscriptModel,
  openCodeTranscriptCompletion,
  stabilizePiTailMessageIDs,
  visibleNativePrompt
} from "./native-session-reconciliation.ts"

function message(id, role, text, extra = {}) {
  return {
    info: { id, role, sessionID: "s1", time: { created: extra.created ?? 1, ...(extra.completed ? { completed: extra.completed } : {}) }, ...(extra.error ? { error: extra.error } : {}) },
    parts: [{ id: id + ":text", messageID: id, type: "text", text }]
  }
}

test("PI live and journal identities converge only for one unambiguous final reply", () => {
  const previous = [message("live-a", "assistant", "same answer")]
  const persisted = [message("journal-a", "assistant", "same answer")]
  const stabilized = stabilizePiTailMessageIDs(previous, persisted)
  assert.equal(stabilized[0].info.id, "live-a")
  assert.equal(stabilized[0].parts[0].messageID, "live-a")

  const repeated = [
    message("journal-a", "assistant", "same answer"),
    message("journal-b", "assistant", "same answer")
  ]
  assert.deepEqual(
    stabilizePiTailMessageIDs(previous, repeated).map((entry) => entry.info.id),
    ["journal-a", "journal-b"],
    "ambiguous repeated answers must keep their native ids"
  )
})

test("OpenCode completion matches the newest repeated prompt occurrence", () => {
  const page = {
    messages: [
      message("u1", "user", "repeat", { created: 10 }),
      message("a1", "assistant", "first", { created: 11, completed: 12 }),
      message("u2", "user", "repeat", { created: 20 }),
      message("a2", "assistant", "second", { created: 21, completed: 22 })
    ],
    hasMore: false
  }
  assert.deepEqual(openCodeTranscriptCompletion(["repeat", "repeat"], page), { completedAt: 22 })
  assert.equal(
    openCodeTranscriptCompletion(["repeat", "repeat"], { ...page, messages: page.messages.slice(0, 3) }),
    null,
    "assistant text without terminal metadata must not clear Working"
  )
})

test("handoff transport text exposes only the user instruction", () => {
  const text = [
    "You are taking over an existing TaskDesk task.",
    "CONTEXT",
    "ignored",
    "USER INSTRUCTION",
    "Fix the actual bug",
    "",
    "Continue from the shared workspace and preserve context."
  ].join("\n")
  assert.equal(visibleNativePrompt(message("u1", "user", text)), "Fix the actual bug")
})

test("transcript model authority remains backend-scoped", () => {
  const model = { providerID: "anthropic", modelID: "claude-sonnet" }
  const page = { messages: [], hasMore: false, model }
  assert.deepEqual(nativeSessionTranscriptModel("omp", page), model)
  assert.deepEqual(nativeSessionTranscriptModel("codex", page), model)
  assert.equal(nativeSessionTranscriptModel("pi", page), null)
  assert.equal(nativeSessionTranscriptModel("omp", page, "older-cursor"), null)
})
