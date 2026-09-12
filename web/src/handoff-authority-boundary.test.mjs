import assert from "node:assert/strict"
import test from "node:test"
import { classifyNativeSessionAttention } from "./native-session-attention.ts"
import { parsePortableHandoffState } from "./portable-handoff-state.ts"

const portableBoundary = {
  version: 1,
  task: { title: "Deploy the reviewed change", state: "continuing" },
  project: {
    sourceProjectId: "source-project",
    targetProjectId: "target-project",
    decision: "automatic",
    reason: "exact_workspace",
    evidence: {
      project: "match",
      repository: "match",
      history: "match",
      branch: "match",
      head: "match",
      sourceDirty: false,
      targetDirty: false,
      exactWorkspace: true
    }
  },
  controls: {
    sourceAuthority: "invalidated",
    targetAuthorization: "re_evaluate",
    attachments: "not_transferred"
  }
}

test("source approval-like metadata is context only and cannot become target authority", () => {
  const recovered = parsePortableHandoffState({
    ...portableBoundary,
    approvedAction: {
      permission: "shell",
      decision: "allow_always",
      patterns: ["deploy/**"]
    },
    writerOwnership: "source-session",
    credentials: "source-secret"
  })

  assert.ok(recovered, "the safe portable subset should still be recoverable")
  assert.deepEqual(recovered.controls, {
    sourceAuthority: "invalidated",
    targetAuthorization: "re_evaluate",
    attachments: "not_transferred"
  })
  assert.equal(Object.hasOwn(recovered, "approvedAction"), false)
  assert.equal(Object.hasOwn(recovered, "writerOwnership"), false)
  assert.equal(Object.hasOwn(recovered, "credentials"), false)
})

test("a sensitive target action remains independently blocked on its native permission request", () => {
  const recovered = parsePortableHandoffState(portableBoundary)
  assert.ok(recovered)
  assert.equal(recovered.controls.targetAuthorization, "re_evaluate")

  const targetAttention = classifyNativeSessionAttention({
    status: { type: "busy" },
    permissions: [{
      id: "target-permission-1",
      sessionID: "target-session",
      permission: "shell",
      patterns: ["deploy/**"],
      metadata: { reason: "Deploy requires target-machine authorization" },
      always: []
    }]
  })

  assert.deepEqual(targetAttention, {
    kind: "authorization",
    requiresUserAction: true,
    failClosed: true,
    reason: "permission"
  })
})

test("portable state that claims inherited authority is rejected at the handoff boundary", () => {
  const inheritedAuthority = {
    ...portableBoundary,
    controls: {
      ...portableBoundary.controls,
      sourceAuthority: "preserved",
      targetAuthorization: "inherited"
    }
  }

  assert.equal(parsePortableHandoffState(inheritedAuthority), null)
})
