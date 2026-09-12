import assert from "node:assert/strict"
import test from "node:test"
import { nativeSessionLineage } from "./native-session-lineage.ts"

const current = { machineID: "machine-b", agentID: "claude", sessionID: "target-1", directory: "/repo-copy" }
const source = { machineID: "machine-a", agentID: "codex", sessionID: "source-1", directory: "/repo" }
const next = { machineID: "machine-c", agentID: "pi", sessionID: "next-1", directory: "/work/repo" }

function link(overrides = {}) {
  return {
    type: "handoff",
    source,
    target: current,
    createdAt: "2026-09-12T05:00:00.000Z",
    transferredContext: "Task state and evidence",
    ...overrides
  }
}

test("incoming lineage exposes portable context but invalidates source authority", () => {
  const entries = nativeSessionLineage(current, [link()])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].direction, "incoming")
  assert.deepEqual(entries[0].other, source)
  assert.equal(entries[0].contextCarried, true)
  assert.equal(entries[0].authority, "invalidated")
  assert.equal(entries[0].targetAuthorization, "re_evaluate")
  assert.equal(entries[0].attachments, "not_transferred")
})

test("outgoing lineage points at the exact target without comparing machine-local paths", () => {
  const entries = nativeSessionLineage(
    { ...current, directory: "/different/local/path" },
    [{ ...link(), source: current, target: next }]
  )
  assert.equal(entries.length, 1)
  assert.equal(entries[0].direction, "outgoing")
  assert.deepEqual(entries[0].other, next)
})

test("unrelated and self links are excluded and duplicate edges collapse", () => {
  const unrelated = {
    ...link(),
    source: { machineID: "x", agentID: "codex", sessionID: "x1", directory: "/x" },
    target: { machineID: "y", agentID: "codex", sessionID: "y1", directory: "/y" }
  }
  const self = { ...link(), source: current, target: current }
  assert.equal(nativeSessionLineage(current, [unrelated, self, link(), link()]).length, 1)
})

test("missing portable context is represented as not carried instead of inventing state", () => {
  const entries = nativeSessionLineage(current, [link({ transferredContext: undefined })])
  assert.equal(entries[0].contextCarried, false)
})
