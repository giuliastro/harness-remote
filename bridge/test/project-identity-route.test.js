import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createAgentRoutingServer } from "../src/agent-router.js"

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

class BridgeServer extends EventEmitter {}

function daemon() {
  return {
    registry: { host: () => ({ state: "available" }) },
    hostEntry: () => undefined,
    snapshot: () => ({ machine: { id: "machine-1" }, agents: [] })
  }
}

function serverWith({ projects, projectIdentity }) {
  return createAgentRoutingServer({
    daemon: daemon(),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: new BridgeServer(),
    taskStore: { async list() { return [] } },
    projectCatalog: async () => projects,
    projectIdentity,
    worktreeManager: {}
  })
}

test("project identity is read only and scoped to an exact catalog project id", async () => {
  const calls = []
  const server = serverWith({
    projects: [{ id: "machine-1:repo", machineId: "machine-1", name: "repo", path: "/repo", kind: "git" }],
    projectIdentity: async (projectPath) => {
      calls.push(projectPath)
      return { version: 1, vcs: "git", repositoryFingerprint: "a".repeat(64), head: "abc", dirty: false }
    }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/project-identity?projectId=${encodeURIComponent("machine-1:repo")}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      projectId: "machine-1:repo",
      identity: { version: 1, vcs: "git", repositoryFingerprint: "a".repeat(64), head: "abc", dirty: false }
    })
    assert.deepEqual(calls, ["/repo"])
  } finally {
    await close(server)
  }
})

test("unknown project ids cannot be turned into arbitrary filesystem probes", async () => {
  let inspected = false
  const server = serverWith({
    projects: [{ id: "machine-1:repo", machineId: "machine-1", name: "repo", path: "/repo", kind: "git" }],
    projectIdentity: async () => { inspected = true; return null }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/project-identity?projectId=${encodeURIComponent("/etc")}`)
    assert.equal(response.status, 404)
    assert.equal(inspected, false)
  } finally {
    await close(server)
  }
})

test("non Git catalog projects are explicitly unverified and do not invoke Git", async () => {
  let inspected = false
  const server = serverWith({
    projects: [{ id: "machine-1:notes", machineId: "machine-1", name: "notes", path: "/notes", kind: "directory" }],
    projectIdentity: async () => { inspected = true; return { version: 1, vcs: "git" } }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/project-identity?projectId=${encodeURIComponent("machine-1:notes")}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { projectId: "machine-1:notes", identity: null })
    assert.equal(inspected, false)
  } finally {
    await close(server)
  }
})
