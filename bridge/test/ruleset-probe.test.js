import assert from "node:assert/strict"
import test from "node:test"

// Deliberately red: proves the main ruleset blocks a merge when a required check fails.
test("ruleset probe fails on purpose", () => {
  assert.equal(1, 2)
})
