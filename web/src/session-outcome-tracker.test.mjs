import assert from "node:assert/strict"
import test from "node:test"
import { SessionOutcomeTracker } from "./session-outcome-tracker.ts"

test("the first snapshot is a baseline: opening the app announces nothing", () => {
  const tracker = new SessionOutcomeTracker()
  assert.deepEqual(tracker.observe("m:claude", { a: { type: "idle" }, b: { type: "busy" } }), [])
})

test("a Session seen working and then idle is ready exactly once", () => {
  const tracker = new SessionOutcomeTracker()
  tracker.observe("m:claude", { a: { type: "idle" } })
  assert.deepEqual(tracker.observe("m:claude", { a: { type: "busy" } }), [])
  assert.deepEqual(tracker.observe("m:claude", { a: { type: "idle" } }), [{ kind: "ready", sessionID: "a" }])
  assert.deepEqual(tracker.observe("m:claude", { a: { type: "idle" } }), [], "later polls of the same idle Session stay silent")
})

test("an error after work is a failed outcome; string statuses are accepted too", () => {
  const tracker = new SessionOutcomeTracker()
  tracker.observe("m:deepseek", { a: "busy" })
  assert.deepEqual(tracker.observe("m:deepseek", { a: "error" }), [{ kind: "failed", sessionID: "a" }])
})

test("idle without an observed busy edge is never announced", () => {
  const tracker = new SessionOutcomeTracker()
  tracker.observe("m:claude", { a: { type: "idle" } })
  assert.deepEqual(tracker.observe("m:claude", { a: { type: "idle" }, b: { type: "idle" } }), [])
})

test("a working Session missing from one snapshot still reports its end", () => {
  const tracker = new SessionOutcomeTracker()
  tracker.observe("m:claude", { a: { type: "busy" } })
  assert.deepEqual(tracker.observe("m:claude", {}), [])
  assert.deepEqual(tracker.observe("m:claude", { a: { type: "idle" } }), [{ kind: "ready", sessionID: "a" }])
})

test("scopes are independent and a removed scope is forgotten", () => {
  const tracker = new SessionOutcomeTracker()
  tracker.observe("m:claude", { a: { type: "busy" } })
  tracker.observe("m:codex", { a: { type: "busy" } })
  assert.deepEqual(tracker.observe("m:codex", { a: { type: "idle" } }), [{ kind: "ready", sessionID: "a" }])
  tracker.retain(["m:codex"])
  assert.equal(tracker.hasWork("m:claude"), false)
  assert.deepEqual(tracker.observe("m:claude", { a: { type: "idle" } }), [], "a forgotten scope starts again from a baseline")
})
