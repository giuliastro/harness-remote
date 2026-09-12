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

function serverWith({ projects, projectOutcome }) {
  return createAgentRoutingServer({
    daemon: daemon(),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: new BridgeServer(),
    taskStore: { async list() { return [] } },
    projectCatalog: async () => projects,
    projectOutcome,
    worktreeManager: {}
  })
}

test("Project outcome is read only and scoped to an exact catalog project id", async () => {
  const calls = []
  const server = serverWith({
    projects: [{ id: "machine-1:repo", machineId: "machine-1", name: "repo", path: "/repo", kind: "git" }],
    projectOutcome: async (projectPath) => {
      calls.push(projectPath)
      return {
        version: 1,
        vcs: "git",
        head: "abc",
        branch: "feature/outcome",
        dirty: true,
        files: [{ path: "src/app.js", indexStatus: " ", worktreeStatus: "M" }],
        totalChangedFiles: 1,
        filesTruncated: false
      }
    }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/project-outcome?projectId=${encodeURIComponent("machine-1:repo")}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      projectId: "machine-1:repo",
      outcome: {
        version: 1,
        vcs: "git",
        head: "abc",
        branch: "feature/outcome",
        dirty: true,
        files: [{ path: "src/app.js", indexStatus: " ", worktreeStatus: "M" }],
        totalChangedFiles: 1,
        filesTruncated: false
      }
    })
    assert.deepEqual(calls, ["/repo"])
  } finally {
    await close(server)
  }
})

test("unknown Project ids cannot be turned into arbitrary filesystem outcome probes", async () => {
  let inspected = false
  const server = serverWith({
    projects: [{ id: "machine-1:repo", machineId: "machine-1", name: "repo", path: "/repo", kind: "git" }],
    projectOutcome: async () => { inspected = true; return null }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/project-outcome?projectId=${encodeURIComponent("/etc")}`)
    assert.equal(response.status, 404)
    assert.equal(inspected, false)
  } finally {
    await close(server)
  }
})

test("non Git Projects have no Git outcome and never invoke the inspector", async () => {
  let inspected = false
  const server = serverWith({
    projects: [{ id: "machine-1:notes", machineId: "machine-1", name: "notes", path: "/notes", kind: "directory" }],
    projectOutcome: async () => { inspected = true; return { version: 1, vcs: "git" } }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/project-outcome?projectId=${encodeURIComponent("machine-1:notes")}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { projectId: "machine-1:notes", outcome: null })
    assert.equal(inspected, false)
  } finally {
    await close(server)
  }
})

test("missing projectId is rejected before any Project inspection", async () => {
  let inspected = false
  const server = serverWith({
    projects: [],
    projectOutcome: async () => { inspected = true; return null }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/project-outcome`)
    assert.equal(response.status, 400)
    assert.equal(inspected, false)
  } finally {
    await close(server)
  }
})
