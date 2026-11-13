import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  loadInitialMessageFeed,
  mergeLatestMessageFeed,
  mergeLatestMessagePage,
  prependOlderMessagePage
} from "./message-pages.ts"

function message(id, text = id) {
  return {
    info: { id, role: "assistant", time: { created: 1, updated: 1 } },
    parts: [{ id: `${id}-part`, type: "text", text }]
  }
}

function userMessage(id, text = id) {
  return {
    info: { id, role: "user", time: { created: 1 } },
    parts: [{ id: `${id}-part`, type: "text", text }]
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

test("a reply whose text moved to its own message is not kept twice (DeepSeek tool turns)", () => {
  // Live, DeepSeek serves a tool turn as one message whose final text part belongs to another id.
  // After a reload the same turn is split: reasoning and tool in the first message, the text in its
  // own message. The stale-prefix guard read the first message as "lost its text", kept the old
  // copy, and the text was drawn twice ("OK" / "OK") until the view was rebuilt.
  const prompt = userMessage("prompt", "Attendi 10 secondi poi rispondi OK")
  const live = {
    info: { id: "0e8a9276", role: "assistant", time: { created: 2 } },
    parts: [
      { id: "0e8a9276:reasoning:0", type: "reasoning", text: "Wait, then answer." },
      { id: "0e8a9276:tool:1", type: "tool", tool: "web_fetch", state: { status: "completed" } },
      { id: "7082d780:text:1", type: "text", text: "OK" }
    ]
  }
  const splitTool = {
    info: { id: "0e8a9276", role: "assistant", time: { created: 2 } },
    parts: [
      { id: "0e8a9276:reasoning:0", type: "reasoning", text: "Wait, then answer." },
      { id: "0e8a9276:tool:1", type: "tool", tool: "web_fetch", state: { status: "completed" } }
    ]
  }
  const splitText = {
    info: { id: "7082d780", role: "assistant", time: { created: 3 } },
    parts: [{ id: "7082d780:text:1", type: "text", text: "OK" }]
  }

  for (const complete of [true, false]) {
    const merged = mergeLatestMessagePage([prompt, live], [prompt, splitTool, splitText], { complete })
    const texts = merged.flatMap((entry) => entry.parts.filter((part) => part.type === "text" && entry.info.role === "assistant").map((part) => part.text))
    assert.deepEqual(texts, ["OK"], `the reply text is shown once (complete page: ${complete})`)
    assert.deepEqual(merged.map((entry) => entry.info.id), ["prompt", "0e8a9276", "7082d780"])
  }
})

test("the same short reply in another turn does not disable the stale-prefix guard", () => {
  const live = message("reply-2", "OK, done")
  const stale = message("reply-2", "OK")
  const earlierTurn = [userMessage("p1", "first"), message("reply-1", "OK, done"), userMessage("p2", "second")]
  const merged = mergeLatestMessagePage([...earlierTurn, live], [...earlierTurn, stale], { complete: true })
  assert.equal(merged.at(-1), live, "a stale journal prefix of this turn must still be held back")
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
  const controller = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")
  const conversation = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")
  const historyStyles = readFileSync(new URL("./taskdesk-history-loader.css", import.meta.url), "utf8")

  assert.match(controller, /controller\.loadMessagePage\(target\.config, target\.sessionID, target\.directory/)
  assert.match(controller, /loadInitialMessageFeed\(/)
  assert.match(controller, /mergeLatestMessageFeed\(existing, page\)/)
  assert.match(controller, /async function loadOlder\(\)/)
  assert.match(controller, /prependOlderMessagePage\(feed\.messages, page\.messages\)/)
  assert.match(controller, /onLoadOlder=\{loadOlder\}/)
  assert.match(controller, /hasMore=\{hasMore\}/)

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

test("a message first seen between two known ones lands at its page position, not at the end", () => {
  // The running reply first appears after a queued prompt is already known; the daemon lists it
  // above that prompt, and the merged feed must keep that order.
  const prompt = message("prompt-1")
  const queued = message("queued-2")
  const reply = message("reply-1")
  const merged = mergeLatestMessagePage([prompt, queued], [prompt, reply, queued])
  assert.deepEqual(merged.map((item) => item.info.id), ["prompt-1", "reply-1", "queued-2"])

  const older = message("older-0")
  const withHistory = mergeLatestMessagePage([prompt, queued], [older, prompt, queued])
  assert.deepEqual(withHistory.map((item) => item.info.id), ["older-0", "prompt-1", "queued-2"], "a new first row goes before the first known one")
})

test("a live tail refresh cannot resurrect earlier-history paging after the user loaded every turn", () => {
  const loaded = {
    messages: [userMessage("u1"), message("a1"), userMessage("u2"), message("a2")],
    before: undefined,
    hasMore: false
  }
  // The newest page still starts at the latest turn, so it reports older history that the mounted
  // feed has already loaded. Its metadata must not reopen the "Earlier messages" affordance.
  const latest = { messages: [userMessage("u2"), message("a2")], before: "u2", hasMore: true }
  const merged = mergeLatestMessageFeed(loaded, latest)

  assert.deepEqual(merged.messages.map((item) => item.info.id), ["u1", "a1", "u2", "a2"])
  assert.equal(merged.hasMore, false)
  assert.equal(merged.before, undefined)
})

test("a complete newest page clears stale paging metadata", () => {
  const existing = { messages: [userMessage("u1"), message("a1")], before: "u1", hasMore: true }
  const latest = { messages: [userMessage("u1"), message("a1")], before: undefined, hasMore: false }
  const merged = mergeLatestMessageFeed(existing, latest)

  assert.equal(merged.hasMore, false)
  assert.equal(merged.before, undefined)
})

test("the initial feed walks back to a prompt when the newest page contains only activity", async () => {
  const calls = []
  const feed = await loadInitialMessageFeed(async (before, limit) => {
    calls.push([before, limit])
    if (!before) return { messages: [message("a1"), message("a2")], before: "a1", hasMore: true }
    return { messages: [userMessage("u1")], before: undefined, hasMore: false }
  }, { initialLimit: 200, olderLimit: 500, maxOlderPages: 3 })

  assert.deepEqual(calls, [[undefined, 200], ["a1", 500]])
  assert.deepEqual(feed.messages.map((item) => item.info.id), ["u1", "a1", "a2"])
  assert.equal(feed.hasMore, false)
})

test("the initial feed also recovers a missing prompt before a newer complete turn", async () => {
  const calls = []
  const feed = await loadInitialMessageFeed(async (before, limit) => {
    calls.push([before, limit])
    if (!before) return {
      messages: [message("a1"), userMessage("u2"), message("a2")],
      before: "a1", hasMore: true
    }
    return { messages: [userMessage("u1")], before: undefined, hasMore: false }
  }, { initialLimit: 200, olderLimit: 500, maxOlderPages: 3 })

  assert.deepEqual(calls, [[undefined, 200], ["a1", 500]])
  assert.deepEqual(feed.messages.map((item) => item.info.id), ["u1", "a1", "u2", "a2"])
  assert.equal(feed.hasMore, false)
})

test("the initial feed leaves a page that already contains a prompt untouched", async () => {
  const calls = []
  const initial = { messages: [userMessage("u1"), message("a1")], before: "u1", hasMore: true }
  const feed = await loadInitialMessageFeed(async (before, limit) => {
    calls.push([before, limit])
    return initial
  }, { initialLimit: 200, olderLimit: 500, maxOlderPages: 3 })

  assert.deepEqual(calls, [[undefined, 200]])
  assert.equal(feed, initial)
})
