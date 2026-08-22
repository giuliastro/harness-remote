import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpClient } from "../src/acp-client.js"

class FakeChild extends EventEmitter {
  killed = false
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()

  constructor(onRequest) {
    super()
    this.stdout.setEncoding = () => undefined
    this.stderr.setEncoding = () => undefined
    this.stdin = {
      writable: true,
      write: (line, callback) => {
        onRequest(this, JSON.parse(line))
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

function handshake(child, request) {
  if (request.method === "initialize") {
    child.respond({
      jsonrpc: "2.0",
      id: request.id,
      result: { agentInfo: { name: "test-agent", version: "1" }, authMethods: [] }
    })
  }
}

test("session prompt timeout measures inactivity instead of total turn duration", async () => {
  let promptRequest
  const child = new FakeChild((current, request) => {
    handshake(current, request)
    if (request.method === "session/prompt") promptRequest = request
  })
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()

  const prompt = client.request("session/prompt", { sessionId: "session-1", prompt: [] }, 35)

  await new Promise((resolve) => setTimeout(resolve, 25))
  child.respond({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "still working" } }
    }
  })

  await new Promise((resolve) => setTimeout(resolve, 25))
  child.respond({ jsonrpc: "2.0", id: promptRequest.id, result: { stopReason: "end_turn" } })

  assert.deepEqual(await prompt, { stopReason: "end_turn" })
  client.close()
})

test("activity from another session does not keep a stalled prompt alive", async () => {
  const child = new FakeChild((current, request) => handshake(current, request))
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()

  const prompt = client.request("session/prompt", { sessionId: "session-1", prompt: [] }, 30)
  await new Promise((resolve) => setTimeout(resolve, 20))
  child.respond({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-2",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "unrelated" } }
    }
  })

  await assert.rejects(prompt, /ACP adapter request timed out: session\/prompt/)
  client.close()
})
