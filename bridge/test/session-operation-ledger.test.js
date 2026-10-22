import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { SessionOperationLedger, runIdempotentMutation } from "../src/session-operation-ledger.js"

function input(overrides = {}) {
  return {
    agentID: "codex",
    sessionID: "native-1",
    clientRequestId: "request-1",
    signature: "signature-1",
    ...overrides
  }
}

test("accepted native Session prompt survives daemon restart and deduplicates retry", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-ledger-"))
  try {
    const first = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    assert.equal((await first.begin(input())).duplicate, false)
    await first.accept(input())

    const restarted = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    const replay = await restarted.begin(input())
    assert.equal(replay.duplicate, true)
    assert.equal(replay.state, "accepted")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("accepted operation result survives restart so resource-creating retries return the same native Session", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-result-"))
  try {
    const first = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    await first.begin(input())
    await first.accept({
      agentID: "codex",
      sessionID: "native-1",
      clientRequestId: "request-1",
      result: {
        target: {
          machineID: "machine-1",
          agentID: "pi",
          sessionID: "pi-native-2",
          directory: "/repo"
        }
      }
    })

    const restarted = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    const replay = await restarted.begin(input())
    assert.equal(replay.duplicate, true)
    assert.equal(replay.state, "accepted")
    assert.deepEqual(replay.entry.result, {
      target: {
        machineID: "machine-1",
        agentID: "pi",
        sessionID: "pi-native-2",
        directory: "/repo"
      }
    })

    const copy = await restarted.get(input())
    copy.result.target.sessionID = "mutated"
    assert.equal((await restarted.get(input())).result.target.sessionID, "pi-native-2", "ledger results must not leak mutable internal state")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("pending operation survives restart and is never automatically replayed", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-pending-"))
  try {
    const first = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    await first.begin(input())

    const restarted = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    const replay = await restarted.begin(input())
    assert.equal(replay.duplicate, true)
    assert.equal(replay.state, "pending")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("same client request id cannot be reused for different prompt payload", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-conflict-"))
  try {
    const ledger = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    await ledger.begin(input())
    await assert.rejects(
      () => ledger.begin(input({ signature: "different-signature" })),
      (error) => error.code === "idempotency_conflict"
    )
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("uncertain operation recovery hint survives restart", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-recovery-hint-"))
  try {
    const first = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    await first.begin(input())
    const recovery = {
      kind: "native-session-handoff-create",
      targetAgentID: "pi",
      directory: "/repo",
      beforeSessionIDs: ["pi-old-1"]
    }
    await first.fail({
      agentID: "codex",
      sessionID: "native-1",
      clientRequestId: "request-1",
      ambiguous: true,
      result: recovery
    })

    const restarted = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    const replay = await restarted.begin(input())
    assert.equal(replay.duplicate, true)
    assert.equal(replay.state, "uncertain")
    assert.deepEqual(replay.entry.result, recovery)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("safe pre-dispatch failure removes the pending record while ambiguous failure preserves it", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-failure-"))
  try {
    const ledger = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    await ledger.begin(input())
    await ledger.fail({ agentID: "codex", sessionID: "native-1", clientRequestId: "request-1", ambiguous: false })
    assert.equal(await ledger.get(input()), undefined)

    const uncertain = input({ clientRequestId: "request-2" })
    await ledger.begin(uncertain)
    await ledger.fail({ agentID: uncertain.agentID, sessionID: uncertain.sessionID, clientRequestId: uncertain.clientRequestId, ambiguous: true })
    assert.equal((await ledger.get(uncertain)).state, "uncertain")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("runIdempotentMutation executes dispatch and deduplicates retries", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-helper-"))
  try {
    const ledger = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    const opIdentity = { agentID: "codex", sessionID: "native-1", clientRequestId: "req-1" }
    let dispatchCalls = 0
    const first = await runIdempotentMutation({
      operationLedger: ledger,
      identity: opIdentity,
      signature: "sig-1",
      dispatch: async () => {
        dispatchCalls += 1
        return { value: 42 }
      }
    })
    assert.equal(first.status, "accepted")
    assert.equal(first.duplicate, false)
    assert.deepEqual(first.result, { value: 42 })
    assert.equal(dispatchCalls, 1)

    const retry = await runIdempotentMutation({
      operationLedger: ledger,
      identity: opIdentity,
      signature: "sig-1",
      dispatch: async () => {
        dispatchCalls += 1
        return { value: 99 }
      }
    })
    assert.equal(retry.status, "accepted")
    assert.equal(retry.duplicate, true)
    assert.deepEqual(retry.result, { value: 42 })
    assert.equal(dispatchCalls, 1)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("runIdempotentMutation reconciles uncertain operations on retry", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-reconcile-"))
  try {
    const ledger = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    const opIdentity = { agentID: "codex", sessionID: "native-1", clientRequestId: "req-rec" }

    const failed = await runIdempotentMutation({
      operationLedger: ledger,
      identity: opIdentity,
      signature: "sig-rec",
      dispatch: async () => {
        const error = new Error("Ambiguous network timeout")
        error.ambiguous = true
        error.recovery = { candidateID: "target-123" }
        throw error
      }
    })
    assert.equal(failed.status, "uncertain")
    assert.equal(failed.duplicate, false)

    let reconciledCalls = 0
    const recovered = await runIdempotentMutation({
      operationLedger: ledger,
      identity: opIdentity,
      signature: "sig-rec",
      reconcile: async (recovery) => {
        reconciledCalls += 1
        assert.deepEqual(recovery, { candidateID: "target-123" })
        return { targetID: recovery.candidateID, status: "confirmed" }
      },
      dispatch: async () => {
        assert.fail("dispatch should not be called when reconciling duplicate")
      }
    })
    assert.equal(recovered.status, "accepted")
    assert.equal(recovered.duplicate, true)
    assert.deepEqual(recovered.result, { targetID: "target-123", status: "confirmed" })
    assert.equal(reconciledCalls, 1)

    const stored = await ledger.get(opIdentity)
    assert.equal(stored.state, "accepted")
    assert.deepEqual(stored.result, { targetID: "target-123", status: "confirmed" })
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("runIdempotentMutation preserves checkpoint() if dispatch fails afterward", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-checkpoint-"))
  try {
    const ledger = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    const opIdentity = { agentID: "codex", sessionID: "native-1", clientRequestId: "req-cp" }

    const first = await runIdempotentMutation({
      operationLedger: ledger,
      identity: opIdentity,
      signature: "sig-cp",
      dispatch: async ({ checkpoint }) => {
        await checkpoint({ createdID: "resource-99" })
        throw new Error("Post-checkpoint naming error")
      }
    })
    assert.equal(first.status, "accepted")
    assert.equal(first.duplicate, false)
    assert.deepEqual(first.result, { createdID: "resource-99" })

    const retry = await runIdempotentMutation({
      operationLedger: ledger,
      identity: opIdentity,
      signature: "sig-cp",
      dispatch: async () => {
        assert.fail("dispatch should not run on duplicate")
      }
    })
    assert.equal(retry.status, "accepted")
    assert.equal(retry.duplicate, true)
    assert.deepEqual(retry.result, { createdID: "resource-99" })
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("runIdempotentMutation rethrows safe pre-dispatch errors and detects signature conflicts", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-errors-"))
  try {
    const ledger = new SessionOperationLedger({ machineID: "machine-1", stateDirectory })
    const opIdentity = { agentID: "codex", sessionID: "native-1", clientRequestId: "req-safe" }

    await assert.rejects(
      () => runIdempotentMutation({
        operationLedger: ledger,
        identity: opIdentity,
        signature: "sig-1",
        dispatch: async () => {
          throw new Error("Pre-dispatch validation failed")
        }
      }),
      /Pre-dispatch validation failed/
    )
    assert.equal(await ledger.get(opIdentity), undefined)

    const accepted = await runIdempotentMutation({
      operationLedger: ledger,
      identity: opIdentity,
      signature: "sig-1",
      dispatch: async () => ({ ok: true })
    })
    assert.equal(accepted.status, "accepted")

    await assert.rejects(
      () => runIdempotentMutation({
        operationLedger: ledger,
        identity: opIdentity,
        signature: "sig-CONFLICT",
        dispatch: async () => ({ ok: false })
      }),
      (error) => error?.code === "idempotency_conflict"
    )
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
