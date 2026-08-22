import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { ManagedOpenCodeHost } from "../src/opencode-host.js"

class FakeOpenCodeChild extends EventEmitter {
  pid = 6262
  exitCode = null
  signalCode = null
  stderr = new EventEmitter()
  killed = false

  constructor() {
    super()
    this.stderr.setEncoding = () => undefined
  }

  kill(signal) {
    this.killed = true
    this.signalCode = signal
    return true
  }
}

test("managed OpenCode diagnostics report process and listener ownership without credentials", async () => {
  const child = new FakeOpenCodeChild()
  const host = new ManagedOpenCodeHost({
    username: "private-user",
    password: "private-password",
    spawnProcess: () => child,
    waitUntilReady: async () => undefined
  })
  const stderr = () => undefined
  const unavailable = () => undefined
  host.on("stderr", stderr)
  host.on("unavailable", unavailable)

  await host.start()
  const running = host.diagnostics()
  assert.equal(running.state, "running")
  assert.equal(running.processID, 6262)
  assert.equal(running.startInFlight, false)
  assert.equal(running.listenerCounts.stderr, 1)
  assert.equal(running.listenerCounts.unavailable, 1)
  assert.equal(JSON.stringify(running).includes("private-user"), false)
  assert.equal(JSON.stringify(running).includes("private-password"), false)

  host.off("stderr", stderr)
  host.off("unavailable", unavailable)
  assert.equal(host.diagnostics().listenerCount, 0)
})

test("managed OpenCode startup diagnostics settle instead of accumulating listeners", async () => {
  const children = []
  let release
  const host = new ManagedOpenCodeHost({
    spawnProcess: () => {
      const child = new FakeOpenCodeChild()
      children.push(child)
      return child
    },
    waitUntilReady: () => new Promise((resolve) => { release = resolve })
  })

  const starting = host.start()
  assert.equal(host.diagnostics().state, "starting")
  assert.equal(host.diagnostics().startInFlight, true)
  release()
  await starting
  assert.equal(host.diagnostics().startInFlight, false)
  assert.equal(children.length, 1)
  host.stop()
})
