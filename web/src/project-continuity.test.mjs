import assert from "node:assert/strict"
import test from "node:test"
import {
  assessProjectContinuity,
  parseGitProjectIdentity
} from "./project-continuity.ts"

function identity(overrides = {}) {
  return {
    version: 1,
    vcs: "git",
    repositoryFingerprint: "a".repeat(64),
    historyFingerprint: "b".repeat(64),
    head: "deadbeef",
    branch: "main",
    dirty: false,
    ...overrides
  }
}

test("exact clean clones are the only seamless workspace match", () => {
  assert.deepEqual(assessProjectContinuity(identity(), identity()), {
    project: "match",
    repository: "match",
    history: "match",
    branch: "match",
    head: "match",
    sourceDirty: false,
    targetDirty: false,
    exactWorkspace: true
  })
})

test("fork-like shared history does not prove Project identity", () => {
  const result = assessProjectContinuity(
    identity({ repositoryFingerprint: undefined }),
    identity({ repositoryFingerprint: undefined })
  )
  assert.equal(result.history, "match")
  assert.equal(result.repository, "unverified")
  assert.equal(result.project, "unverified")
  assert.equal(result.exactWorkspace, false)
})

test("repository or history contradictions fail closed as different", () => {
  assert.equal(
    assessProjectContinuity(identity(), identity({ repositoryFingerprint: "c".repeat(64) })).project,
    "different"
  )
  assert.equal(
    assessProjectContinuity(identity(), identity({ historyFingerprint: "d".repeat(64) })).project,
    "different"
  )
})

test("branch, HEAD and dirty differences are visible instead of being called seamless", () => {
  const branch = assessProjectContinuity(identity(), identity({ branch: "feature" }))
  assert.equal(branch.project, "match")
  assert.equal(branch.branch, "different")
  assert.equal(branch.exactWorkspace, false)

  const head = assessProjectContinuity(identity(), identity({ head: "cafebabe" }))
  assert.equal(head.head, "different")
  assert.equal(head.exactWorkspace, false)

  const dirty = assessProjectContinuity(identity(), identity({ dirty: true }))
  assert.equal(dirty.project, "match")
  assert.equal(dirty.targetDirty, true)
  assert.equal(dirty.exactWorkspace, false)
})

test("missing daemon evidence remains unverified", () => {
  const result = assessProjectContinuity(null, identity())
  assert.equal(result.project, "unverified")
  assert.equal(result.repository, "unverified")
  assert.equal(result.history, "unverified")
  assert.equal(result.exactWorkspace, false)
})

test("identity parser accepts only bounded v1 Git evidence", () => {
  const parsed = parseGitProjectIdentity({ identity: identity() })
  assert.deepEqual(parsed, identity())

  assert.equal(parseGitProjectIdentity({ identity: null }), null)
  assert.equal(parseGitProjectIdentity({ identity: { version: 2, vcs: "git" } }), null)
  assert.deepEqual(
    parseGitProjectIdentity({
      identity: {
        version: 1,
        vcs: "git",
        repositoryFingerprint: "not-a-hash",
        historyFingerprint: "also-bad",
        head: "abc",
        dirty: false
      }
    }),
    { version: 1, vcs: "git", head: "abc", dirty: false }
  )
})
