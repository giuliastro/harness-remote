import assert from "node:assert/strict"
import test from "node:test"
import { targetCreationLedgerIdentity } from "../src/cross-machine-handoff-server.js"

const source = {
  machineID: "machine-a",
  agentID: "codex",
  sessionID: "native-1",
  directory: "/source/repo"
}

function input(overrides = {}) {
  return {
    clientRequestId: "request-1",
    source,
    projectId: "machine-b:repo",
    targetAgentID: "pi",
    model: { providerID: "openai", modelID: "gpt-5.6-codex" },
    variant: "high",
    title: "Continue work",
    ...overrides
  }
}

test("target semantics stay in the signature rather than changing the durable ledger key", () => {
  const first = targetCreationLedgerIdentity(input())
  const changedTarget = targetCreationLedgerIdentity(input({
    targetAgentID: "omp",
    projectId: "machine-b:other-repo",
    model: { providerID: "other", modelID: "other-model" },
    variant: "low",
    title: "Different target"
  }))

  assert.deepEqual(changedTarget, first)
  assert.equal(first.agentID, "cross-machine-handoff")
  assert.match(first.sessionID, /^handoff-source:[a-f0-9]{64}$/)
  assert.equal(first.sessionID.includes(source.directory), false)
})

test("source identity and client request id remain part of the durable ledger scope", () => {
  const first = targetCreationLedgerIdentity(input())
  const otherMachine = targetCreationLedgerIdentity(input({ source: { ...source, machineID: "machine-c" } }))
  const otherRequest = targetCreationLedgerIdentity(input({ clientRequestId: "request-2" }))

  assert.notEqual(otherMachine.sessionID, first.sessionID)
  assert.equal(otherMachine.agentID, first.agentID)
  assert.notEqual(otherRequest.clientRequestId, first.clientRequestId)
})
