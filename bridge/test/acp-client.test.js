import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpClient } from "../src/acp-client.js"

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

function fakeSpawn(handler, calls = []) {
  return (command, args) => {
    calls.push({ command, args })
    return new FakeChild(handler)
  }
}

function respondToHandshake(child, request, authMethods = [{ id: "agent" }]) {
  if (request.method === "initialize") {
    child.respond({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        agentInfo: { name: "oh-my-pi", version: "17.0.7" },
        authMethods
      }
    }, 12)
  }
  if (request.method === "authenticate") child.respond({ jsonrpc: "2.0", id: request.id, result: {} })
}

test("initializes, authenticates, and lists ACP sessions", async () => {
  const client = new AcpClient({
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

test("launches an ACP adapter with the configured command and arguments", async () => {
  const calls = []
  const client = new AcpClient({
    command: "npx",
    args: ["-y", "@victor-software-house/pi-acp"],
    spawnProcess: fakeSpawn((child, request) => respondToHandshake(child, request), calls)
  })

  await client.start()
  assert.deepEqual(calls, [{ command: "npx", args: ["-y", "@victor-software-house/pi-acp"] }])
  client.close()
})

test("accepts alternate or absent ACP authentication methods", async () => {
  let authenticatedMethod
  const alternate = new AcpClient({
    spawnProcess: fakeSpawn((child, request) => {
      respondToHandshake(child, request, [{ id: "pi_terminal_login" }])
      if (request.method === "authenticate") authenticatedMethod = request.params.methodId
    })
  })
  await alternate.start()
  assert.equal(authenticatedMethod, "pi_terminal_login")
  alternate.close()

  const unauthenticated = new AcpClient({
    spawnProcess: fakeSpawn((child, request) => respondToHandshake(child, request, []))
  })
  await unauthenticated.start()
  unauthenticated.close()
})

test("forwards ACP notifications and request errors", async () => {
  const client = new AcpClient({
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

test("selects allow-once for agent permission requests", async () => {
  const child = new FakeChild((current, request) => {
    respondToHandshake(current, request)
    if (request.method === "session/prompt") {
      current.respond({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          options: [
            { optionId: "reject", kind: "reject_once" },
            { optionId: "always", kind: "allow_always" },
            { optionId: "allow", kind: "allow_once" }
          ]
        }
      })
      current.respond({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
    }
  })
  const client = new AcpClient({ permissionMode: "allow", spawnProcess: () => child })
  const observed = []
  client.on("agent-request", (message) => observed.push(message.method))
  await client.start()

  assert.deepEqual(await client.request("session/prompt", {}), { stopReason: "end_turn" })
  assert.deepEqual(observed, ["session/request_permission"])
  const reply = child.writes.find((message) => message.id === 99)
  assert.deepEqual(reply?.result, { outcome: { outcome: "selected", optionId: "allow" } })
  client.close()
})

test("rejects an in-flight request when ACP exits", async () => {
  const child = new FakeChild((current, request) => {
    respondToHandshake(current, request)
    if (request.method === "session/hang") current.emit("exit", 1, null)
  })
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()
  await assert.rejects(client.request("session/hang", {}), /ACP adapter exited \(1\)/)
})
