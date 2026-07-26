import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpTransport } from "../src/acp-transport.js"

class FakeChild extends EventEmitter {
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  writes = []

  constructor(onRequest) {
    super()
    this.stdout.setEncoding = () => undefined
    this.stderr.setEncoding = () => undefined
    this.stdin = {
      writable: true,
      write: (line, callback) => {
        this.writes.push(JSON.parse(line))
        onRequest(this, this.writes.at(-1))
        callback?.()
        return true
      }
    }
  }

  respond(message, splitAt) {
    const line = `${JSON.stringify(message)}\n`
    if (splitAt) {
      this.stdout.emit("data", line.slice(0, splitAt))
      this.stdout.emit("data", line.slice(splitAt))
    } else {
      this.stdout.emit("data", line)
    }
  }

  kill() {
    this.killed = true
    this.stdin.writable = false
    return true
  }
}

function fakeSpawn(handler) {
  return () => new FakeChild(handler)
}

const TEST_PROCESS = { command: "test-agent", args: [] }

function respondToHandshake(child, request) {
  if (request.method === "initialize") {
    child.respond({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        agentInfo: { name: "oh-my-pi", version: "17.0.7" },
        authMethods: [{ id: "agent" }]
      }
    }, 12)
  }
  if (request.method === "authenticate") child.respond({ jsonrpc: "2.0", id: request.id, result: {} })
}

test("initializes, authenticates, and lists ACP sessions", async () => {
  const client = new AcpTransport({
    process: TEST_PROCESS,
    auth: { mode: "required", methodID: "agent" },
    spawnProcess: fakeSpawn((child, request) => {
      respondToHandshake(child, request)
      if (request.method === "session/list") {
        child.respond({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ sessionId: "session-1" }] } })
      }
    })
  })

  assert.deepEqual(await client.listSessions(), [{ sessionId: "session-1" }])
  assert.deepEqual(client.agentInfo, { name: "oh-my-pi", version: "17.0.7" })
  client.close()
})

test("forwards ACP notifications and request errors", async () => {
  const client = new AcpTransport({
    process: TEST_PROCESS,
    auth: { mode: "required", methodID: "agent" },
    spawnProcess: fakeSpawn((child, request) => {
      respondToHandshake(child, request)
      if (request.method === "session/test") {
        child.respond({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1" } })
        child.respond({ jsonrpc: "2.0", id: request.id, error: { message: "denied" } })
      }
    })
  })
  const notifications = []
  client.on("notification", (message) => notifications.push(message))
  await client.start()
  await assert.rejects(client.request("session/test", {}), /denied/)
  assert.deepEqual(notifications, [{ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1" } }])
  client.close()
})

test("answers agent-initiated requests instead of leaving them unresolved", async () => {
  const child = new FakeChild((current, request) => {
    respondToHandshake(current, request)
    if (request.method === "session/prompt") {
      current.respond({ jsonrpc: "2.0", id: 99, method: "session/custom_request", params: { sessionId: "session-1" } })
      current.respond({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
    }
  })
  const client = new AcpTransport({ process: TEST_PROCESS, auth: { mode: "required", methodID: "agent" }, spawnProcess: () => child })
  const observed = []
  client.on("agent-request", (message) => observed.push(message.method))
  await client.start()

  assert.deepEqual(await client.request("session/prompt", {}), { stopReason: "end_turn" })
  assert.deepEqual(observed, ["session/custom_request"])
  const reply = child.writes.find((message) => message.id === 99)
  assert.ok(reply, "the bridge must reply to an agent-initiated request")
  assert.equal(reply.error.code, -32601)
  client.close()
})

test("rejects an in-flight request when ACP exits", async () => {
  const child = new FakeChild((current, request) => {
    respondToHandshake(current, request)
    if (request.method === "session/hang") current.emit("exit", 1, null)
  })
  const client = new AcpTransport({ process: TEST_PROCESS, auth: { mode: "required", methodID: "agent" }, spawnProcess: () => child })
  await client.start()
  await assert.rejects(client.request("session/hang", {}), /ACP process exited \(1\)/)
})

test("starts an ACP adapter without OMP authentication or arguments", async () => {
  const methods = []
  const spawned = []
  const client = new AcpTransport({
    process: { command: "pi-acp", args: [] },
    auth: { mode: "skip" },
    spawnProcess: (command, args) => {
      spawned.push({ command, args })
      return new FakeChild((child, request) => {
        methods.push(request.method)
        if (request.method === "initialize") {
          child.respond({
            jsonrpc: "2.0",
            id: request.id,
            result: { agentInfo: { name: "pi-acp", version: "0.0.32" }, authMethods: [{ id: "pi_terminal_login" }] }
          })
        }
      })
    }
  })

  await client.start()
  assert.deepEqual(spawned, [{ command: "pi-acp", args: [] }])
  assert.deepEqual(methods, ["initialize"])
  client.close()
})

test("selects PI allow-once permission requests instead of stalling the agent", async () => {
  let permissionResponse
  const child = new FakeChild((current, request) => {
    respondToHandshake(current, request)
    if (request.id === 77 && request.result) permissionResponse = request
  })
  const client = new AcpTransport({
    process: TEST_PROCESS,
    permissionMode: "allow",
    spawnProcess: () => child
  })
  await client.start()

  child.respond({
    jsonrpc: "2.0",
    id: 77,
    method: "session/request_permission",
    params: {
      sessionId: "session-1",
      options: [
        { optionId: "reject", kind: "reject_once" },
        { optionId: "allow", kind: "allow_once" }
      ]
    }
  })

  assert.deepEqual(permissionResponse?.result, {
    outcome: { outcome: "selected", optionId: "allow" }
  })
  client.close()
})
