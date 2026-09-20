import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { createAcpProviderRuntime, resolveAcpProviderIDs, resolveAcpProviderLaunch } from "../src/acp-provider-runtime.js"
import { defineAcpProvider } from "../src/acp-provider-kit.js"

function provider(overrides = {}) {
  return defineAcpProvider({
    id: "example",
    label: "Example ACP",
    command: "example-acp",
    args: ["serve"],
    permissionMode: "allow",
    authMethod: "example-auth",
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
      models: true
    },
    reloadOnHistoryRefresh: false,
    replaySettleMs: 125,
    promptSettleMs: 250,
    ...overrides
  })
}

test("provider runtime membership keeps detected ACP providers and selected primary exactly once", () => {
  assert.deepEqual(
    resolveAcpProviderIDs(["claude", "codex", "opencode", "codex"], "claude"),
    ["claude", "codex"]
  )
  assert.deepEqual(resolveAcpProviderIDs([], "codex"), ["codex"])
})

test("provider launch preserves an explicit primary ACP command and delegates managed providers", () => {
  const p = provider()
  const config = { acpCommand: "/tools/custom-acp", acpArgs: ["--stdio"] }
  assert.deepEqual(resolveAcpProviderLaunch(p, { primary: true, config }), {
    command: "/tools/custom-acp",
    args: ["--stdio"]
  })

  let resolved
  assert.deepEqual(resolveAcpProviderLaunch(p, {
    primary: false,
    config,
    resolveLaunch(value) {
      resolved = value
      return { command: "/tools/managed-acp", args: ["run"], source: "test" }
    }
  }), { command: "/tools/managed-acp", args: ["run"], source: "test" })
  assert.equal(resolved, p)
})

test("provider runtime builds separate user and model ACP clients and a complete daemon registration", async () => {
  const clients = []
  class FakeClient {
    constructor(options) {
      this.options = options
      clients.push(this)
    }
  }

  let preloadCount = 0
  class FakeCatalog {
    constructor(options) {
      this.options = options
      this.hiddenSessionIDs = new Set(["technical-session"])
    }
    async preloadState() {
      preloadCount += 1
    }
  }

  const historyLoader = async () => []
  const p = provider({ historyLoader })
  const config = {
    backend: "primary",
    roots: ["/work/project"],
    stateDirectory: "/state",
    acpCommand: "unused",
    acpArgs: []
  }
  const launch = { command: "/tools/example-acp", args: ["serve", "--stdio"] }

  const runtime = await createAcpProviderRuntime({
    provider: p,
    launch,
    config,
    Client: FakeClient,
    ModelCatalog: FakeCatalog,
    cwd: "/fallback"
  })

  assert.equal(clients.length, 2)
  assert.notEqual(clients[0], clients[1])
  for (const client of clients) {
    assert.deepEqual(client.options, {
      command: "/tools/example-acp",
      args: ["serve", "--stdio"],
      permissionMode: "allow",
      preferredAuthMethod: "example-auth"
    })
  }

  assert.equal(preloadCount, 1)
  assert.equal(runtime.modelCatalog.options.agent, clients[1])
  assert.equal(runtime.modelCatalog.options.agentID, "example")
  assert.equal(runtime.modelCatalog.options.directory, "/work/project")
  assert.equal(runtime.modelCatalog.options.stateDirectory, "/state")
  assert.deepEqual(runtime.modelCatalog.options.variantConfigIDs, ["reasoning"])

  const registration = runtime.registration
  assert.equal(registration.id, "example")
  assert.equal(registration.label, "Example ACP")
  assert.equal(registration.agent, clients[0])
  assert.equal(registration.modelCatalog, runtime.modelCatalog)
  assert.equal(registration.bridgeConfig.backend, "example")
  assert.equal(registration.bridgeConfig.acpCommand, "/tools/example-acp")
  assert.deepEqual(registration.bridgeConfig.acpArgs, ["serve", "--stdio"])
  assert.equal(registration.serviceOptions.snapshotDirectory, path.join("/state", "example"))
  assert.equal(registration.serviceOptions.historyLoader, historyLoader)
  assert.equal(registration.serviceOptions.hiddenSessionIDs, runtime.modelCatalog.hiddenSessionIDs)
  assert.equal(registration.serviceOptions.reloadOnHistoryRefresh, false)
  assert.equal(registration.serviceOptions.replaySettleMs, 125)
  assert.equal(registration.serviceOptions.promptSettleMs, 250)
  assert.equal(registration.contract.protocol, "acp")
  assert.equal(registration.contract.sessions.transcript, "session-load")
})

test("provider runtime falls back to cwd when no project root is configured", async () => {
  class FakeClient {
    constructor(options) { this.options = options }
  }
  class FakeCatalog {
    constructor(options) {
      this.options = options
      this.hiddenSessionIDs = new Set()
    }
    async preloadState() {}
  }

  const runtime = await createAcpProviderRuntime({
    provider: provider(),
    launch: { command: "example-acp", args: [] },
    config: { roots: [], stateDirectory: "/state" },
    Client: FakeClient,
    ModelCatalog: FakeCatalog,
    cwd: "/fallback"
  })

  assert.equal(runtime.modelCatalog.options.directory, "/fallback")
})
