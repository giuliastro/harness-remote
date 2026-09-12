import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { normalizePortableHandoffState } from "../src/portable-handoff-state.js"
import { SessionLinkStore } from "../src/session-link-store.js"
import { createSessionClaimServer } from "../src/session-claim-server.js"

const source = { machineID: "machine-1", agentID: "codex", sessionID: "source-1", directory: "/private/source" }
const target = { machineID: "machine-2", agentID: "claude", sessionID: "target-1", directory: "/private/target" }

function portable(overrides = {}) {
  return {
    version: 1,
    task: { title: "Fix bridge regression", state: "continuing" },
    project: {
      sourceProjectId: "source-project",
      targetProjectId: "target-project",
      decision: "review",
      reason: "workspace_diverged",
      evidence: {
        project: "match",
        repository: "match",
        history: "match",
        branch: "different",
        head: "different",
        sourceDirty: false,
        targetDirty: true,
        exactWorkspace: false
      }
    },
    controls: {
      sourceAuthority: "invalidated",
      targetAuthorization: "re_evaluate",
      attachments: "not_transferred"
    },
    ...overrides
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}

test("portable handoff state is canonical and strips unknown authority/path/tool fields", () => {
  const normalized = normalizePortableHandoffState({
    ...portable(),
    permission: [{ action: "allow", pattern: "deploy prod" }],
    path: "/must/not/cross",
    toolState: { shell: "owned" },
    task: { ...portable().task, prompt: "secret prompt", approval: "allow" },
    project: { ...portable().project, sourcePath: "/source", targetPath: "/target", branchName: "secret-branch" }
  })
  assert.deepEqual(normalized, portable())
  const serialized = JSON.stringify(normalized)
  assert.equal(serialized.includes("deploy prod"), false)
  assert.equal(serialized.includes("must/not/cross"), false)
  assert.equal(serialized.includes("secret prompt"), false)
  assert.equal(serialized.includes("secret-branch"), false)
  assert.equal(serialized.includes("toolState"), false)
})

test("blocked Project evidence cannot be persisted as portable handoff state", () => {
  assert.throws(
    () => normalizePortableHandoffState(portable({
      project: {
        ...portable().project,
        decision: "review",
        reason: "workspace_diverged",
        evidence: { ...portable().project.evidence, repository: "different" }
      }
    })),
    /blocked Project mismatch/
  )
})

test("Session link store persists canonical portable state across restart", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-portable-link-"))
  try {
    const first = new SessionLinkStore({ machineID: "machine-1", stateDirectory })
    const link = await first.addHandoff({
      source,
      target,
      transferredContext: "bounded context",
      portableState: { ...portable(), permission: "allow", remotePath: "/private/target" }
    })
    assert.deepEqual(link.portableState, portable())

    const restarted = new SessionLinkStore({ machineID: "machine-1", stateDirectory })
    const [reloaded] = await restarted.listFor(source)
    assert.deepEqual(reloaded.portableState, portable())
    assert.equal(JSON.stringify(reloaded).includes("permission"), false)
    assert.equal(JSON.stringify(reloaded).includes("remotePath"), false)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("Session-link HTTP boundary accepts safe portable state and rejects blocked evidence", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-portable-http-"))
  const store = new SessionLinkStore({ machineID: "machine-1", stateDirectory })
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    sessionLinkStore: store
  })
  const port = await listen(server)
  const endpoint = `http://127.0.0.1:${port}/v1/session-links`
  const baseLink = { type: "handoff", source, target, createdAt: "2026-09-12T05:00:00.000Z" }
  try {
    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        link: {
          ...baseLink,
          portableState: { ...portable(), permission: "allow", path: "/must/not/persist" }
        }
      })
    })
    assert.equal(accepted.status, 200)
    const acceptedBody = await accepted.json()
    assert.deepEqual(acceptedBody.link.portableState, portable())
    assert.equal(JSON.stringify(acceptedBody).includes("must/not/persist"), false)

    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        link: {
          ...baseLink,
          portableState: portable({
            project: {
              ...portable().project,
              evidence: { ...portable().project.evidence, history: "different" }
            }
          })
        }
      })
    })
    assert.equal(rejected.status, 400)
    assert.match((await rejected.json()).error, /blocked Project mismatch/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
