import assert from "node:assert/strict"
import test from "node:test"
import { nativeSessionReviewEvidence } from "./native-session-review-evidence.ts"

function conversation(overrides = {}) {
  const currentTurn = {
    id: "turn-1",
    sequence: 1,
    prompt: "Implement the review surface",
    status: "completed",
    finishedAt: "2026-09-12T06:00:00.000Z",
    ...overrides.currentTurn
  }
  return {
    id: "native-session-v3:machine:codex:s1",
    machineId: "machine",
    title: "Review surface",
    agentId: "codex",
    initialPrompt: currentTurn.prompt,
    status: "completed",
    directory: "/repo",
    currentTurn,
    turns: [currentTurn],
    createdAt: "2026-09-12T05:00:00.000Z",
    updatedAt: "2026-09-12T06:00:00.000Z",
    finishedAt: "2026-09-12T06:00:00.000Z",
    ...overrides,
    currentTurn: overrides.currentTurn === null ? null : currentTurn,
    turns: overrides.turns ?? [currentTurn]
  }
}

const verifiedNoAttention = { complete: true, questions: 0, permissions: 0 }

test("target authorization outranks an otherwise completed turn", () => {
  const evidence = nativeSessionReviewEvidence(conversation(), { complete: true, questions: 0, permissions: 2 })
  assert.equal(evidence.state, "authorization")
  assert.equal(evidence.label, "Needs authorization")
  assert.match(evidence.summary, /2 target-side authorization requests/)
})

test("structured questions surface as required input", () => {
  const evidence = nativeSessionReviewEvidence(conversation(), { complete: true, questions: 1, permissions: 0 })
  assert.equal(evidence.state, "input")
  assert.match(evidence.nextAction, /Answer the pending question/)
})

test("runtime failure uses structured error metadata and never transcript prose", () => {
  const evidence = nativeSessionReviewEvidence(conversation({
    status: "failed",
    error: { message: "Provider rejected the selected model" },
    currentTurn: { status: "failed", error: { message: "Provider rejected the selected model" }, finishedAt: "2026-09-12T06:00:00.000Z" }
  }), { complete: false, questions: 0, permissions: 0 })
  assert.equal(evidence.state, "failed")
  assert.equal(evidence.detail, "Provider rejected the selected model")
})

test("cancelled runtime remains visibly stopped", () => {
  const evidence = nativeSessionReviewEvidence(conversation({ status: "cancelled", currentTurn: { status: "cancelled" } }), verifiedNoAttention)
  assert.equal(evidence.state, "stopped")
})

test("completed is withheld until pending attention has been checked", () => {
  assert.equal(nativeSessionReviewEvidence(conversation(), { complete: false, questions: 0, permissions: 0 }), null)
  assert.equal(nativeSessionReviewEvidence(conversation(), verifiedNoAttention).state, "completed")
})

test("an empty historical Session is not labeled completed", () => {
  const empty = conversation({
    initialPrompt: "",
    currentTurn: { prompt: "" },
    turns: []
  })
  assert.equal(nativeSessionReviewEvidence(empty, verifiedNoAttention), null)
})

test("running work is not presented as a finished outcome", () => {
  const running = conversation({
    status: "running",
    finishedAt: null,
    currentTurn: { status: "running", finishedAt: undefined }
  })
  assert.equal(nativeSessionReviewEvidence(running, verifiedNoAttention), null)
})
