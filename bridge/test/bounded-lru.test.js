import assert from "node:assert/strict"
import test from "node:test"
import { BoundedLru } from "../src/bounded-lru.js"

test("bounded LRU evicts the least recently used entry by count", () => {
  const cache = new BoundedLru({ maxEntries: 2 })
  cache.set("run-1", ["a"])
  cache.set("run-2", ["b"])
  assert.deepEqual(cache.get("run-1"), ["a"], "reading an entry must make it recent")
  cache.set("run-3", ["c"])

  assert.equal(cache.has("run-1"), true)
  assert.equal(cache.has("run-2"), false)
  assert.equal(cache.has("run-3"), true)
  assert.equal(cache.size, 2)
})

test("bounded LRU evicts by transcript weight even below the entry limit", () => {
  const cache = new BoundedLru({
    maxEntries: 10,
    maxWeight: 5,
    weightOf: (messages) => messages.length
  })
  cache.set("run-1", [1, 2, 3])
  cache.set("run-2", [4, 5, 6])

  assert.equal(cache.has("run-1"), false)
  assert.equal(cache.has("run-2"), true)
  assert.equal(cache.weight, 3)
})

test("replacing and deleting entries keep the tracked weight exact", () => {
  const cache = new BoundedLru({ maxEntries: 3, maxWeight: 20, weightOf: (value) => value.length })
  cache.set("a", "12345")
  cache.set("a", "12")
  cache.set("b", "123")
  assert.equal(cache.weight, 5)
  assert.equal(cache.delete("a"), true)
  assert.equal(cache.weight, 3)
  cache.clear()
  assert.equal(cache.weight, 0)
  assert.equal(cache.size, 0)
})

test("protected active entries survive pressure while inactive entries are evicted", () => {
  const protectedKeys = new Set(["active"])
  const evicted = []
  const cache = new BoundedLru({
    maxEntries: 2,
    canEvict: (key) => !protectedKeys.has(key),
    onEvict: (key) => evicted.push(key)
  })
  cache.set("active", ["a"])
  cache.set("old", ["b"])
  cache.set("new", ["c"])

  assert.equal(cache.has("active"), true)
  assert.equal(cache.has("old"), false)
  assert.equal(cache.has("new"), true)
  assert.deepEqual(evicted, ["old"])
})

test("refresh recomputes weight after a cached mutable transcript grows", () => {
  const first = [1]
  const second = [2]
  const cache = new BoundedLru({
    maxEntries: 4,
    maxWeight: 3,
    weightOf: (messages) => messages.length
  })
  cache.set("first", first)
  cache.set("second", second)
  assert.equal(cache.get("first"), first, "the transcript being viewed becomes most-recently used")
  first.push(3, 4)
  cache.refresh("first")

  assert.equal(cache.has("second"), false)
  assert.equal(cache.has("first"), true)
  assert.equal(cache.weight, 3)
})

test("reported growth counts at once and re-weighs only after half the last weigh", () => {
  let weighs = 0
  const value = [1, 2, 3, 4]
  const cache = new BoundedLru({ weightOf: (items) => { weighs += 1; return items.length * 10 } })
  cache.set("entry", value)
  value.push(5)
  cache.grow("entry", 19)
  assert.equal(weighs, 1)
  assert.equal(cache.weight, 59)
  value.push(6)
  cache.grow("entry", 1)
  assert.equal(weighs, 2)
  assert.equal(cache.weight, 60)
  assert.equal(cache.grow("missing", 10), false)
})

test("reported growth evicts an inactive entry as soon as it crosses the budget", () => {
  const live = [1, 2, 3, 4, 5]
  const cache = new BoundedLru({ maxWeight: 10, weightOf: (items) => items.length })
  cache.set("old", [1, 2, 3, 4])
  cache.set("live", live)
  live.push(6, 7)
  cache.grow("live", 2)
  assert.equal(cache.has("old"), false)
  assert.equal(cache.weight, 7)
})
