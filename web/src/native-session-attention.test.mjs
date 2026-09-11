import assert from "node:assert/strict"
import test from "node:test"
import { classifyNativeSessionAttention, sessionNeedsAttention } from "./native-session-attention.ts"

const permission = {
  id: "perm-1",
  sessionID: "session-1",
  permission: "edit",
  patterns: ["src/**"],
  metadata: {},
  always: []
}

const question = {
  id: "question-1",
  sessionID: "session-1",
  questions: [{ question: "Which option?", header: "Choice", options: [] }]
}

test("explicit permission outranks every status and is fail-closed authorization", () => {
  assert.deepEqual(classifyNativeSessionAttention({
    status: { type: "working" },
    permissions: [permission],
    questions: [question]
  }), {
    kind: "authorization",
    requiresUserAction: true,
    failClosed: true,
    reason: "permission"
  })
})

test("rejected or denied states remain distinct from retryable attention", () => {
  for (const type of ["rejected", "permission-denied", "forbidden", "fail_closed"]) {
    const state = classifyNativeSessionAttention({ status: { type } })
    assert.equal(state.kind, "rejected", type)
    assert.equal(state.failClosed, true, type)
    assert.equal(state.requiresUserAction, false, type)
  }
})

test("a harness question is recoverable attention and remains blocked for user input", () => {
  assert.deepEqual(classifyNativeSessionAttention({ questions: [question] }), {
    kind: "recoverable",
    requiresUserAction: true,
    failClosed: true,
    reason: "question"
  })
})

test("known failure and connectivity statuses are recoverable attention", () => {
  for (const type of ["error", "failed", "needs-attention", "blocked", "disconnected", "offline"]) {
    assert.equal(classifyNativeSessionAttention({ status: { type } }).kind, "recoverable", type)
    assert.equal(sessionNeedsAttention({ status: { type } }), true, type)
  }
})

test("completion is informational instead of attention", () => {
  for (const type of ["completed", "done", "finished", "succeeded"]) {
    const state = classifyNativeSessionAttention({ status: { type } })
    assert.equal(state.kind, "informational", type)
    assert.equal(state.requiresUserAction, false, type)
    assert.equal(sessionNeedsAttention({ status: { type } }), false, type)
  }
})

test("working waiting retry and unknown states are not promoted into attention", () => {
  for (const type of ["working", "waiting", "retry", "busy", "running", "in_progress", "ready", "something-new"]) {
    const state = classifyNativeSessionAttention({ status: { type } })
    assert.equal(state.kind, "none", type)
    assert.equal(sessionNeedsAttention({ status: { type } }), false, type)
  }
})
