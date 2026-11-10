import assert from "node:assert/strict"
import test from "node:test"
import { countVisibleFinishedKeys, nextFinishedKeys, unseenKeysOutsideAttention, withoutFinishedKey } from "./native-session-unseen.ts"

const states = (entries) => new Map(Object.entries(entries))
const none = new Set()

test("a Session the rail sees finish stays marked until it is clicked", () => {
  let finished = nextFinishedKeys(none, states({ a: "working" }), states({ a: "ready" }))
  assert.deepEqual([...finished], ["a"])
  // Later updates, however many, keep it marked.
  finished = nextFinishedKeys(finished, states({ a: "ready" }), states({ a: "ready" }))
  assert.deepEqual([...finished], ["a"])
  finished = withoutFinishedKey(finished, "a")
  assert.deepEqual([...finished], [])
})

test("a Session that was already ready is never marked, whatever its timestamps do", () => {
  // The first update of a page load has nothing before it; an idle Session listed again is idle.
  assert.deepEqual([...nextFinishedKeys(none, states({}), states({ a: "ready", b: "ready" }))], [])
  assert.deepEqual([...nextFinishedKeys(none, states({ a: "ready" }), states({ a: "ready" }))], [])
})

test("a marked Session that starts working again or asks for input loses the mark", () => {
  const finished = new Set(["a", "b"])
  const next = nextFinishedKeys(finished, states({ a: "ready", b: "ready" }), states({ a: "working", b: "attention" }))
  assert.deepEqual([...next], [])
})

test("a marked Session missing from an update keeps its mark", () => {
  const finished = new Set(["a"])
  assert.equal(nextFinishedKeys(finished, states({ a: "ready" }), states({})), finished)
})

test("a hidden finished Session does not count until it is shown again", () => {
  const finished = new Set(["a", "b"])
  const hidden = new Set(["a"])
  // Only the visible finished Session is published; the hidden one's mark is kept untouched.
  assert.equal(countVisibleFinishedKeys(finished, hidden, false), 1)
  assert.deepEqual([...finished], ["a", "b"])
  // Showing hidden Sessions again, or turning the hide rules off, counts the kept mark again.
  assert.equal(countVisibleFinishedKeys(finished, hidden, true), 2)
  assert.equal(countVisibleFinishedKeys(finished, new Set(), false), 2)
  // A Session that finishes while hidden alone must not move the published count at all.
  assert.equal(countVisibleFinishedKeys(new Set(["a"]), hidden, false), 0)
})

test("clicking a Session that is not marked changes nothing", () => {
  const finished = new Set(["a"])
  assert.equal(withoutFinishedKey(finished, "b"), finished)
})

test("an unseen finish already counted as Attention is not published twice", () => {
  const finished = new Set(["a", "b", "c"])
  const attention = new Set(["b"])
  assert.deepEqual([...unseenKeysOutsideAttention(finished, attention)], ["a", "c"])
  // Marks outside the current Attention scope stay, because that scoped count cannot see them.
  assert.deepEqual([...unseenKeysOutsideAttention(finished, new Set(["outside"]))], ["a", "b", "c"])
  assert.equal(unseenKeysOutsideAttention(finished, new Set()), finished)
})
