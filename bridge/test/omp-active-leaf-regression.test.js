import assert from "node:assert/strict"
import test from "node:test"
import { HARNESS_PROFILES } from "../src/harness-profiles.js"

test("OMP paged history requires the extension's authoritative active leaf", () => {
  const loader = HARNESS_PROFILES.omp.historyLoader
  assert.equal(
    loader.pageRequiresActiveLeaf,
    true,
    "OMP JSONL is a tree: newest terminal leaf may be an abandoned sibling and must not choose the visible branch"
  )
})
