import assert from "node:assert/strict"
import test from "node:test"
import { nextFinishedKeys, withoutFinishedKey } from "./native-session-unseen.ts"

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

test("clicking a Session that is not marked changes nothing", () => {
  const finished = new Set(["a"])
  assert.equal(withoutFinishedKey(finished, "b"), finished)
})
