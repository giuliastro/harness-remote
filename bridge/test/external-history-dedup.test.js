import assert from "node:assert/strict"
import test from "node:test"
import { mergeExternalHistory, mergeReplay } from "../src/acp-service.js"

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

test("mergeReplay preserves common prefix and appends new messages efficiently", () => {
  const prev = [message("m1", "first", 100), message("m2", "second", 200)]
  const replayed = [message("m1", "first", 100), message("m2", "second", 200), message("m3", "third", 300)]
  const merged = mergeReplay(prev, replayed)
  assert.deepEqual(merged.map((m) => m.info.id), ["m1", "m2", "m3"])
})

test("mergeReplay handles middle modifications and suffix matches", () => {
  const prev = [message("m1", "head", 100), message("m2", "old mid", 200), message("m3", "tail", 300)]
  const replayed = [message("m1", "head", 100), message("m2-new", "new mid", 250), message("m3", "tail", 300)]
  const merged = mergeReplay(prev, replayed)
  assert.deepEqual(merged.map((m) => m.info.id), ["m1", "m2", "m2-new", "m3"])
})

test("mergeExternalHistory handles in-place mutated messages without stale signature leaks", () => {
  const msg = message("live-1", "initial text", 1_000)
  // First merge
  const first = mergeExternalHistory([msg], [msg])
  assert.equal(first.length, 1)

  // Mutate in place as streaming does
  msg.parts[0].text = "mutated streaming text"
  const distinctMsg = message("live-2", "initial text", 2_000)

  // Second merge with mutated message must recognize content difference
  const second = mergeExternalHistory([msg], [distinctMsg])
  assert.equal(second.length, 2)
})

test("differential test: mergeReplay matches full-matrix LCS on random sequences", () => {
  function referenceMergeReplay(previous, replayed) {
    if (previous.length === 0) return replayed
    if (replayed.length === 0) return previous
    const messageSignature = (m) => `${m?.info?.role ?? ""}\u0000${(m?.parts ?? []).map((p) => p?.text ?? "").join("")}`
    const left = previous.map(messageSignature)
    const right = replayed.map(messageSignature)
    const common = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
    for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
      for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
        common[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
          ? common[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(common[leftIndex + 1][rightIndex], common[leftIndex][rightIndex + 1])
      }
    }
    const merged = []
    let leftIndex = 0
    let rightIndex = 0
    while (leftIndex < left.length && rightIndex < right.length) {
      if (left[leftIndex] === right[rightIndex]) {
        merged.push(previous[leftIndex])
        leftIndex += 1
        rightIndex += 1
      } else if (common[leftIndex + 1][rightIndex] >= common[leftIndex][rightIndex + 1]) {
        merged.push(previous[leftIndex])
        leftIndex += 1
      } else {
        merged.push(replayed[rightIndex])
        rightIndex += 1
      }
    }
    return [...merged, ...previous.slice(leftIndex), ...replayed.slice(rightIndex)]
  }

  const alphabet = ["A", "B", "C", "D", "E", "F", "G"]
  let seed = 42
  function random() {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }

  for (let trial = 0; trial < 1000; trial += 1) {
    const prevLen = Math.floor(random() * 20)
    const repLen = Math.floor(random() * 20)
    const prev = Array.from({ length: prevLen }, (_, i) =>
      message(`p-${i}`, alphabet[Math.floor(random() * alphabet.length)], 100 + i)
    )
    const replayed = Array.from({ length: repLen }, (_, i) =>
      message(`r-${i}`, alphabet[Math.floor(random() * alphabet.length)], 200 + i)
    )

    const expected = referenceMergeReplay(prev, replayed).map((m) => m.info.id)
    const actual = mergeReplay(prev, replayed).map((m) => m.info.id)
    assert.deepEqual(actual, expected, `Trial ${trial} failed`)
  }
})
