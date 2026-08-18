import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createBridgeServer } from "../src/server.js"

class HealthAcp extends EventEmitter {
  agentInfo = { version: "test-version" }
  async start() {}
}

async function withServer(machineRegistry, run) {
  const server = createBridgeServer({
    config: {
      backend: "codex",
      roots: [process.cwd()],
      corsOrigins: [],
      heartbeatMs: 10_000
    },
    acp: new HealthAcp(),
    machineRegistry
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test("machine daemon health does not pretend the ACP primary is the whole server backend", async () => {
  await withServer({ snapshot: () => ({ machine: { id: "machine-1" }, agents: [] }) }, async (base) => {
    const response = await fetch(`${base}/global/health`)
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.healthy, true)
    assert.equal(health.version, "test-version")
    assert.equal("backend" in health, false)
  })
})

test("single-backend bridge health still reports its backend", async () => {
  await withServer(undefined, async (base) => {
    const response = await fetch(`${base}/global/health`)
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.backend, "codex")
  })
})
