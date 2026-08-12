import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { ManagedOpenCodeHost, trackManagedHostLifecycle } from "../src/opencode-host.js"
import { MachineRegistry } from "../src/machine-registry.js"

class FakeChild extends EventEmitter {
  pid = 4242
  killed = false
  kill() {
    this.killed = true
    this.emit("exit", 0, "SIGTERM")
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
    waitUntilReady: async (readyHost, port) => {
      assert.equal(readyHost, "127.0.0.1")
      assert.equal(port, 4096)
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

  child.emit("exit", 1, null)
  assert.equal(registry.host("opencode").state, "unavailable")
  assert.equal(registry.host("opencode").processID, undefined)
})

test("stops the managed OpenCode child", async () => {
  const child = new FakeChild()
  const host = new ManagedOpenCodeHost({
    username: "harness",
    password: "secret",
    spawnProcess: () => child,
    waitUntilReady: async () => {}
  })
  await host.start()
  host.stop()
  assert.equal(child.killed, true)
  assert.equal(host.processID, undefined)
})
