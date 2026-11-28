import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { harnessProfile } from "../src/harness-profiles.js"
import { createBridgeServer } from "../src/server.js"

// pi-acp 0.x crashes in its replay when some Sessions are reopened over ACP ("replayEntry is not a
// function"); this fake fails every session/load the same way to prove the bridge never asks.
class PiLikeAcp extends EventEmitter {
  agentInfo = { version: "test" }
  loads = 0
  async start() {}
  async listSessions() {
    return [{ sessionId: "pi-session", title: "PI", cwd: process.cwd(), updatedAt: "2026-11-28T00:00:00.000Z" }]
  }
  async request(method) {
    if (method === "session/load" || method === "session/resume") {
      this.loads += 1
      throw new Error("Internal error: internal error")
    }
    return {}
  }
  notify() {}
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test("PI declares no session modes", () => {
  assert.equal(harnessProfile("pi").capabilities.sessionModes, false)
  assert.equal(harnessProfile("claude").capabilities.sessionModes, true)
})

test("a harness without session modes answers the mode picker without reopening the Session", async () => {
  const acp = new PiLikeAcp()
  const config = { backend: "pi", username: "", password: "", corsOrigins: [], roots: [process.cwd()] }
  const server = createBridgeServer({ config, acp })
  const base = await listen(server)
  try {
    const opened = await fetch(`${base}/session/pi-session/mode?load=1`)
    assert.equal(opened.status, 200)
    assert.deepEqual(await opened.json(), { loaded: true, modes: [] })

    const changed = await fetch(`${base}/session/pi-session/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modeId: "plan" })
    })
    assert.equal(changed.ok, false)
    assert.match((await changed.json()).error, /does not offer session modes/)
    assert.equal(acp.loads, 0, "the PI Session must not be reopened over ACP")
  } finally {
    await close(server)
  }
})
