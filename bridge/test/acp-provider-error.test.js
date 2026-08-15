import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpClient } from "../src/acp-client.js"

class FakeChild extends EventEmitter {
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()

  constructor() {
    super()
    this.stdout.setEncoding = () => undefined
    this.stderr.setEncoding = () => undefined
    this.stdin = {
      writable: true,
      write: (line, callback) => {
        const request = JSON.parse(line)
        if (request.method === "initialize") {
          this.respond({ jsonrpc: "2.0", id: request.id, result: { agentInfo: { name: "pi" }, authMethods: [] } })
        } else if (request.method === "session/prompt") {
          this.respond({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32603,
              message: "Internal error",
              data: { details: { code: 429 }, errorKind: "rate_limit", message: "provider rate limit" }
            }
          })
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
  }
}

test("surfaces ACP data.message when data.details is structured", async () => {
  const child = new FakeChild()
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()
  await assert.rejects(
    client.request("session/prompt", {}),
    /Internal error: provider rate limit/
  )
  client.close()
})
