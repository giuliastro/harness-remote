import assert from "node:assert/strict"
import test from "node:test"
import {
  classifyCrossMachineProjectContinuity,
  requireCrossMachineProjectApproval
} from "./cross-machine-project-preflight.ts"
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

function preflight(assessment, classification = classifyCrossMachineProjectContinuity(assessment)) {
  return {
    sourceMachineID: "machine-a",
    targetMachineID: "machine-b",
    sourceProjectId: "machine-a:repo",
    targetProjectId: "machine-b:repo",
    sourceIdentityVerified: true,
    targetIdentityVerified: true,
    ...classification,
    assessment
  }
}

test("exact clean clones are the only seamless workspace match", () => {
  const assessment = assessProjectContinuity(identity(), identity())
  assert.deepEqual(assessment, {
    project: "match",
    repository: "match",
    history: "match",
    branch: "match",
    head: "match",
    sourceDirty: false,
    targetDirty: false,
    exactWorkspace: true
  })
  assert.deepEqual(classifyCrossMachineProjectContinuity(assessment), {
    decision: "automatic",
    reason: "exact_workspace"
  })
  assert.doesNotThrow(() => requireCrossMachineProjectApproval(preflight(assessment)))
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
  assert.deepEqual(classifyCrossMachineProjectContinuity(result), {
    decision: "review",
    reason: "project_unverified"
  })
  assert.throws(() => requireCrossMachineProjectApproval(preflight(result)), /needs confirmation/)
  assert.doesNotThrow(() => requireCrossMachineProjectApproval(preflight(result), { confirmed: true }))
})

test("repository or history contradictions fail closed as different", () => {
  const repositoryMismatch = assessProjectContinuity(identity(), identity({ repositoryFingerprint: "c".repeat(64) }))
  const historyMismatch = assessProjectContinuity(identity(), identity({ historyFingerprint: "d".repeat(64) }))
  assert.equal(repositoryMismatch.project, "different")
  assert.equal(historyMismatch.project, "different")
  assert.deepEqual(classifyCrossMachineProjectContinuity(repositoryMismatch), {
    decision: "blocked",
    reason: "project_mismatch"
  })
  assert.throws(
    () => requireCrossMachineProjectApproval(preflight(repositoryMismatch), { confirmed: true }),
    /does not match/,
    "explicit confirmation must never override contradictory Project identity"
  )
})

test("branch, HEAD and dirty differences require review instead of being called seamless", () => {
  const branch = assessProjectContinuity(identity(), identity({ branch: "feature" }))
  assert.equal(branch.project, "match")
  assert.equal(branch.branch, "different")
  assert.equal(branch.exactWorkspace, false)
  assert.deepEqual(classifyCrossMachineProjectContinuity(branch), {
    decision: "review",
    reason: "workspace_diverged"
  })

  const head = assessProjectContinuity(identity(), identity({ head: "cafebabe" }))
  assert.equal(head.head, "different")
  assert.equal(head.exactWorkspace, false)
  assert.deepEqual(classifyCrossMachineProjectContinuity(head), {
    decision: "review",
    reason: "workspace_diverged"
  })

  const dirty = assessProjectContinuity(identity(), identity({ dirty: true }))
  assert.equal(dirty.project, "match")
  assert.equal(dirty.targetDirty, true)
  assert.equal(dirty.exactWorkspace, false)
  assert.deepEqual(classifyCrossMachineProjectContinuity(dirty), {
    decision: "review",
    reason: "workspace_diverged"
  })
})

test("missing daemon evidence remains unverified and cannot auto-create", () => {
  const result = assessProjectContinuity(null, identity())
  assert.equal(result.project, "unverified")
  assert.equal(result.repository, "unverified")
  assert.equal(result.history, "unverified")
  assert.equal(result.exactWorkspace, false)
  assert.deepEqual(classifyCrossMachineProjectContinuity(result), {
    decision: "review",
    reason: "project_unverified"
  })
  assert.throws(() => requireCrossMachineProjectApproval(preflight(result)), /needs confirmation/)
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