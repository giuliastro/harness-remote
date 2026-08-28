import assert from "node:assert/strict"
import test from "node:test"
import { acpHarnessCapabilityContract, openCodeCapabilityContract } from "../src/harness-capability-contract.js"
import { harnessProfile } from "../src/harness-profiles.js"

test("ACP capability contract preserves runtime-specific model controls without inventing them", () => {
  const omp = acpHarnessCapabilityContract(harnessProfile("omp"))
  const pi = acpHarnessCapabilityContract(harnessProfile("pi"))
  const codex = acpHarnessCapabilityContract(harnessProfile("codex"))
  const claude = acpHarnessCapabilityContract(harnessProfile("claude"))

  for (const contract of [omp, pi, codex, claude]) {
    assert.equal(contract.version, 2)
    assert.equal(contract.protocol, "acp")
    assert.equal(contract.transport.control, "stdio-json-rpc")
    assert.equal(contract.models.cacheScope, "machine")
    assert.equal(contract.lifecycle.sessionAuthority, "native-harness")
    assert.equal(contract.sessions.authority, "native-harness")
    assert.equal(contract.sessions.discovery, "native-list")
  }

  assert.ok(omp.models.variantConfigIDs.includes("thinking"))
  assert.ok(pi.models.variantConfigIDs.some((id) => ["thinkingLevel", "thinking_level", "thinking"].includes(id)))
  assert.ok(codex.models.variantConfigIDs.some((id) => ["reasoning_effort", "reasoningEffort"].includes(id)))
  assert.deepEqual(claude.models.variantConfigIDs, [])
  assert.equal(claude.models.variants, "runtime-advertised-only")
})

test("Session-first contract separates discovery, transcript reads and writer acquisition per ACP harness", () => {
  const omp = acpHarnessCapabilityContract(harnessProfile("omp"))
  const pi = acpHarnessCapabilityContract(harnessProfile("pi"))
  const codex = acpHarnessCapabilityContract(harnessProfile("codex"))
  const claude = acpHarnessCapabilityContract(harnessProfile("claude"))

  assert.equal(codex.sessions.transcript, "native-journal")
  assert.equal(codex.sessions.externalWriterObservation, "supported-via-journal")
  assert.equal(codex.sessions.writerOwnership, "single-writer")
  assert.equal(codex.sessions.continuation, "session-load")

  assert.equal(pi.sessions.transcript, "native-journal-authoritative")
  assert.equal(pi.sessions.externalWriterObservation, "supported-via-journal")
  assert.equal(pi.sessions.writerOwnership, "claim-on-session-load")

  assert.equal(omp.sessions.transcript, "native-journal")
  assert.equal(omp.sessions.externalWriterObservation, "unverified-via-journal")
  assert.equal(omp.sessions.writerOwnership, "adapter-defined")

  assert.equal(claude.sessions.transcript, "session-load")
  assert.equal(claude.sessions.externalWriterObservation, "unverified-session-load")
  assert.equal(claude.sessions.writerOwnership, "adapter-defined")

  for (const contract of [omp, pi, codex, claude]) {
    assert.equal(contract.sessions.stop, "owned-session-native-cancel")
  }
})

test("OpenCode capability contract describes daemon-owned SSE fanout and native HTTP Sessions", () => {
  const contract = openCodeCapabilityContract()
  assert.equal(contract.version, 2)
  assert.equal(contract.protocol, "opencode-http")
  assert.equal(contract.transport.control, "http-json")
  assert.equal(contract.transport.events, "sse-daemon-fanout")
  assert.equal(contract.toolCalls.representation, "opencode-message-parts")
  assert.equal(contract.models.source, "runtime-provider-api")
  assert.equal(contract.models.cacheScope, "machine")
  assert.equal(contract.models.variants, "provider-advertised")
  assert.equal(contract.lifecycle.sessionAuthority, "native-harness")
  assert.equal(contract.sessions.authority, "native-harness")
  assert.equal(contract.sessions.discovery, "native-http")
  assert.equal(contract.sessions.transcript, "native-http")
  assert.equal(contract.sessions.externalWriterObservation, "native-http-server")
  assert.equal(contract.sessions.continuation, "native-session-id")
  assert.equal(contract.sessions.writerOwnership, "native-http-server")
  assert.equal(contract.sessions.stop, "native-abort")
})
