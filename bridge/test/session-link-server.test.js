import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createSessionClaimServer } from "../src/session-claim-server.js"
import { SessionLinkStore } from "../src/session-link-store.js"

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}

function createLinkServer(machineID, stateDirectory) {
  const sessionLinkStore = new SessionLinkStore({ machineID, stateDirectory })
  return createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    sessionLinkStore
  })
}

test("machine Session-link endpoint mirrors and reads lineage", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-link-route-"))
  const server = createLinkServer("machine-1", stateDirectory)
  const port = await listen(server)
  const link = {
    type: "handoff",
    source: { machineID: "machine-1", agentID: "codex", sessionID: "source-1", directory: "/repo" },
    target: { machineID: "machine-1", agentID: "pi", sessionID: "target-2", directory: "/repo" },
    createdAt: "2026-08-29T07:00:00.000Z"
  }
  try {
    const registered = await fetch(`http://127.0.0.1:${port}/v1/session-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link })
    })
    assert.equal(registered.status, 200)
    const params = new URLSearchParams(link.source)
    const listed = await fetch(`http://127.0.0.1:${port}/v1/session-links?${params}`)
    assert.equal(listed.status, 200)
    assert.deepEqual((await listed.json()).links, [link])

    const enriched = { ...link, transferredContext: "User: persisted transfer" }
    const update = await fetch(`http://127.0.0.1:${port}/v1/session-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link: enriched })
    })
    assert.equal(update.status, 200)
    const listedAgain = await fetch(`http://127.0.0.1:${port}/v1/session-links?${params}`)
    assert.deepEqual((await listedAgain.json()).links, [enriched])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("cross-machine Session-link endpoint accepts the same edge on both participating daemons", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-link-route-cross-machine-"))
  const sourceServer = createLinkServer("machine-1", path.join(root, "source"))
  const targetServer = createLinkServer("machine-2", path.join(root, "target"))
  const unrelatedServer = createLinkServer("machine-3", path.join(root, "unrelated"))
  const sourcePort = await listen(sourceServer)
  const targetPort = await listen(targetServer)
  const unrelatedPort = await listen(unrelatedServer)
  const link = {
    type: "handoff",
    source: { machineID: "machine-1", agentID: "codex", sessionID: "source-1", directory: "/repo-a" },
    target: { machineID: "machine-2", agentID: "pi", sessionID: "target-2", directory: "/repo-b" },
    createdAt: "2026-09-11T17:20:00.000Z"
  }
  const register = (port) => fetch(`http://127.0.0.1:${port}/v1/session-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ link })
  })
  try {
    assert.equal((await register(sourcePort)).status, 200)
    assert.equal((await register(targetPort)).status, 200)
    assert.equal((await register(unrelatedPort)).status, 500)

    const sourceQuery = new URLSearchParams(link.source)
    const targetQuery = new URLSearchParams(link.target)
    const sourceList = await fetch(`http://127.0.0.1:${sourcePort}/v1/session-links?${sourceQuery}`)
    const targetList = await fetch(`http://127.0.0.1:${targetPort}/v1/session-links?${targetQuery}`)
    assert.deepEqual((await sourceList.json()).links, [link])
    assert.deepEqual((await targetList.json()).links, [link])
  } finally {
    await Promise.all([
      new Promise((resolve) => sourceServer.close(resolve)),
      new Promise((resolve) => targetServer.close(resolve)),
      new Promise((resolve) => unrelatedServer.close(resolve))
    ])
    await rm(root, { recursive: true, force: true })
  }
})
