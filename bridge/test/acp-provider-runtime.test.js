import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { acpProviderEnvironment, createAcpProviderRuntime, resolveAcpProviderIDs, resolveAcpProviderLaunch } from "../src/acp-provider-runtime.js"
import { defineAcpProvider } from "../src/acp-provider-kit.js"
import { HARNESS_PROFILES } from "../src/harness-profiles.js"

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

test("npx adapters use a per-harness daemon cache while native adapters keep their environment", () => {
  const configured = provider({ environment: { CODEX_PATH: "/tools/codex" } })
  const config = { stateDirectory: "/state" }
  assert.deepEqual(acpProviderEnvironment(configured, { command: "npx", args: [] }, config), {
    CODEX_PATH: "/tools/codex",
    npm_config_cache: path.join("/state", "npm-cache", "example")
  })
  assert.deepEqual(acpProviderEnvironment(configured, { command: "C:\\node\\npx.cmd", args: [] }, config), {
    CODEX_PATH: "/tools/codex",
    npm_config_cache: path.join("/state", "npm-cache", "example")
  })
  assert.equal(acpProviderEnvironment(provider(), { command: "omp", args: ["acp"] }, config), undefined)
  // An operator can still pin one harness to a specific cache.
  const pinned = provider({ environment: { npm_config_cache: "/custom/cache" } })
  assert.deepEqual(acpProviderEnvironment(pinned, { command: "npx", args: [] }, config), {
    npm_config_cache: "/custom/cache"
  })
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
  let historyLaunch
  const p = provider({
    modelVariantDefaultValues: ["default"],
    createHistoryLoader(launch) { historyLaunch = launch; return historyLoader }
  })
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
      preferredAuthMethod: "example-auth",
      authenticate: true
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
  assert.deepEqual(historyLaunch, launch)
  assert.equal(registration.serviceOptions.hiddenSessionIDs, runtime.modelCatalog.hiddenSessionIDs)
  assert.equal(registration.serviceOptions.reloadOnHistoryRefresh, false)
  assert.equal(registration.serviceOptions.replaySettleMs, 125)
  assert.equal(registration.serviceOptions.promptSettleMs, 250)
  assert.deepEqual(registration.serviceOptions.modelVariantDefaultValues, ["default"])
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

test("npx ACP clients for one harness share a cache but never start an install at the same time", async () => {
  const clients = []
  let active = 0
  let peak = 0
  class FakeClient {
    constructor(options) { this.options = options; clients.push(this) }
    async start() {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
    }
  }
  class FakeCatalog {
    constructor(options) { this.options = options; this.hiddenSessionIDs = new Set() }
    async preloadState() {}
  }
  const runtime = await createAcpProviderRuntime({
    provider: provider({ environment: { CODEX_PATH: "/tools/codex" } }),
    launch: { command: "npx", args: ["--yes", "example-acp"] },
    config: { roots: [], stateDirectory: "/state" },
    Client: FakeClient,
    ModelCatalog: FakeCatalog
  })
  assert.equal(clients.length, 2)
  assert.equal(clients[0].options.environment.CODEX_PATH, "/tools/codex")
  assert.equal(clients[1].options.environment.CODEX_PATH, "/tools/codex")
  assert.equal(clients[0].options.environment.npm_config_cache, path.join("/state", "npm-cache", "example"))
  assert.equal(clients[1].options.environment.npm_config_cache, path.join("/state", "npm-cache", "example"))
  assert.equal(runtime.modelCatalog.options.environment.npm_config_cache, path.join("/state", "npm-cache", "example"))

  // The user-facing and catalog clients start in parallel on first use; two installs must not.
  await Promise.all([runtime.agent.start(), runtime.modelCatalog.options.agent.start()])
  assert.equal(peak, 1, "npx launches must be serialized")
  assert.equal(active, 0)
})

test("npx cold starts and model discovery honor the provider startup budget", async () => {
  assert.equal(HARNESS_PROFILES.deepseek.packageStartupTimeoutMs, 240_000)
  assert.equal(HARNESS_PROFILES.opencode2.packageStartupTimeoutMs, undefined)
  for (const command of ["npx", "C:\\Program Files\\nodejs\\npx.cmd"]) {
    const starts = []
    class FakeClient {
      async start(timeoutMs) { starts.push(timeoutMs) }
    }
    class FakeCatalog {
      constructor(options) { this.options = options; this.hiddenSessionIDs = new Set() }
      async preloadState() {}
    }
    const runtime = await createAcpProviderRuntime({
      provider: provider({ packageStartupTimeoutMs: 240_000 }),
      launch: { command, args: ["example-acp"] },
      config: { roots: [], stateDirectory: "/state" },
      Client: FakeClient,
      ModelCatalog: FakeCatalog
    })
    await runtime.agent.start()
    assert.deepEqual(starts, [240_000], command)
    assert.equal(runtime.modelCatalog.options.timeoutMs, 240_000, command)
  }
})

test("npx startup repairs an incomplete entry in its daemon-owned cache and retries once", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "acp-npx-repair-"))
  const cache = path.join(stateDirectory, "npm-cache", "example")
  const broken = path.join(cache, "_npx", "broken")
  const healthy = path.join(cache, "_npx", "healthy")
  await mkdir(path.join(broken, "node_modules"), { recursive: true })
  await mkdir(healthy, { recursive: true })
  await writeFile(path.join(healthy, "package.json"), "{}")
  let starts = 0
  class FakeClient {
    async start() {
      starts += 1
      if (starts === 1) throw new Error("npm error enoent Could not read package.json")
    }
  }
  class FakeCatalog {
    constructor(options) { this.options = options; this.hiddenSessionIDs = new Set() }
    async preloadState() {}
  }
  try {
    const runtime = await createAcpProviderRuntime({
      provider: provider(),
      launch: { command: "npx", args: [] },
      config: { roots: [], stateDirectory },
      Client: FakeClient,
      ModelCatalog: FakeCatalog
    })
    await runtime.agent.start()
    assert.equal(starts, 2)
    await assert.rejects(access(broken), { code: "ENOENT" })
    await access(path.join(healthy, "package.json"))
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("a slow npx harness cannot block another harness from starting", async () => {
  let releaseSlowStart
  const slowStart = new Promise((resolve) => { releaseSlowStart = resolve })
  let slowStarted
  const slowEntered = new Promise((resolve) => { slowStarted = resolve })
  let fastStarted = false
  class FakeClient {
    constructor(options) { this.options = options }
    async start() {
      if (this.options.environment.npm_config_cache.endsWith(`${path.sep}slow`)) {
        slowStarted()
        await slowStart
      } else {
        fastStarted = true
      }
    }
  }
  class FakeCatalog {
    constructor(options) { this.options = options; this.hiddenSessionIDs = new Set() }
    async preloadState() {}
  }
  const config = { roots: [], stateDirectory: "/state" }
  const launch = { command: "npx", args: [] }
  const slow = await createAcpProviderRuntime({ provider: provider({ id: "slow" }), launch, config, Client: FakeClient, ModelCatalog: FakeCatalog })
  const fast = await createAcpProviderRuntime({ provider: provider({ id: "fast" }), launch, config, Client: FakeClient, ModelCatalog: FakeCatalog })
  const pendingSlow = slow.agent.start()
  try {
    await slowEntered
    await fast.agent.start()
    assert.equal(fastStarted, true)
  } finally {
    releaseSlowStart()
    await pendingSlow
  }
})

test("native ACP adapters start without waiting behind an npx install", async () => {
  const starts = []
  class FakeClient {
    constructor(options) { this.options = options }
    async start() { starts.push(this.options.command) }
  }
  class FakeCatalog {
    constructor(options) { this.options = options; this.hiddenSessionIDs = new Set() }
    async preloadState() {}
  }
  const runtime = await createAcpProviderRuntime({
    provider: provider(),
    launch: { command: "omp", args: ["acp"] },
    config: { roots: [], stateDirectory: "/state" },
    Client: FakeClient,
    ModelCatalog: FakeCatalog
  })
  await Promise.all([runtime.agent.start(), runtime.modelCatalog.options.agent.start()])
  assert.deepEqual(starts, ["omp", "omp"])
})
