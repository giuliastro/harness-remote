import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createAgentRoutingServer } from "../src/agent-router.js"

function server(embedded) {
  return createAgentRoutingServer({
    daemon: { snapshot: () => ({ machine: { id: "test" }, agents: [] }) },
    config: { username: "user", password: "secret", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: new EventEmitter(),
    observeOptimization: embedded
  })
}

test("optimization endpoint is machine-scoped, authenticated and GET-only", async (t) => {
  let calls = 0
  const payload = { schemaVersion: 1, state: "unavailable", agents: [], savings: [] }
  const gateway = server(async () => { calls++; return payload })
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => gateway.close(resolve)))
  const url = `http://127.0.0.1:${gateway.address().port}/v1/optimization`
  const unauthorized = await fetch(url)
  assert.equal(unauthorized.status, 401)
  assert.equal(calls, 0)

  const headers = { Authorization: `Basic ${Buffer.from("user:secret").toString("base64")}`,
    "X-Harness-Backend": "opencode" }
  const forbidden = await fetch(url, { method: "POST", headers })
  assert.equal(forbidden.status, 405)
  assert.equal(calls, 0)

  const response = await fetch(url, { headers })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), payload)
  assert.equal(calls, 1)
})
