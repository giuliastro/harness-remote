import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { AcpPromptEchoFilter } from "../src/acp-prompt-echo-filter.js"
import path from "node:path"
import test from "node:test"
import { ProjectScopedAcpClient } from "../src/project-scoped-acp-client.js"
import { AcpService } from "../src/acp-service.js"
import { harnessProfile } from "../src/harness-profiles.js"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

class FakeClient extends EventEmitter {
  constructor(root, sessions, calls) {
    super()
    this.root = root
    this.sessions = sessions
    this.calls = calls
    this.agentInfo = { name: "scoped", version: "1" }
    this.promptCapabilities = { image: true }
    this.sessionCapabilities = { load: true }
    this.processID = root.length
  }

  async start() { this.calls.push([this.root, "start"]) }
  async listSessionPage(cursor) {
    this.calls.push([this.root, "list", cursor])
    return { sessions: this.sessions, ...(cursor ? {} : { nextCursor: `${path.basename(this.root)}-older` }) }
  }
  async request(method, params) {
    this.calls.push([this.root, method, params])
    return method === "session/new" ? { sessionId: `${path.basename(this.root)}-new` } : {}
  }
  notify(method, params) { this.calls.push([this.root, method, params]) }
  close() { this.calls.push([this.root, "close"]) }
  diagnostics() { return { state: "running" } }
}

test("project-scoped ACP federates native indexes and keeps Session operations on their owning root", async () => {
  const calls = []
  const roots = [path.resolve("/work/alpha"), path.resolve("/work/beta")]
  const sessions = new Map([
    [roots[0], [{ sessionId: "alpha-1", cwd: path.join(roots[0], "repo"), updatedAt: "2026-01-01T00:00:00.000Z" }]],
    [roots[1], [{ sessionId: "beta-1", cwd: path.join(roots[1], "repo"), updatedAt: "2026-02-01T00:00:00.000Z" }]]
  ])
  const client = new ProjectScopedAcpClient({
    roots,
    createClient: (root) => new FakeClient(root, sessions.get(root), calls)
  })

  const first = await client.listSessionPage()
  assert.deepEqual(first.sessions.map((session) => session.sessionId), ["beta-1", "alpha-1"])
  assert.match(first.nextCursor, /^hr-project-scope:/)

  const betaDirectory = path.join(roots[1], "repo")
  const alphaDirectory = path.join(roots[0], "worktree")
  await client.request("session/load", { sessionId: "beta-1", cwd: betaDirectory })
  const created = await client.request("session/new", { cwd: alphaDirectory })
  client.notify("session/cancel", { sessionId: created.sessionId })

  assert.ok(calls.some(([root, method]) => root === betaDirectory && method === "session/load"))
  assert.ok(calls.some(([root, method]) => root === alphaDirectory && method === "session/new"))
  assert.ok(calls.some(([root, method]) => root === alphaDirectory && method === "session/cancel"))

  const second = await client.listSessionPage(first.nextCursor)
  assert.deepEqual(second.sessions.map((session) => session.sessionId), ["beta-1", "alpha-1"])
  assert.equal(second.nextCursor, undefined)
  await client.close()
})

test("project discovery does not replace the sandbox adapter bound by session/load", async () => {
  const calls = []
  const roots = [path.resolve("/work/alpha"), path.resolve("/work/beta")]
  const sandbox = path.join(roots[0], "repo", "worktrees", "feature")
  const nativeSession = { sessionId: "native-session", cwd: sandbox, updatedAt: "2026-03-01T00:00:00.000Z" }
  const sessions = new Map([
    [roots[0], [nativeSession]],
    [roots[1], []]
  ])
  const client = new ProjectScopedAcpClient({
    roots,
    createClient: (root) => new FakeClient(root, sessions.get(root) ?? [], calls)
  })

  const discovered = await client.listSessionPage()
  assert.deepEqual(discovered.sessions.map((session) => session.sessionId), ["native-session"])

  await client.request("session/load", { sessionId: "native-session", cwd: sandbox })
  assert.ok(calls.some(([root, method]) => root === sandbox && method === "session/load"))

  const rediscovered = await client.listSessionPage()
  assert.deepEqual(rediscovered.sessions.map((session) => session.sessionId), ["native-session"])

  await client.request("session/prompt", { sessionId: "native-session", prompt: [{ type: "text", text: "continue" }] })
  await client.request("session/set_config_option", { sessionId: "native-session", configId: "model", value: "test-model" })
  client.notify("session/cancel", { sessionId: "native-session" })

  for (const method of ["session/prompt", "session/set_config_option", "session/cancel"]) {
    assert.ok(calls.some(([root, calledMethod]) => root === sandbox && calledMethod === method), `${method} should use the sandbox adapter`)
    assert.equal(calls.some(([root, calledMethod]) => root === roots[0] && calledMethod === method), false, `${method} should not use the parent discovery adapter`)
  }
  await client.close()
})

test("project-scoped ACP forwards child events and closes every project adapter", async () => {
  const calls = []
  const roots = [path.resolve("/work/alpha"), path.resolve("/work/beta")]
  const children = []
  const client = new ProjectScopedAcpClient({
    roots,
    createClient: (root) => {
      const child = new FakeClient(root, [], calls)
      children.push(child)
      return child
    }
  })
  const notifications = []
  client.on("notification", (notification) => notifications.push(notification))

  await client.start()
  await client.request("session/new", { cwd: roots[1] })
  children[1].emit("notification", { method: "session/update", params: { sessionId: "beta" } })
  assert.equal(notifications.length, 1)
  assert.equal(client.diagnostics().configuredProjectCount, 2)
  assert.equal(client.diagnostics().activeProjectCount, 2)

  await client.close()
  assert.equal(calls.filter(([, method]) => method === "close").length, 2)
})

test("project discovery releases temporary adapters, bounds each page, and consumes every project and native page", async () => {
  const roots = ["alpha", "beta", "gamma", "delta"].map((name) => path.resolve(`/work/${name}`))
  let live = 0
  let peak = 0
  const client = new ProjectScopedAcpClient({
    roots,
    createClient: (root) => {
      live += 1
      peak = Math.max(peak, live)
      return {
        async listSessionPage(cursor) {
          const name = path.basename(root)
          return { sessions: [{ sessionId: `${name}-${cursor ? "old" : "new"}`, cwd: root }], ...(cursor ? {} : { nextCursor: "older" }) }
        },
        close() { live -= 1 }
      }
    }
  })
  const first = await client.listSessionPage()
  assert.equal(first.sessions.length, 2)
  assert.equal(live, 0)
  assert.equal(client.diagnostics().activeProjectCount, 0)
  const sessions = await client.listSessions()
  assert.deepEqual(sessions.map((session) => session.sessionId).sort(), roots.flatMap((root) => [`${path.basename(root)}-new`, `${path.basename(root)}-old`]).sort())
  assert.equal(live, 0)
  assert.equal(peak, 1)
  await client.close()
})

test("concurrent project scans share pages and never reuse a process slot before close completes", async () => {
  let live = 0
  let peak = 0
  let starts = 0
  const clients = Array.from({ length: 4 }, () => new ProjectScopedAcpClient({
    roots: ["/work/a", "/work/b"],
    createClient: () => {
      live += 1
      peak = Math.max(peak, live)
      starts += 1
      return {
        async listSessionPage() { await new Promise((resolve) => setTimeout(resolve, 5)); return { sessions: [] } },
        async close() { await new Promise((resolve) => setTimeout(resolve, 10)); live -= 1 }
      }
    }
  }))
  try {
    await Promise.all(clients.flatMap((client) => Array.from({ length: 8 }, () => client.listSessionPage())))
    assert.equal(starts, 8, "equal in-flight pages must share their two project readers")
    assert.ok(peak <= 3, `the shared process budget was exceeded: ${peak}`)
    assert.equal(live, 0, "all readers must actually exit before discovery resolves")
    await clients[0].listSessionPage()
    assert.equal(starts, 8, "ordinary refreshes reuse the short-lived page cache")
  } finally { await Promise.all(clients.map((client) => client.close())) }
})

test("idle project eviction invalidates the service's native handle so returning reopens the Session", async () => {
  const sessions = ["a", "b", "c"].map((id) => ({ sessionId: id, cwd: path.resolve(`/work/${id}`) }))
  const loads = []
  let disconnects = 0
  let live = 0
  let peak = 0
  const client = new ProjectScopedAcpClient({
    roots: [path.resolve("/work")],
    createClient: (root) => {
      const opened = new Set()
      live += 1
      peak = Math.max(peak, live)
      return Object.assign(new EventEmitter(), {
        async start() {},
        async listSessionPage() { return { sessions } },
        async request(method, params) {
          if (method === "session/load") { opened.add(params.sessionId); loads.push(params.sessionId); return { configOptions: [] } }
          if (method === "session/prompt") {
            assert.ok(opened.has(params.sessionId), `Session ${params.sessionId} was not reopened on ${root}`)
            return { stopReason: "end_turn" }
          }
          throw new Error(`Unexpected method ${method}`)
        },
        async close() { live -= 1; this.emit("exit", new Error("Project process closed")) }
      })
    }
  })
  client.on("exit", () => { disconnects += 1 })
  try {
    // The production server wraps the project client in its prompt-echo filter. Its lifecycle
    // events must reach the service through that decorator, too.
    const transport = new AcpPromptEchoFilter(client)
    assert.equal(typeof transport.withSession, "function")
    const service = new AcpService(transport, { refreshSessionListOnRead: false })
    for (const session of sessions) await service.models(session.sessionId)
    assert.equal(client.diagnostics().activeProjectCount, 2)
    assert.ok(peak <= 2)
    await service.promptAndWait("a", "continue")
    assert.equal(loads.filter((id) => id === "a").length, 2)
    assert.equal(disconnects, 0, "retiring an idle project must not disconnect the machine")
  } finally { await client.close() }
  assert.equal(live, 0)
})

test("busy project processes are never evicted or expanded beyond the resident limit", async () => {
  const pending = []
  let created = 0
  const client = new ProjectScopedAcpClient({
    roots: [path.resolve("/work")],
    createClient: () => {
      created += 1
      return Object.assign(new EventEmitter(), {
        async start() {},
        async request(method) {
          if (method === "session/prompt") return new Promise((resolve) => pending.push(resolve))
          return {}
        },
        close() {}
      })
    }
  })
  try {
    await client.request("session/load", { sessionId: "a", cwd: "/work/a" })
    await client.request("session/load", { sessionId: "b", cwd: "/work/b" })
    const first = client.request("session/prompt", { sessionId: "a" })
    const second = client.request("session/prompt", { sessionId: "b" })
    await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(client.request("session/load", { sessionId: "c", cwd: "/work/c" }), /MiMo is busy in 2 projects/)
    assert.equal(created, 2)
    for (const resolve of pending) resolve({ stopReason: "cancelled" })
    await Promise.all([first, second])
  } finally { await client.close() }
})

test("status handshakes do not pin the oldest idle project against eviction", async () => {
  const closed = []
  const client = new ProjectScopedAcpClient({ roots: ["/work/a"],
    createClient: (root) => new FakeClient(root, [], []) })
  client.on("sessions-closed", (ids) => closed.push(...ids))
  try {
    await client.request("session/load", { sessionId: "a", cwd: "/work/a" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await client.request("session/load", { sessionId: "b", cwd: "/work/b" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await client.start()
    await client.request("session/load", { sessionId: "c", cwd: "/work/c" })
    assert.deepEqual(closed, ["a"])
  } finally { await client.close() }
})

test("MiMo complete native replay replaces a duplicated cached transcript after a project reopens", async () => {
  const sessionID = "mimo-reopened"
  const directory = await mkdtemp(path.join(tmpdir(), "hr-mimo-replay-"))
  const snapshotPath = path.join(directory, `${Buffer.from(sessionID).toString("base64url")}.json`)
  const message = (id, role, text) => ({ info: { id, role, sessionID }, parts: [{ type: "text", text }] })
  const poison = [message("old-user", "user", "test"), message("old-answer", "assistant", "OKOK"), message("duplicate-user", "user", "test")]
  await writeFile(snapshotPath, JSON.stringify({ version: 1, messages: poison }))
  let service
  const waitForSnapshotWrites = async () => {
    if (!service) return
    const deadline = Date.now() + 10_000
    while (service.diagnostics().snapshotWrites > 0) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for MiMo snapshot writes to finish (${service.diagnostics().snapshotWrites} still pending)`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  class Replay extends EventEmitter {
    async listSessions() { return [{ sessionId: sessionID, cwd: "/work/a" }] }
    async request(method) {
      assert.equal(method, "session/load")
      for (const [id, role, text] of [["native-user", "user", "test"], ["native-answer", "agent", "OK"]]) {
        this.emit("notification", { method: "session/update", params: { sessionId: sessionID,
          update: { sessionUpdate: `${role}_message_chunk`, messageId: id, content: { type: "text", text } } } })
      }
      return { configOptions: [] }
    }
  }
  try {
    service = new AcpService(new Replay(), { snapshotDirectory: directory, replayAuthoritative: harnessProfile("mimo").replayAuthoritative })
    const messages = await service.messages(sessionID)
    assert.deepEqual(messages.map((m) => [m.info.role, m.parts.map((p) => p.text).join("")]), [["user", "test"], ["assistant", "OK"]])
    await waitForSnapshotWrites()
    const saved = JSON.parse(await readFile(snapshotPath, "utf8"))
    assert.deepEqual(saved.messages.map((m) => [m.info.role, m.parts.map((p) => p.text).join("")]), [["user", "test"], ["assistant", "OK"]])
  } finally {
    try {
      await waitForSnapshotWrites()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test("one logical Session operation keeps its project pinned between individual RPCs", async () => {
  const closed = []
  const client = new ProjectScopedAcpClient({ roots: ["/work/a"],
    createClient: (root) => new FakeClient(root, [], []) })
  client.on("sessions-closed", (ids) => closed.push(...ids))
  try {
    await client.request("session/load", { sessionId: "a", cwd: "/work/a" })
    await client.withSession("a", "/work/a", async () => {
      await client.request("session/load", { sessionId: "b", cwd: "/work/b" })
      await client.request("session/load", { sessionId: "c", cwd: "/work/c" })
      assert.deepEqual(closed, ["b"], "another project's operation must not retire this Session between model choice and prompt")
      await client.request("session/prompt", { sessionId: "a", prompt: [] })
    })
  } finally { await client.close() }
})
