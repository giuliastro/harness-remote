import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { mergeLatestMessagePage, prependOlderMessagePage } from "./message-pages.ts"

function message(id, text = id) {
  return {
    info: { id, role: "assistant", time: { created: 1, updated: 1 } },
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

test("Session conversation exposes bounded older-history loading through the shared conversation core", () => {
  const workspace = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  const conversation = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")

  assert.match(workspace, /api\.loadMessagePage\(item\.config, item\.session\.id, item\.session\.directory\)/)
  assert.match(workspace, /silent \? mergeLatestMessagePage\(current\.messages, messagePage\.messages\) : messagePage\.messages/)
  assert.match(workspace, /async function loadOlderMessages\(\)/)
  assert.match(workspace, /prependOlderMessagePage\(current\.messages, page\.messages\)/)
  assert.match(workspace, /onLoadOlder=\{loadOlderMessages\}/)
  assert.match(workspace, /hasMore=\{messageHasMore\}/)

  assert.match(conversation, /Load older messages/)
  assert.match(conversation, /const previousHeight = transcript\?\.scrollHeight \?\? 0/)
  assert.match(conversation, /const previousTop = transcript\?\.scrollTop \?\? 0/)
  assert.match(conversation, /current\.scrollTop = previousTop \+ \(current\.scrollHeight - previousHeight\)/)
  assert.match(conversation, /preservingOlderRef\.current = true/)
})
