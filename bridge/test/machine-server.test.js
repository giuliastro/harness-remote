import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { MachineRegistry } from "../src/machine-registry.js"
import { createBridgeServer } from "../src/server.js"

class IdleAcp extends EventEmitter {}

function baseConfig() {
  return {
    backend: "omp",
    host: "127.0.0.1",
    port: 0,
    username: "",
    password: "",
    roots: [],
    corsOrigins: [],
    logRequests: false,
    heartbeatMs: 10_000
  }
}

test("serves a machine-scoped heterogeneous agent registry", async (t) => {
  const registry = new MachineRegistry({ id: "machine_test", name: "workstation" })
  registry.registerHost({ id: "omp", label: "Oh My Pi", backend: "omp", transport: "acp" })
  registry.registerHost({ id: "opencode", label: "OpenCode", backend: "opencode", transport: "http", state: "available" })

  const server = createBridgeServer({
    config: baseConfig(),
    acp: new IdleAcp(),
    machineRegistry: registry,
    serviceOptions: {}
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const address = server.address()
  assert.ok(address && typeof address === "object")
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/machine`)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), registry.snapshot())
})

test("machine endpoint remains protected by bridge authentication", async (t) => {
  const registry = new MachineRegistry({ id: "machine_test", name: "workstation" })
  registry.registerHost({ id: "omp" })
  const config = { ...baseConfig(), username: "harness", password: "secret" }
  const server = createBridgeServer({ config, acp: new IdleAcp(), machineRegistry: registry, serviceOptions: {} })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const address = server.address()
  assert.ok(address && typeof address === "object")
  const unauthorized = await fetch(`http://127.0.0.1:${address.port}/v1/machine`)
  assert.equal(unauthorized.status, 401)

  const authorization = Buffer.from("harness:secret").toString("base64")
  const authorized = await fetch(`http://127.0.0.1:${address.port}/v1/machine`, {
    headers: { Authorization: `Basic ${authorization}` }
  })
  assert.equal(authorized.status, 200)
})
