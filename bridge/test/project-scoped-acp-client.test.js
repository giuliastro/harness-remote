import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import path from "node:path"
import test from "node:test"
import { ProjectScopedAcpClient } from "../src/project-scoped-acp-client.js"

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

  await client.listSessions()
  children[1].emit("notification", { method: "session/update", params: { sessionId: "beta" } })
  assert.equal(notifications.length, 1)
  assert.equal(client.diagnostics().configuredProjectCount, 2)
  assert.equal(client.diagnostics().activeProjectCount, 2)

  client.close()
  assert.equal(calls.filter(([, method]) => method === "close").length, 2)
})
