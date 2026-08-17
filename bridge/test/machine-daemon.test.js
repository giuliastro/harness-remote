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

test("machine server wires the shared registry, agent router, task launch, model validation, and finish wrappers", () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const acp = new FakeAcp()
  const openCode = new FakeHttpHost()
  daemon.registerAcpHost({ id: "pi", agent: acp })
  daemon.registerManagedHttpHost({ id: "opencode", host: openCode })

  let bridgeOptions
  let routerOptions
  let launchOptions
  let modelOptions
  let finishOptions
  const bridgeServer = { marker: "bridge" }
  const routedServer = { marker: "router" }
  const launchServer = { marker: "launch" }
  const modelServer = { marker: "models" }
  const finishServer = { marker: "finish" }
  const value = createMachineDaemonServer({
    daemon,
    config: { backend: "pi", port: 4097 },
    primaryAcp: acp,
    primaryAgentID: "pi",
    serviceOptions: { snapshotDirectory: "/tmp/test" },
    createServer: (options) => { bridgeOptions = options; return bridgeServer },
    createRouter: (options) => { routerOptions = options; return routedServer },
    createLaunchServer: (options) => { launchOptions = options; return launchServer },
    createModelServer: (options) => { modelOptions = options; return modelServer },
    createFinishServer: (options) => { finishOptions = options; return finishServer }
  })

  assert.equal(value, finishServer)
  assert.equal(bridgeOptions.machineRegistry, daemon.registry)
  assert.equal(bridgeOptions.acp, acp)
  assert.equal(routerOptions.daemon, daemon)
  assert.equal(routerOptions.bridgeServer, bridgeServer)
  assert.equal(routerOptions.primaryAgentID, "pi")
  assert.equal(launchOptions.innerServer, routedServer)
  assert.equal(typeof launchOptions.taskRunController.launch, "function")
  assert.equal(modelOptions.innerServer, launchServer)
  assert.equal(modelOptions.daemon, daemon)
  assert.equal(modelOptions.taskStore, routerOptions.taskStore)
  assert.equal(finishOptions.innerServer, modelServer)
  assert.equal(finishOptions.taskStore, routerOptions.taskStore)
  assert.equal(finishOptions.worktreeManager, routerOptions.worktreeManager)
  assert.deepEqual(bridgeOptions.machineRegistry.snapshot().agents.map((host) => host.id), ["pi", "opencode"])
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
    createServer: (options) => {
      const server = { options, emit() {} }
      created.push(server)
      return server
    },
    createRouter: (options) => { routerOptions = options; return {} },
    createLaunchServer: ({ innerServer }) => innerServer,
    createModelServer: ({ innerServer }) => innerServer,
    createFinishServer: ({ innerServer }) => innerServer
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
