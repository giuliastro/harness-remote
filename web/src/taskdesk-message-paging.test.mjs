import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { mergeLatestMessagePage, prependOlderMessagePage } from "./message-pages.ts"

function message(id, text = id, role = "assistant", created = 1) {
  return {
    info: { id, role, time: { created, updated: created } },
    parts: [{ id: `${id}:text:0`, messageID: id, type: "text", text }]
  }
}

test("message paging client consumes bridge cursor headers", () => {
  const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8")
  const server = readFileSync(new URL("../../bridge/src/server.js", import.meta.url), "utf8")

  assert.match(api, /export type MessagePage/)
  assert.match(api, /async loadMessagePage\(/)
  assert.match(api, /params\.set\("before", before\)/)
  assert.match(api, /response\.headers\["x-next-cursor"\]/)
  assert.match(api, /response\.headers\["x-has-more"\] === "1"/)
  assert.match(server, /service\.messagePage\(sessionID/)
  assert.match(server, /response\.setHeader\("X-Next-Cursor", page\.before\)/)
  assert.match(server, /response\.setHeader\("X-Has-More", page\.hasMore \? "1" : "0"\)/)
})

test("newest-page refresh preserves explicitly loaded older messages", () => {
  const oldA = message("a")
  const oldB = message("b")
  const oldC = message("c")
  const newC = message("c", "updated")
  const newD = message("d")

  const merged = mergeLatestMessagePage([oldA, oldB, oldC], [newC, newD])
  assert.deepEqual(merged.map((entry) => entry.info.id), ["a", "b", "c", "d"])
  assert.equal(merged[0], oldA)
  assert.equal(merged[1], oldB)
  assert.equal(merged[2], newC)
  assert.equal(merged[3], newD)
})

test("newest-page reconcile never cuts a streamed assistant reply back to a stale journal prefix", () => {
  const complete = message("reply", "This is the complete answer from the live ACP stream.")
  const staleJournal = message("reply", "This is the complete answer")

  const merged = mergeLatestMessagePage([complete], [staleJournal])
  assert.equal(merged[0], complete, "a same-id journal prefix must not replace the longer live answer")
  assert.equal(merged[0].parts[0].text, "This is the complete answer from the live ACP stream.")

  const laterJournal = message("reply", "This is the complete answer from the live ACP stream. Persisted.")
  const caughtUp = mergeLatestMessagePage(merged, [laterJournal])
  assert.equal(caughtUp[0], laterJournal, "a journal that catches up and extends the answer remains authoritative")
})

test("a persisted OMP user id replaces the temporary prompt id before the assistant exists", () => {
  const firstUser = message("u1", "first", "user", 1_000)
  const firstAssistant = message("a1", "first answer", "assistant", 1_100)
  firstAssistant.info.time.completed = 1_100
  const temporarySecond = message("temporary-second", "second", "user", 2_000)

  // OMP persists the user message before its assistant is durable. The native id must alias the
  // already-visible temporary prompt instead of becoming a second logical user turn.
  const persistedSecond = message("omp-u2", "second", "user", 2_001)
  const liveAssistant = message("live-a2", "working on second", "assistant", 2_100)
  const merged = mergeLatestMessagePage(
    [firstUser, firstAssistant, temporarySecond],
    [firstUser, firstAssistant, persistedSecond, liveAssistant]
  )

  assert.deepEqual(
    merged.map((entry) => entry.info.id),
    ["u1", "a1", "temporary-second", "live-a2"],
    "the persisted prompt must keep the accepted Run's existing browser identity"
  )
  assert.equal(
    merged.filter((entry) => entry.info.role === "user" && entry.parts[0]?.text === "second").length,
    1,
    "one accepted prompt must remain one native turn"
  )
})

test("a later repeated completed prompt is not mistaken for an id migration", () => {
  const oldUser = message("old-user", "repeat", "user", 1_000)
  const oldAssistant = message("old-assistant", "old result", "assistant", 1_100)
  oldAssistant.info.time.completed = 1_100
  const newUser = message("new-user", "repeat", "user", 1_500)
  const newAssistant = message("new-assistant", "different result", "assistant", 1_600)
  newAssistant.info.time.completed = 1_600

  const merged = mergeLatestMessagePage([oldUser, oldAssistant], [newUser, newAssistant])
  assert.deepEqual(
    merged.map((entry) => entry.info.id),
    ["old-user", "old-assistant", "new-user", "new-assistant"],
    "terminal repeated turns need compatible assistant evidence before ids can be stabilized"
  )
})

test("live ACP ids reconcile to persisted journal ids without duplicating the final turn", () => {
  const liveUser = message("live-user", "same prompt", "user", 1000)
  const liveAssistant = message("live-assistant", "answer prefix", "assistant", 1100)
  const journalUser = message("jsonl-user", "same prompt", "user", 1001)
  const journalAssistant = message("jsonl-assistant", "answer prefix plus final words", "assistant", 1101)

  const merged = mergeLatestMessagePage([liveUser, liveAssistant], [journalUser, journalAssistant])
  assert.deepEqual(merged.map((entry) => entry.info.id), ["live-user", "live-assistant"])
  assert.equal(merged[1].parts[0].text, "answer prefix plus final words", "the persisted complete tail must replace the live prefix in place")
  assert.equal(merged[1].parts[0].messageID, "live-assistant")
})

test("cross-id stabilization is limited to one unambiguous current turn", () => {
  const firstUser = message("u1", "repeat", "user", 1_000)
  const firstAssistant = message("a1", "same answer", "assistant", 1_100)
  const laterUser = message("u2", "repeat", "user", 60_000)
  const laterAssistant = message("a2", "same answer", "assistant", 60_100)

  const merged = mergeLatestMessagePage([firstUser, firstAssistant], [laterUser, laterAssistant])
  assert.deepEqual(
    merged.map((entry) => entry.info.id),
    ["u1", "a1", "u2", "a2"],
    "identical text from a later repeated turn must not be collapsed into historical ids"
  )
})

test("cross-id stabilization never hides errors or tool-bearing native messages", () => {
  const liveUser = message("live-user", "prompt", "user", 1000)
  const liveAssistant = message("live-assistant", "answer", "assistant", 1100)
  const journalUser = message("jsonl-user", "prompt", "user", 1001)
  const journalAssistant = {
    ...message("jsonl-assistant", "answer", "assistant", 1101),
    parts: [
      { id: "jsonl-assistant:text:0", messageID: "jsonl-assistant", type: "text", text: "answer" },
      { id: "jsonl-assistant:tool:1", messageID: "jsonl-assistant", type: "tool", callID: "call", tool: "x", state: { status: "completed" } }
    ]
  }

  const merged = mergeLatestMessagePage([liveUser, liveAssistant], [journalUser, journalAssistant])
  assert.ok(merged.some((entry) => entry.info.id === "jsonl-assistant"), "a tool-bearing persisted envelope must keep its native identity")
})

test("a divergent native rewrite is not mistaken for a stale prefix", () => {
  const current = message("reply", "draft answer that was streamed")
  const rewritten = message("reply", "final answer from native history")
  const merged = mergeLatestMessagePage([current], [rewritten])
  assert.equal(merged[0], rewritten)
})

test("older pages prepend without duplicating the cursor boundary", () => {
  const currentB = message("b")
  const currentC = message("c")
  const olderA = message("a")
  const duplicateB = message("b", "duplicate")

  const merged = prependOlderMessagePage([currentB, currentC], [olderA, duplicateB])
  assert.deepEqual(merged.map((entry) => entry.info.id), ["a", "b", "c"])
  assert.equal(merged[1], currentB)
  assert.equal(merged[2], currentC)
})

test("Session conversation exposes bounded older-history loading without snapping back to the live tail", () => {
  const workspace = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  const conversation = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")
  const historyStyles = readFileSync(new URL("./taskdesk-history-loader.css", import.meta.url), "utf8")

  assert.match(workspace, /api\.loadMessagePage\(item\.config, item\.session\.id, item\.session\.directory\)/)
  assert.match(workspace, /silent \? mergeLatestMessagePage\(current\.messages, messagePage\.messages\) : messagePage\.messages/)
  assert.match(workspace, /async function loadOlderMessages\(\)/)
  assert.match(workspace, /prependOlderMessagePage\(current\.messages, page\.messages\)/)
  assert.match(workspace, /onLoadOlder=\{loadOlderMessages\}/)
  assert.match(workspace, /hasMore=\{messageHasMore\}/)

  assert.match(conversation, /taskdesk-history-loader\.css/)
  assert.match(conversation, /className="uw-history-load"/)
  assert.match(conversation, /Earlier messages/)
  assert.match(conversation, /nearBottomRef\.current = false/)
  assert.match(conversation, /window\.cancelAnimationFrame\(followFrameRef\.current\)/)
  assert.match(conversation, /preservingOlderRef\.current = true/)
  assert.match(conversation, /current\.scrollTop = Math\.max\(0, Math\.min\(previousTop, current\.scrollHeight - current\.clientHeight\)\)/)
  assert.doesNotMatch(conversation, /current\.scrollTop = previousTop \+ \(current\.scrollHeight - previousHeight\)/)

  assert.match(historyStyles, /\.uw-history-loader::before/)
  assert.match(historyStyles, /\.uw-history-load/)
  assert.match(historyStyles, /overflow-anchor: none/)
})
