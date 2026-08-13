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

  daemon.registerManagedHttpHost({
    id: "first",
    host: new FakeHttpHost({
      startImpl: async () => {
        firstStarted = true
        await firstGate
      }
    })
  })
  daemon.registerManagedHttpHost({
    id: "second",
    host: new FakeHttpHost({
      startImpl: async () => {
        secondStarted = true
        await secondGate
      }
    })
  })

  const starting = daemon.startManagedHosts()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(firstStarted, true)
  assert.equal(secondStarted, true)

  releaseFirst()
  releaseSecond()
  const result = await starting
  assert.deepEqual(result.map(({ id, status }) => [id, status]), [
    ["first", "available"],
    ["second", "available"]
  ])
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

test("machine server receives the shared multi-host registry", () => {
  const daemon = new MachineDaemon({ id: "machine_test", name: "workstation" })
  const acp = new FakeAcp()
  const openCode = new FakeHttpHost()
  daemon.registerAcpHost({ id: "pi", agent: acp })
  daemon.registerManagedHttpHost({ id: "opencode", host: openCode })

  let received
  const server = { marker: true }
  const value = createMachineDaemonServer({
    daemon,
    config: { port: 4097 },
    primaryAcp: acp,
    serviceOptions: { snapshotDirectory: "/tmp/test" },
    createServer: (options) => {
      received = options
      return server
    }
  })

  assert.equal(value, server)
  assert.equal(received.machineRegistry, daemon.registry)
  assert.equal(received.acp, acp)
  assert.deepEqual(received.machineRegistry.snapshot().agents.map((host) => host.id), ["pi", "opencode"])
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
