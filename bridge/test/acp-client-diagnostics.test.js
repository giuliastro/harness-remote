import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpClient } from "../src/acp-client.js"

class DiagnosticChild extends EventEmitter {
  killed = false
  pid = 5151
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pendingRequest = null

  constructor() {
    super()
    this.stdout.setEncoding = () => undefined
    this.stderr.setEncoding = () => undefined
    this.stdin = {
      writable: true,
      write: (line, callback) => {
        const request = JSON.parse(line)
        if (request.method === "initialize") {
          this.respond({ jsonrpc: "2.0", id: request.id, result: { agentInfo: { name: "diagnostic" }, authMethods: [] } })
        } else {
          this.pendingRequest = request
        }
        callback?.()
        return true
      }
    }
  }

  respond(message) {
    this.stdout.emit("data", `${JSON.stringify(message)}\n`)
  }

  kill() {
    this.killed = true
    this.stdin.writable = false
    return true
  }
}

test("ACP diagnostics expose request ownership without params and drain after completion", async () => {
  const child = new DiagnosticChild()
  const client = new AcpClient({ spawnProcess: () => child })
  const notification = () => undefined
  const exit = () => undefined
  client.on("notification", notification)
  client.on("exit", exit)
  await client.start()

  const request = client.request("session/prompt", { sessionId: "session-safe", prompt: [{ type: "text", text: "secret prompt" }] }, 5_000)
  const active = client.diagnostics()
  assert.equal(active.state, "running")
  assert.equal(active.processID, 5151)
  assert.equal(active.pendingRequestCount, 1)
  assert.equal(active.pendingRequests[0].method, "session/prompt")
  assert.equal(active.pendingRequests[0].sessionID, "session-safe")
  assert.equal(active.pendingRequests[0].timeoutMs, 5_000)
  assert.equal(JSON.stringify(active).includes("secret prompt"), false)
  assert.equal(active.listenerCounts.notification, 1)
  assert.equal(active.listenerCounts.exit, 1)

  child.respond({ jsonrpc: "2.0", id: child.pendingRequest.id, result: { stopReason: "end_turn" } })
  await request
  assert.equal(client.diagnostics().pendingRequestCount, 0)

  client.off("notification", notification)
  client.off("exit", exit)
  assert.equal(client.diagnostics().listenerCount, 0)
  client.close()
})

test("ACP timeout cleanup returns pending diagnostics to zero", async () => {
  const child = new DiagnosticChild()
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()
  const request = client.request("session/slow", {}, 15)
  assert.equal(client.diagnostics().pendingRequestCount, 1)
  await assert.rejects(request, /timed out/)
  assert.equal(client.diagnostics().pendingRequestCount, 0)
  client.close()
})
