import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { ManagedOpenCodeHost, trackManagedHostLifecycle, waitForOpenCodeHealth } from "../src/opencode-host.js"
import { MachineRegistry } from "../src/machine-registry.js"

class FakeChild extends EventEmitter {
  pid = 4242
  exitCode = null
  signalCode = null
  killSignals = []

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal)
    if (signal === "SIGKILL") this.signalCode = signal
    return true
  }

  exit(code = 0, signal = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit("exit", code, signal)
  }
}

test("starts OpenCode without placing credentials on argv", async () => {
  const child = new FakeChild()
  let invocation
  const host = new ManagedOpenCodeHost({
    host: "0.0.0.0",
    port: 4096,
    username: "harness",
    password: "secret",
    environment: { PATH: "/bin" },
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options }
      return child
    },
    waitUntilReady: async ({ host: readyHost, port, username, password }) => {
      assert.equal(readyHost, "127.0.0.1")
      assert.equal(port, 4096)
      assert.equal(username, "harness")
      assert.equal(password, "secret")
    }
  })

  await host.start()

  assert.equal(invocation.command, "opencode")
  assert.deepEqual(invocation.args, ["serve", "--hostname", "0.0.0.0", "--port", "4096"])
  assert.equal(invocation.args.includes("secret"), false)
  assert.equal(invocation.options.env.OPENCODE_SERVER_USERNAME, "harness")
  assert.equal(invocation.options.env.OPENCODE_SERVER_PASSWORD, "secret")
  assert.equal(host.processID, 4242)
})

test("health readiness verifies the generated credentials", async () => {
  let request
  await waitForOpenCodeHealth({
    host: "127.0.0.1",
    port: 4096,
    username: "harness",
    password: "secret",
    timeoutMs: 50,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { status: 200 }
    }
  })

  assert.equal(request.url, "http://127.0.0.1:4096/global/health")
  assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from("harness:secret").toString("base64")}`)
})

test("health readiness rejects an authentication mismatch immediately", async () => {
  await assert.rejects(waitForOpenCodeHealth({
    host: "127.0.0.1",
    port: 4096,
    username: "harness",
    password: "secret",
    timeoutMs: 1_000,
    fetchImpl: async () => ({ status: 401 })
  }), /rejected the generated credentials/)
})

test("startup has an authoritative timeout even if readiness never settles", async () => {
  const child = new FakeChild()
  const host = new ManagedOpenCodeHost({
    username: "harness",
    password: "secret",
    spawnProcess: () => child,
    startTimeoutMs: 20,
    waitUntilReady: () => new Promise(() => {})
  })

  await assert.rejects(host.start(), /within 20ms/)
  assert.deepEqual(child.killSignals, ["SIGTERM"])
})

test("updates the machine registry when OpenCode becomes available and exits", async () => {
  const child = new FakeChild()
  const registry = new MachineRegistry({ id: "machine_test", name: "phone" })
  registry.registerHost({ id: "opencode", transport: "http", state: "configured" })
  const host = trackManagedHostLifecycle(new ManagedOpenCodeHost({
    host: "127.0.0.1",
    port: 4096,
    username: "harness",
    password: "secret",
    spawnProcess: () => child,
    waitUntilReady: async () => {}
  }), registry, "opencode")

  await host.start()
  assert.equal(registry.host("opencode").state, "available")
  assert.equal(registry.host("opencode").processID, 4242)

  child.exit(1, null)
  assert.equal(registry.host("opencode").state, "unavailable")
  assert.equal(registry.host("opencode").processID, undefined)
})

test("marks the machine registry unavailable when OpenCode startup fails", async () => {
  const child = new FakeChild()
  const registry = new MachineRegistry({ id: "machine_test", name: "phone" })
  registry.registerHost({ id: "opencode", transport: "http", state: "configured" })
  const host = trackManagedHostLifecycle(new ManagedOpenCodeHost({
    username: "harness",
    password: "secret",
    spawnProcess: () => child,
    waitUntilReady: async () => { throw new Error("health failed") }
  }), registry, "opencode")

  await assert.rejects(host.start(), /health failed/)
  assert.equal(registry.host("opencode").state, "unavailable")
  assert.equal(registry.host("opencode").processID, undefined)
})

test("stops the managed OpenCode child with the requested signal", async () => {
  const child = new FakeChild()
  const host = new ManagedOpenCodeHost({
    username: "harness",
    password: "secret",
    spawnProcess: () => child,
    waitUntilReady: async () => {}
  })
  await host.start()
  host.stop("SIGTERM")
  host.stop("SIGKILL")
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"])
})
