import assert from "node:assert/strict"
import test from "node:test"
import { createAcpProviderRegistry, defineAcpProvider } from "../src/acp-provider-kit.js"
import { acpHarnessCapabilityContract } from "../src/harness-capability-contract.js"
import { listAcpProviderProfiles } from "../src/harness-profiles.js"

function exampleProvider(overrides = {}) {
  return defineAcpProvider({
    id: "example",
    label: "Example ACP",
    command: "example-acp",
    args: ["serve"],
    permissionMode: "allow",
    modelVariantConfigIDs: ["reasoning"],
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
      models: true,
      questions: false,
      permissions: false
    },
    ...overrides
  })
}

test("provider kit validates and registers a standards-compatible ACP descriptor", () => {
  const provider = exampleProvider()
  const registry = createAcpProviderRegistry([provider])

  assert.equal(registry.get("example"), provider)
  assert.equal(registry.has("example"), true)
  assert.deepEqual(registry.ids(), ["example"])
  assert.deepEqual(registry.list(), [provider])
  assert.throws(() => registry.get("missing"), /Unsupported backend: missing/)
})

test("provider registry rejects duplicate ids", () => {
  const provider = exampleProvider()
  assert.throws(
    () => createAcpProviderRegistry([provider, exampleProvider()]),
    /Duplicate ACP provider id: example/
  )
})

test("provider descriptor carries an explicit authentication policy", () => {
  assert.equal(exampleProvider().authenticate, true)
  assert.equal(exampleProvider({ authenticate: false }).authenticate, false)
  assert.throws(() => exampleProvider({ authenticate: "no" }), /authenticate must be a boolean/)
})

test("provider descriptor requires explicit capabilities and Session semantics", () => {
  assert.throws(() => defineAcpProvider({
    id: "missing-session",
    label: "Missing Session",
    command: "missing-session",
    args: [],
    capabilities: { sessions: true }
  }), /must declare a Session contract/)

  assert.throws(() => defineAcpProvider({
    id: "missing-capabilities",
    label: "Missing Capabilities",
    command: "missing-capabilities",
    args: [],
    sessionContract: exampleProvider().sessionContract
  }), /must declare capabilities/)
})

test("generic ACP capability contract consumes provider-declared Session semantics without harness-name logic", () => {
  const provider = exampleProvider({
    sessionContract: {
      authority: "native-harness",
      discovery: "native-list",
      transcript: "provider-journal",
      externalWriterObservation: "provider-defined",
      continuation: "provider-resume",
      writerOwnership: "provider-lock",
      stop: "provider-cancel"
    }
  })

  const contract = acpHarnessCapabilityContract(provider)
  assert.equal(contract.protocol, "acp")
  assert.equal(contract.sessions.transcript, "provider-journal")
  assert.equal(contract.sessions.externalWriterObservation, "provider-defined")
  assert.equal(contract.sessions.continuation, "provider-resume")
  assert.equal(contract.sessions.writerOwnership, "provider-lock")
  assert.equal(contract.sessions.stop, "provider-cancel")
  assert.deepEqual(contract.models.variantConfigIDs, ["reasoning"])
})

test("existing ACP harnesses are exposed through the same provider registry", () => {
  const providers = listAcpProviderProfiles()
  assert.deepEqual(providers.map((provider) => provider.id), ["omp", "pi", "claude", "copilot", "opencode2", "mimo", "codex"])
  assert.deepEqual(providers.map((provider) => provider.detectCommands), [["omp"], ["pi"], ["claude"], ["copilot"], ["opencode2"], ["mimo"], ["codex"]])
  assert.deepEqual(
    providers.slice().sort((left, right) => left.launchPriority - right.launchPriority).map((provider) => provider.id),
    ["codex", "claude", "omp", "pi", "copilot", "opencode2", "mimo"]
  )
  for (const provider of providers) {
    assert.ok(provider.sessionContract)
    assert.equal(provider.capabilities.sessions, true)
  }
})
