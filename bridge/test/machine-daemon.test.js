import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { MachineDaemon, createMachineDaemonServer } from "../src/machine-daemon.js"

class FakeAcp extends EventEmitter {
  closed = false
  async start() {}
  close() { this.closed = true }
}

class FakeHttpHost extends EventEmitter {
  processID = 5151
  stopped = []
  shouldFail = false
  startImpl

  constructor({ startImpl } = {}) {
    super()
    this.startImpl = startImpl
  }

  async start() {
    if (this.shouldFail) throw new Error("OpenCode failed")
    if (this.startImpl) await this.startImpl()
    this.emit("available")
  }

  stop(signal) {
    this.stopped.push(signal)
    return true
  }
}

test("one machine daemon represents ACP and OpenCode concurrently", async () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const acp = new FakeAcp()
  const openCode = new FakeHttpHost()

  daemon.registerAcpHost({
    id: "codex",
    label: "Codex",
    capabilities: { sessions: true },
    agent: acp
  })
  daemon.registerManagedHttpHost({
    id: "opencode",
    label: "OpenCode",
    capabilities: { sessions: true },
    host: openCode
  })

  let snapshot = daemon.snapshot()
  assert.deepEqual(snapshot.agents.map((host) => [host.id, host.transport, host.state]), [
    ["codex", "acp", "configured"],
    ["opencode", "http", "configured"]
  ])

  const started = await daemon.startManagedHosts()
  assert.deepEqual(started.map(({ id, status }) => [id, status]), [["opencode", "available"]])

  await acp.start()
  snapshot = daemon.snapshot()
  assert.deepEqual(snapshot.agents.map((host) => [host.id, host.state]), [
    ["codex", "available"],
    ["opencode", "available"]
  ])
  assert.equal(snapshot.agents.find((host) => host.id === "opencode").processID, 5151)
})

test("eager managed hosts start concurrently rather than serially", async () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  let firstStarted = false
  let secondStarted = false
  let releaseFirst
  let releaseSecond
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const secondGate = new Promise((resolve) => { releaseSecond = resolve })

  daemon.registerManagedHttpHost({ id: "first", host: new FakeHttpHost({ startImpl: async () => { firstStarted = true; await firstGate } }) })
  daemon.registerManagedHttpHost({ id: "second", host: new FakeHttpHost({ startImpl: async () => { secondStarted = true; await secondGate } }) })

  const starting = daemon.startManagedHosts()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(firstStarted, true)
  assert.equal(secondStarted, true)

  releaseFirst()
  releaseSecond()
  const result = await starting
  assert.deepEqual(result.map(({ id, status }) => [id, status]), [["first", "available"], ["second", "available"]])
})

test("lazy managed hosts stay configured until a real consumer starts them", async () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  let starts = 0
  const openCode = new FakeHttpHost({ startImpl: async () => { starts += 1 } })
  daemon.registerManagedHttpHost({ id: "opencode", host: openCode, eager: false })

  const result = await daemon.startManagedHosts()
  assert.deepEqual(result, [])
  assert.equal(starts, 0)
  assert.equal(daemon.snapshot().agents.find((host) => host.id === "opencode").state, "configured")

  await openCode.start()
  assert.equal(starts, 1)
})

test("one host failure does not erase or stop the other host", async () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const acp = new FakeAcp()
  const openCode = new FakeHttpHost()
  daemon.registerAcpHost({ id: "claude", label: "Claude Code", agent: acp })
  daemon.registerManagedHttpHost({ id: "opencode", label: "OpenCode", host: openCode })
  await acp.start()
  openCode.emit("unavailable", new Error("OpenCode crashed"))
  const snapshot = daemon.snapshot()
  assert.equal(snapshot.agents.find((host) => host.id === "claude").state, "available")
  assert.equal(snapshot.agents.find((host) => host.id === "opencode").state, "unavailable")
  assert.equal(acp.closed, false)
})

test("failed eager startup is isolated and reported in the machine snapshot", async () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const acp = new FakeAcp()
  const openCode = new FakeHttpHost()
  openCode.shouldFail = true
  daemon.registerAcpHost({ id: "codex", agent: acp })
  daemon.registerManagedHttpHost({ id: "opencode", host: openCode })
  const result = await daemon.startManagedHosts()
  assert.equal(result[0].status, "unavailable")
  assert.equal(daemon.snapshot().agents.find((host) => host.id === "opencode").state, "unavailable")
  assert.equal(daemon.snapshot().agents.find((host) => host.id === "codex").state, "configured")
})

test("machine server wires registry, routing, native Session operations, task lifecycle, finish, and Work Thread wrappers", () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const acp = new FakeAcp()
  const openCode = new FakeHttpHost()
  daemon.registerAcpHost({ id: "pi", agent: acp })
  daemon.registerManagedHttpHost({ id: "opencode", host: openCode })

  let bridgeOptions
  let routerOptions
  let claimOptions
  let launchOptions
  let modelOptions
  let finishOptions
  let workThreadOptions
  const bridgeServer = { marker: "bridge", acpService: { async claimSession() { return true }, async prompt() {}, async abort() {} } }
  const routedServer = { marker: "router" }
  const claimServer = { marker: "session-claim" }
  const launchServer = { marker: "launch" }
  const modelServer = { marker: "models" }
  const finishServer = { marker: "finish" }
  const workThreadServer = { marker: "work-threads" }
  const fakeLedger = { marker: "operation-ledger" }
  const value = createMachineDaemonServer({
    daemon,
    config: { backend: "pi", port: 4097 },
    primaryAcp: acp,
    primaryAgentID: "pi",
    serviceOptions: { snapshotDirectory: "/tmp/test" },
    sessionOperationLedger: fakeLedger,
    createServer: (options) => { bridgeOptions = options; return bridgeServer },
    createRouter: (options) => { routerOptions = options; return routedServer },
    createClaimServer: (options) => { claimOptions = options; return claimServer },
    createLaunchServer: (options) => { launchOptions = options; return launchServer },
    createModelServer: (options) => { modelOptions = options; return modelServer },
    createFinishServer: (options) => { finishOptions = options; return finishServer },
    createWorkThreadServerFactory: (options) => { workThreadOptions = options; return workThreadServer }
  })

  assert.equal(value, workThreadServer)
  assert.equal(bridgeOptions.machineRegistry, daemon.registry)
  assert.equal(bridgeOptions.acp, acp)
  assert.equal(routerOptions.daemon, daemon)
  assert.equal(routerOptions.bridgeServer, bridgeServer)
  assert.equal(routerOptions.primaryAgentID, "pi")
  assert.equal(claimOptions.innerServer, routedServer)
  assert.equal(typeof claimOptions.claimSession, "function")
  assert.equal(typeof claimOptions.promptSession, "function")
  assert.equal(typeof claimOptions.commandSession, "function")
  assert.equal(typeof claimOptions.stopSession, "function")
  assert.equal(typeof claimOptions.handoffSession, "function")
  assert.equal(typeof claimOptions.reconcileHandoff, "function")
  assert.equal(claimOptions.operationLedger, fakeLedger)
  assert.equal(launchOptions.innerServer, claimServer)
  assert.equal(typeof launchOptions.taskRunController.launch, "function")
  assert.equal(modelOptions.innerServer, launchServer)
  assert.equal(modelOptions.daemon, daemon)
  assert.equal(modelOptions.taskStore, routerOptions.taskStore)
  assert.equal(finishOptions.innerServer, modelServer)
  assert.equal(finishOptions.taskStore, routerOptions.taskStore)
  assert.equal(finishOptions.worktreeManager, routerOptions.worktreeManager)
  assert.equal(workThreadOptions.innerServer, finishServer)
  assert.equal(typeof workThreadOptions.controller.reconcile, "function")
  assert.equal(workThreadOptions.controller.taskStore, routerOptions.taskStore)
  assert.deepEqual(bridgeOptions.machineRegistry.snapshot().agents.map((host) => host.id), ["pi", "opencode"])
})

test("OpenCode-only machine server does not construct a phantom ACP bridge", () => {
  const daemon = new MachineDaemon({ id: "machine_http_only", name: "workstation" })
  daemon.registerManagedHttpHost({
    id: "opencode",
    label: "OpenCode",
    host: new FakeHttpHost(),
    eager: false
  })

  let routerOptions
  const value = createMachineDaemonServer({
    daemon,
    config: { backend: "opencode", port: 4097, stateDirectory: "/tmp/hr-http-only" },
    primaryAgentID: "opencode",
    sessionOperationLedger: { diagnostics() { return {} } },
    sessionLinkStore: {},
    createServer: () => { throw new Error("OpenCode-only startup must not create an ACP bridge") },
    createRouter: (options) => { routerOptions = options; return { marker: "router" } },
    createClaimServer: ({ innerServer }) => innerServer,
    createLaunchServer: ({ innerServer }) => innerServer,
    createModelServer: ({ innerServer }) => innerServer,
    createFinishServer: ({ innerServer }) => innerServer,
    createWorkThreadServerFactory: ({ innerServer }) => innerServer
  })

  assert.deepEqual(value, { marker: "router" })
  assert.equal(routerOptions.primaryAgentID, "opencode")
  assert.equal(routerOptions.bridgeServer, undefined)
  assert.deepEqual(daemon.snapshot().agents.map((host) => host.id), ["opencode"])
})

test("machine handoff checkpoints a created target before link enrichment can fail", async () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const codex = new FakeAcp()
  const pi = new FakeAcp()
  daemon.registerAcpHost({ id: "codex", agent: codex })
  daemon.registerAcpHost({ id: "pi", agent: pi, bridgeConfig: { backend: "pi" } })

  const targetSessions = [{ id: "pi-old", directory: "/repo" }]
  let creates = 0
  let claimOptions
  createMachineDaemonServer({
    daemon,
    config: { backend: "codex", port: 4097 },
    primaryAcp: codex,
    sessionOperationLedger: { marker: "ledger" },
    sessionLinkStore: {
      async addHandoff() { throw new Error("simulated SessionLinkStore failure") }
    },
    createServer: (options) => ({
      acpService: options.config.backend === "pi"
        ? {
            async listSessions() { return targetSessions },
            async createSession(input) {
              creates += 1
              assert.deepEqual(input, { directory: "/repo" }, "handoff creation must not apply title/model before target checkpoint")
              const created = { id: "pi-new", directory: "/repo" }
              targetSessions.push(created)
              return created
            },
            async renameSession() { throw new Error("cosmetic rename failed") },
            async claimSession() { return true },
            async prompt() {},
            async abort() {}
          }
        : { async claimSession() { return true }, async prompt() {}, async abort() {} },
      emit() {}
    }),
    createRouter: () => ({ marker: "router" }),
    createClaimServer: (options) => { claimOptions = options; return { marker: "claim" } },
    createLaunchServer: ({ innerServer }) => innerServer,
    createModelServer: ({ innerServer }) => innerServer,
    createFinishServer: ({ innerServer }) => innerServer,
    createWorkThreadServerFactory: ({ innerServer }) => innerServer
  })

  const checkpoints = []
  const result = await claimOptions.handoffSession(
    "codex",
    "source-native-1",
    { targetAgentID: "pi", directory: "/repo", title: "Continue source" },
    { checkpoint: async (value) => checkpoints.push(structuredClone(value)) }
  )

  assert.equal(creates, 1)
  assert.equal(result.target.sessionID, "pi-new")
  assert.equal(result.link, undefined, "link failure must not erase a known target identity")
  assert.equal(checkpoints[0].target.sessionID, "pi-new", "target id must be checkpointed before enrichment")
})

test("machine handoff reconciles one ACP Session created behind a lost session/new response", async () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const codex = new FakeAcp()
  const pi = new FakeAcp()
  daemon.registerAcpHost({ id: "codex", agent: codex })
  daemon.registerAcpHost({ id: "pi", agent: pi, bridgeConfig: { backend: "pi" } })

  const targetSessions = [{ id: "pi-old", directory: "/repo" }]
  let creates = 0
  let claimOptions
  createMachineDaemonServer({
    daemon,
    config: { backend: "codex", port: 4097 },
    primaryAcp: codex,
    sessionOperationLedger: { marker: "ledger" },
    sessionLinkStore: { async addHandoff({ source, target }) { return { type: "handoff", source, target, createdAt: "2026-08-29T12:00:00.000Z" } } },
    createServer: (options) => ({
      acpService: options.config.backend === "pi"
        ? {
            async listSessions() { return targetSessions },
            async createSession() {
              creates += 1
              targetSessions.push({ id: "pi-recovered", directory: "/repo" })
              throw new Error("simulated lost session/new response")
            },
            async claimSession() { return true },
            async prompt() {},
            async abort() {}
          }
        : { async claimSession() { return true }, async prompt() {}, async abort() {} },
      emit() {}
    }),
    createRouter: () => ({ marker: "router" }),
    createClaimServer: (options) => { claimOptions = options; return { marker: "claim" } },
    createLaunchServer: ({ innerServer }) => innerServer,
    createModelServer: ({ innerServer }) => innerServer,
    createFinishServer: ({ innerServer }) => innerServer,
    createWorkThreadServerFactory: ({ innerServer }) => innerServer
  })

  let recovery
  await assert.rejects(
    () => claimOptions.handoffSession("codex", "source-native-1", { targetAgentID: "pi", directory: "/repo" }),
    (error) => {
      assert.equal(error.ambiguous, true)
      recovery = error.recovery
      return true
    }
  )
  assert.equal(creates, 1)

  const reconciled = await claimOptions.reconcileHandoff(
    "codex",
    "source-native-1",
    { targetAgentID: "pi", directory: "/repo" },
    recovery
  )
  assert.equal(reconciled.target.sessionID, "pi-recovered")
  assert.equal(creates, 1, "read-only reconciliation must not replay session/new")
})

test("machine Session mutations acquire ACP ownership lazily and reuse it", async () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const codex = new FakeAcp()
  const pi = new FakeAcp()
  const openCode = new FakeHttpHost()
  daemon.registerAcpHost({ id: "codex", agent: codex })
  daemon.registerAcpHost({ id: "pi", agent: pi, bridgeConfig: { backend: "pi" } })
  daemon.registerManagedHttpHost({ id: "opencode", host: openCode })

  const calls = []
  let claimOptions
  createMachineDaemonServer({
    daemon,
    config: { backend: "codex", port: 4097 },
    primaryAcp: codex,
    sessionOperationLedger: { marker: "ledger" },
    createServer: (options) => ({
      acpService: {
        async claimSession(sessionID) { calls.push(["claim", options.config.backend, sessionID]); return true },
        async prompt(sessionID, text, _model, attachments) { calls.push(["prompt", options.config.backend, sessionID, text, attachments]) },
        async abort(sessionID) { calls.push(["stop", options.config.backend, sessionID]) }
      },
      emit() {}
    }),
    createRouter: () => ({ marker: "router" }),
    createClaimServer: (options) => { claimOptions = options; return { marker: "claim" } },
    createLaunchServer: ({ innerServer }) => innerServer,
    createModelServer: ({ innerServer }) => innerServer,
    createFinishServer: ({ innerServer }) => innerServer,
    createWorkThreadServerFactory: ({ innerServer }) => innerServer
  })

  await claimOptions.stopSession("pi", "native-pi-1", { directory: "/repo" })
  await claimOptions.promptSession("pi", "native-pi-1", {
    text: "Continue once",
    directory: "/repo",
    attachments: [{ mime: "image/png", filename: "screen.png", url: "data:image/png;base64,aGVsbG8=" }]
  })
  await claimOptions.commandSession("pi", "native-pi-1", {
    command: "help",
    arguments: "models",
    directory: "/repo"
  })
  await claimOptions.stopSession("pi", "native-pi-1", { directory: "/repo" })
  assert.deepEqual(calls, [
    ["claim", "pi", "native-pi-1"],
    ["stop", "pi", "native-pi-1"],
    ["prompt", "pi", "native-pi-1", "Continue once", [{ mime: "image/png", filename: "screen.png", data: "aGVsbG8=" }]],
    ["prompt", "pi", "native-pi-1", "/help models", []],
    ["stop", "pi", "native-pi-1"]
  ])
  await assert.rejects(() => claimOptions.claimSession("opencode", "native-http-1"), (error) => error.code === "unsupported_agent")
  await assert.rejects(() => claimOptions.promptSession("missing", "native-1", { text: "x", directory: "/repo" }), (error) => error.code === "unknown_agent")

  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options })
    return new Response(null, { status: 204 })
  }
  try {
    await claimOptions.promptSession("opencode", "native-http-1", {
      text: "Inspect this screenshot",
      directory: "/repo",
      attachments: [{ mime: "image/jpeg", filename: "screen.jpg", url: "data:image/jpeg;base64,aGVsbG8=" }]
    })
    await claimOptions.commandSession("opencode", "native-http-1", {
      command: "help",
      arguments: "models",
      directory: "/repo"
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requests.length, 2)
  const openCodeBody = JSON.parse(requests[0].options.body)
  assert.deepEqual(openCodeBody.parts, [
    { type: "text", text: "Inspect this screenshot" },
    { type: "file", mime: "image/jpeg", filename: "screen.jpg", url: "data:image/jpeg;base64,aGVsbG8=" }
  ])
  assert.match(requests[1].url, /\/session\/native-http-1\/command\?directory=/)
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    command: "help",
    arguments: "models"
  })
})

test("machine Session claim fails if the native Session disappears before ownership is retained", async () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const codex = new FakeAcp()
  daemon.registerAcpHost({ id: "codex", agent: codex })
  let claimOptions
  createMachineDaemonServer({
    daemon,
    config: { backend: "codex", port: 4097 },
    primaryAcp: codex,
    sessionOperationLedger: { marker: "ledger" },
    createServer: () => ({
      acpService: {
        async claimSession() { throw new Error("Harness session not found") },
        async prompt() {},
        async abort() {}
      },
      emit() {}
    }),
    createRouter: () => ({ marker: "router" }),
    createClaimServer: (options) => { claimOptions = options; return { marker: "claim" } },
    createLaunchServer: ({ innerServer }) => innerServer,
    createModelServer: ({ innerServer }) => innerServer,
    createFinishServer: ({ innerServer }) => innerServer,
    createWorkThreadServerFactory: ({ innerServer }) => innerServer
  })

  await assert.rejects(
    () => claimOptions.claimSession("codex", "native-gone"),
    (error) => error.code === "session_unavailable" && /no longer available/.test(error.message)
  )
})

test("machine server creates an isolated bridge service for every registered ACP harness", () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const codex = new FakeAcp()
  const pi = new FakeAcp()
  daemon.registerAcpHost({ id: "codex", agent: codex })
  daemon.registerAcpHost({ id: "pi", agent: pi, bridgeConfig: { backend: "pi" }, serviceOptions: { marker: "pi" } })
  const created = []
  let routerOptions
  createMachineDaemonServer({
    daemon,
    config: { backend: "codex", port: 4097 },
    primaryAcp: codex,
    sessionOperationLedger: { marker: "ledger" },
    createServer: (options) => {
      const server = { options, acpService: { async claimSession() { return true }, async prompt() {}, async abort() {} }, emit() {} }
      created.push(server)
      return server
    },
    createRouter: (options) => { routerOptions = options; return {} },
    createClaimServer: ({ innerServer }) => innerServer,
    createLaunchServer: ({ innerServer }) => innerServer,
    createModelServer: ({ innerServer }) => innerServer,
    createFinishServer: ({ innerServer }) => innerServer,
    createWorkThreadServerFactory: ({ innerServer }) => innerServer
  })
  assert.equal(created.length, 1)
  const piBridge = routerOptions.acpBridgeServer("pi")
  assert.equal(created.length, 2)
  assert.equal(piBridge.options.acp, daemon.hostEntry("pi").host)
  assert.equal(piBridge.options.config.backend, "pi")
  assert.equal(piBridge.options.serviceOptions.marker, "pi")
  assert.equal(routerOptions.acpBridgeServer("pi"), piBridge)
})

test("daemon exposes registered host entries to its internal router", () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const openCode = new FakeHttpHost()
  daemon.registerManagedHttpHost({ id: "opencode", host: openCode })
  const entry = daemon.hostEntry("opencode")
  assert.equal(entry.id, "opencode")
  assert.equal(entry.kind, "http")
  assert.equal(entry.host, openCode)
})

test("daemon shutdown closes ACP and terminates managed HTTP hosts", () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const acp = new FakeAcp()
  const openCode = new FakeHttpHost()
  daemon.registerAcpHost({ id: "codex", agent: acp })
  daemon.registerManagedHttpHost({ id: "opencode", host: openCode })
  daemon.close()
  assert.equal(acp.closed, true)
  assert.deepEqual(openCode.stopped, ["SIGTERM"])
})