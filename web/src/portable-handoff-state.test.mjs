import assert from "node:assert/strict"
import test from "node:test"
import { buildPortableHandoffState, parsePortableHandoffState } from "./portable-handoff-state.ts"

function source(overrides = {}) {
  return {
    title: "Fix the bridge regression",
    permission: [{ permission: "bash", pattern: "deploy prod", action: "allow" }],
    directory: "/private/source/path",
    ...overrides
  }
}

function preflight(overrides = {}) {
  return {
    sourceProjectId: "source-project",
    targetProjectId: "target-project",
    decision: "review",
    reason: "workspace_diverged",
    assessment: {
      project: "match",
      repository: "match",
      history: "match",
      branch: "different",
      head: "different",
      sourceDirty: false,
      targetDirty: true,
      exactWorkspace: false
    },
    ...overrides
  }
}

function exactState() {
  return buildPortableHandoffState(source(), preflight({
    decision: "automatic",
    reason: "exact_workspace",
    assessment: {
      project: "match",
      repository: "match",
      history: "match",
      branch: "match",
      head: "match",
      sourceDirty: false,
      targetDirty: false,
      exactWorkspace: true
    }
  }))
}

test("portable handoff state carries task identity and Project evidence without authority or paths", () => {
  const state = buildPortableHandoffState(source(), preflight())
  assert.deepEqual(state, {
    version: 1,
    task: { title: "Fix the bridge regression", state: "continuing" },
    project: {
      sourceProjectId: "source-project",
      targetProjectId: "target-project",
      decision: "review",
      reason: "workspace_diverged",
      evidence: {
        project: "match",
        repository: "match",
        history: "match",
        branch: "different",
        head: "different",
        sourceDirty: false,
        targetDirty: true,
        exactWorkspace: false
      }
    },
    controls: {
      sourceAuthority: "invalidated",
      targetAuthorization: "re_evaluate",
      attachments: "not_transferred"
    }
  })
  const serialized = JSON.stringify(state)
  assert.equal(serialized.includes("/private/source/path"), false)
  assert.equal(serialized.includes("deploy prod"), false)
  assert.equal(serialized.includes("permission"), false)
  assert.equal(serialized.includes("approval"), false)
})

test("portable evidence records classification, never raw branch or HEAD values", () => {
  const state = exactState()
  assert.equal(state.project.decision, "automatic")
  assert.equal(state.project.evidence.branch, "match")
  assert.equal(state.project.evidence.head, "match")
  const serialized = JSON.stringify(state)
  assert.equal(serialized.includes("refs/heads"), false)
  assert.equal(serialized.includes("0123456789abcdef"), false)
})

test("blocked Project continuity can never be serialized for a handoff", () => {
  assert.throws(
    () => buildPortableHandoffState(source(), preflight({ decision: "blocked", reason: "project_mismatch" })),
    /cannot produce portable handoff state/
  )
})

test("recovered automatic state must be internally consistent with exact workspace evidence", () => {
  const exact = exactState()
  assert.deepEqual(parsePortableHandoffState(exact), exact)
  assert.equal(parsePortableHandoffState({
    ...exact,
    project: {
      ...exact.project,
      evidence: { ...exact.project.evidence, targetDirty: true }
    }
  }), null)
  assert.equal(parsePortableHandoffState({
    ...exact,
    project: {
      ...exact.project,
      evidence: { ...exact.project.evidence, repository: "unverified" }
    }
  }), null)
})

test("recovered review state cannot claim exact workspace continuity", () => {
  const review = buildPortableHandoffState(source(), preflight())
  assert.deepEqual(parsePortableHandoffState(review), review)
  assert.equal(parsePortableHandoffState({
    ...review,
    project: {
      ...review.project,
      evidence: { ...review.project.evidence, exactWorkspace: true }
    }
  }), null)
})
