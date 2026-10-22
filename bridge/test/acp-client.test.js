import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AcpClient } from "../src/acp-client.js"
import { harnessProfile } from "../src/harness-profiles.js"

test("a missing native project directory reports the path instead of a misleading executable ENOENT", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-acp-missing-project-"))
  try {
    const missing = path.join(root, "removed-project")
    const client = new AcpClient({ command: process.execPath, args: [], cwd: missing })
    await assert.rejects(client.start(), (error) => error.message.includes(missing) && /project directory does not exist/.test(error.message))
    assert.equal(client.processID, undefined)
    const file = path.join(root, "a-file")
    await writeFile(file, "test")
    const fileClient = new AcpClient({ command: process.execPath, args: [], cwd: file })
    await assert.rejects(fileClient.start(), /project path is not a directory/)
    assert.equal(fileClient.processID, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

class FakeChild extends EventEmitter {
  killed = false
  pid = 4242
  exitCode = null
  signalCode = null
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

  kill(signal = "SIGTERM") {
    this.killed = true
    this.stdin.writable = false
    this.signalCode = signal
    this.emit("exit", null, signal)
    this.emit("close", null, signal)
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
  assert.equal(client.processID, 4242)
  client.close()
  assert.equal(client.processID, undefined)
})

test("concurrent starts wait for the same completed initialization before sending Session RPCs", async () => {
  let initialized
  const sent = []
  const client = new AcpClient({ spawnProcess: fakeSpawn((child, request) => {
    sent.push(request.method)
    if (request.method === "initialize") initialized = () => respondToHandshake(child, request)
    else if (request.method === "authenticate") respondToHandshake(child, request)
    else if (request.method === "session/list") child.respond({ jsonrpc: "2.0", id: request.id, result: { sessions: [] } })
  }) })
  try {
    const starting = client.start()
    const listing = client.listSessions()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(sent, ["initialize"])
    initialized()
    await Promise.all([starting, listing])
    assert.deepEqual(sent, ["initialize", "authenticate", "session/list"])
  } finally { await client.close() }
})

test("preserves ACP Session pagination and sends an opaque cursor unchanged", async () => {
  const listRequests = []
  const client = new AcpClient({
    spawnProcess: fakeSpawn((child, request) => {
      respondToHandshake(child, request)
      if (request.method === "session/list") {
        listRequests.push(request.params)
        child.respond({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            sessions: [{ sessionId: request.params.cursor ? "session-2" : "session-1" }],
            ...(request.params.cursor ? {} : { nextCursor: "opaque+/cursor==" })
          }
        })
      }
    })
  })

  assert.deepEqual(await client.listSessionPage(), {
    sessions: [{ sessionId: "session-1" }],
    nextCursor: "opaque+/cursor=="
  })
  assert.deepEqual(await client.listSessionPage("opaque+/cursor=="), {
    sessions: [{ sessionId: "session-2" }]
  })
  assert.deepEqual(listRequests, [{}, { cursor: "opaque+/cursor==" }])
  client.close()
})

test("merges provider-scoped environment overrides and preserves the native project cwd", async () => {
  let spawnOptions
  const client = new AcpClient({
    environment: { HARNESS_TEST_MARKER: "provider" },
    cwd: "/native/project",
    spawnProcess: (command, args, options) => {
      spawnOptions = options
      return new FakeChild((child, request) => respondToHandshake(child, request))
    }
  })

  await client.start()
  assert.equal(spawnOptions.env.HARNESS_TEST_MARKER, "provider")
  assert.equal(spawnOptions.cwd, "/native/project")
  const inherited = Object.entries(process.env).find(([, value]) => value !== undefined)
  assert.ok(inherited, "the test process must expose at least one environment variable")
  assert.equal(spawnOptions.env[inherited[0]], inherited[1])
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

test("can skip authenticate when a provider advertises a non-implemented auth method", async () => {
  let authenticateRequests = 0
  const client = new AcpClient({
    authenticate: false,
    spawnProcess: fakeSpawn((child, request) => {
      respondToHandshake(child, request, [{ id: "opencode-login" }])
      if (request.method === "authenticate") authenticateRequests += 1
    })
  })

  await client.start()
  assert.equal(authenticateRequests, 0)
  client.close()
})

test("prefers the profile's auth method over the first advertised one", async () => {
  // Codex's adapter lists `api-key` first, which demands an API key from the environment;
  // a `codex login` is what `chat-gpt` reads from disk, so the profile names it explicitly.
  let authenticatedMethod
  const preferred = new AcpClient({
    preferredAuthMethod: "chat-gpt",
    spawnProcess: fakeSpawn((child, request) => {
      respondToHandshake(child, request, [{ id: "api-key" }, { id: "chat-gpt" }])
      if (request.method === "authenticate") authenticatedMethod = request.params.methodId
    })
  })
  await preferred.start()
  assert.equal(authenticatedMethod, "chat-gpt")
  preferred.close()

  let fellBack
  const missing = new AcpClient({
    preferredAuthMethod: "chat-gpt",
    spawnProcess: fakeSpawn((child, request) => {
      respondToHandshake(child, request, [{ id: "pi_terminal_login" }])
      if (request.method === "authenticate") fellBack = request.params.methodId
    })
  })
  await missing.start()
  assert.equal(fellBack, "pi_terminal_login", "an unadvertised preference must fall back to the generic choice")
  missing.close()
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

test("keeps the detail an adapter hides behind a generic error message", async () => {
  // Codex answers a refused load with a bare "Internal error" and puts the reason in data.details,
  // so the app showed nothing a user could act on for the commonest failure this backend has.
  const client = new AcpClient({
    spawnProcess: fakeSpawn((child, request) => {
      respondToHandshake(child, request)
      if (request.method === "session/load") {
        child.respond({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: "Internal error", data: { details: "thread session-1 already has an active writer" } }
        })
      }
      if (request.method === "session/plain") {
        child.respond({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Internal error" } })
      }
    })
  })
  await client.start()
  await assert.rejects(
    client.request("session/load", {}),
    /Internal error: thread session-1 already has an active writer/
  )
  await assert.rejects(client.request("session/plain", {}), /^Error: Internal error$/, "no detail must add no noise")
  client.close()
})

/** Builds an adapter that asks permission once, offering reject, allow-always and allow-once. */
function permissionAskingChild() {
  return new FakeChild((current, request) => {
    respondToHandshake(current, request)
    if (request.method !== "session/prompt") return
    current.respond({
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        options: [
          { optionId: "reject", kind: "reject_once", name: "Reject" },
          { optionId: "always", kind: "allow_always", name: "Always allow" },
          { optionId: "once", kind: "allow_once", name: "Allow once" }
        ]
      }
    })
    current.respond({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  })
}

test("grants tool permission once, so a tool call is not silently blocked", async () => {
  // Verified against PI's ACP adapter: it asks before every tool call, and answering with an
  // error meant it reported success while touching no file. allow_once is preferred over
  // allow_always so the grant covers this call rather than persisting in the harness.
  const child = permissionAskingChild()
  const client = new AcpClient({ permissionMode: "allow", spawnProcess: () => child })
  const granted = []
  client.on("permission", (event) => granted.push(event.optionId))
  await client.start()

  assert.deepEqual(await client.request("session/prompt", {}), { stopReason: "end_turn" })
  const reply = child.writes.find((message) => message.id === 99)
  assert.ok(reply, "a permission request must be answered")
  assert.equal(reply.error, undefined, "answering with an error blocks the tool call")
  assert.deepEqual(reply.result.outcome, { outcome: "selected", optionId: "once" })
  assert.deepEqual(granted, ["once"])
  client.close()
})

test("cancels a permission request unless the harness profile allows tools", async () => {
  const child = permissionAskingChild()
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()

  assert.deepEqual(await client.request("session/prompt", {}), { stopReason: "end_turn" })
  const reply = child.writes.find((message) => message.id === 99)
  assert.deepEqual(reply.result.outcome, { outcome: "cancelled" }, "granting must be opt-in per harness")
  client.close()
})

test("still declines agent-initiated requests it does not implement", async () => {
  const child = new FakeChild((current, request) => {
    respondToHandshake(current, request)
    if (request.method === "session/prompt") {
      current.respond({ jsonrpc: "2.0", id: 98, method: "fs/write_text_file", params: {} })
      current.respond({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
    }
  })
  const client = new AcpClient({ permissionMode: "allow", spawnProcess: () => child })
  const observed = []
  client.on("agent-request", (message) => observed.push(message.method))
  await client.start()

  assert.deepEqual(await client.request("session/prompt", {}), { stopReason: "end_turn" })
  assert.deepEqual(observed, ["fs/write_text_file"])
  const reply = child.writes.find((message) => message.id === 98)
  assert.ok(reply, "the bridge must reply rather than let the agent wait")
  assert.equal(reply.error.code, -32601)
  client.close()
})

test("reports why the adapter died instead of only its exit code", async () => {
  // The PI ACP adapter requires Bun, and when it is missing the shell explains that on
  // stderr while the exit code alone says nothing. Windows wraps the message over two
  // lines, so a single trailing line would drop the part that names the missing command.
  const child = new FakeChild((current, request) => {
    if (request.method !== "initialize") return
    current.stderr.emit("data", '"bun" is not recognized as an internal or external command,\n')
    current.stderr.emit("data", "operable program or batch file.\n")
    current.emit("exit", 1, null)
  })
  const client = new AcpClient({ spawnProcess: () => child })

  await assert.rejects(client.start(), (error) => {
    assert.match(error.message, /ACP adapter exited \(1\)/)
    assert.match(error.message, /"bun" is not recognized/, "the failing prerequisite must reach the caller")
    return true
  })
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

test("waits for a closing child before restart and ignores its late error", async () => {
  const children = []
  const client = new AcpClient({
    spawnProcess: () => {
      const child = new FakeChild((current, request) => respondToHandshake(current, request))
      children.push(child)
      return child
    }
  })
  await client.start()
  const first = children[0]
  const pendingRequest = client.request("session/hang", {})
  first.kill = (signal) => {
    first.killed = true
    first.stdin.writable = false
    first.signals = [...(first.signals || []), signal]
    return true
  }

  const closing = client.close()
  await assert.rejects(pendingRequest, /ACP adapter closed/, "close must reject pending RPCs before waiting for process exit")
  const restarting = client.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(children.length, 1, "restart must wait until the previous process exits")
  assert.deepEqual(first.signals, ["SIGTERM"])

  first.emit("exit", null, "SIGTERM")
  first.emit("close", null, "SIGTERM")
  await Promise.all([closing, restarting])
  assert.equal(children.length, 2)
  first.emit("error", new Error("late old child error"))
  assert.equal(client.processID, 4242, "an old process event must not clear the current child")
  await client.close()
})


test("Codex discovers native sessions without triggering interactive authentication", async () => {
  const profile = harnessProfile("codex")
  const sent = []
  const client = new AcpClient({
    authenticate: profile.authenticate,
    preferredAuthMethod: profile.authMethod,
    spawnProcess: fakeSpawn((child, request) => {
      sent.push(request.method)
      respondToHandshake(child, request, [{ id: "api-key" }, { id: "chat-gpt" }])
      if (request.method === "session/list") child.respond({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ sessionId: "desktop-session" }] } })
    })
  })
  try {
    assert.deepEqual(await client.listSessions(), [{ sessionId: "desktop-session" }])
    assert.equal(sent.includes("authenticate"), false)
  } finally { await client.close() }
})
