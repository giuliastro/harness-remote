import assert from "node:assert/strict"
import test from "node:test"
import { defineAcpProvider } from "../src/acp-provider-kit.js"
import { listAcpProviderProfiles } from "../src/harness-profiles.js"
import { exerciseAcpProviderLifecycle } from "./support/acp-provider-lifecycle-fixture.js"

function exampleProvider(overrides = {}) {
  return defineAcpProvider({
    id: "fixture",
    label: "Fixture ACP",
    command: "fixture-acp",
    args: [],
    detectCommands: ["fixture"],
    launchPriority: 50,
    lifecycleContract: {
      sessionAuthority: "native-harness",
      create: "native-session",
      resume: "native-session-when-supported",
      stop: "native-abort",
      reconnect: "daemon-reconciliation"
    },
    sessionContract: {
      authority: "native-harness",
      discovery: "native-list",
      transcript: "session-load",
      externalWriterObservation: "unverified",
      continuation: "session-load",
      writerOwnership: "adapter-defined",
      stop: "owned-session-native-cancel"
    },
    capabilities: {
      sessions: true,
      prompt: true,
      abort: true,
      streaming: true,
      models: true
    },
    ...overrides
  })
}

test("provider lifecycle fixture covers startup, crash, restart, and failed restart", async () => {
  const result = await exerciseAcpProviderLifecycle(exampleProvider())

  assert.deepEqual(result.states, [
    "configured",
    "available",
    "unavailable",
    "available",
    "unavailable"
  ])
  assert.equal(result.starts, 3)
  assert.match(result.restartError?.message ?? "", /fixture start failed/)
  assert.equal(result.contract.lifecycle.reconnect, "daemon-reconciliation")
})

test("all built-in ACP providers satisfy the same reusable lifecycle fixture", async () => {
  for (const provider of listAcpProviderProfiles()) {
    const result = await exerciseAcpProviderLifecycle(provider, {
      launch: { command: `fixture-${provider.id}`, args: [] }
    })

    assert.deepEqual(result.states, [
      "configured",
      "available",
      "unavailable",
      "available",
      "unavailable"
    ], provider.id)
    assert.equal(result.contract.lifecycle.sessionAuthority, "native-harness", provider.id)
    assert.equal(result.contract.lifecycle.reconnect, "daemon-reconciliation", provider.id)
  }
})

test("provider definition rejects missing lifecycle semantics", () => {
  assert.throws(() => defineAcpProvider({
    id: "missing-lifecycle",
    label: "Missing Lifecycle",
    command: "missing-lifecycle",
    args: [],
    detectCommands: ["missing-lifecycle"],
    sessionContract: exampleProvider().sessionContract,
    capabilities: { sessions: true }
  }), /must declare a lifecycle contract/)
})

test("provider-defined lifecycle semantics flow into the advertised capability contract", async () => {
  const provider = exampleProvider({
    lifecycleContract: {
      sessionAuthority: "provider-native",
      create: "provider-create",
      resume: "provider-resume",
      stop: "provider-stop",
      reconnect: "provider-reconcile"
    }
  })
  const result = await exerciseAcpProviderLifecycle(provider)

  assert.deepEqual(result.contract.lifecycle, {
    sessionAuthority: "provider-native",
    create: "provider-create",
    resume: "provider-resume",
    stop: "provider-stop",
    reconnect: "provider-reconcile"
  })
})
