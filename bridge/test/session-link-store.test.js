import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { SessionLinkStore } from "../src/session-link-store.js"

const source = {
  machineID: "machine-1",
  agentID: "codex",
  sessionID: "codex-native-1",
  directory: "/repo"
}

const target = {
  machineID: "machine-1",
  agentID: "pi",
  sessionID: "pi-native-2",
  directory: "/repo"
}

test("handoff link survives restart and remains only metadata between real native Sessions", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-links-"))
  try {
    const first = new SessionLinkStore({ machineID: "machine-1", stateDirectory })
    const link = await first.addHandoff({ source, target, createdAt: "2026-08-24T14:00:00.000Z" })
    assert.deepEqual(link, {
      type: "handoff",
      source,
      target,
      createdAt: "2026-08-24T14:00:00.000Z"
    })

    const restarted = new SessionLinkStore({ machineID: "machine-1", stateDirectory })
    assert.deepEqual(await restarted.listFor(source), [link])
    assert.deepEqual(await restarted.listFor(target), [link])

    const duplicate = await restarted.addHandoff({ source, target, createdAt: "later" })
    assert.deepEqual(duplicate, link, "same native Session relationship must not be duplicated")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("cross-machine lineage is replicated only by participating machines", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-session-links-cross-machine-"))
  const crossTarget = { ...target, machineID: "machine-2", directory: "/other/repo" }
  const createdAt = "2026-09-11T17:20:00.000Z"
  const expected = { type: "handoff", source, target: crossTarget, createdAt }
  try {
    const sourceStore = new SessionLinkStore({ machineID: "machine-1", stateDirectory: path.join(root, "source") })
    const targetStore = new SessionLinkStore({ machineID: "machine-2", stateDirectory: path.join(root, "target") })
    const unrelatedStore = new SessionLinkStore({ machineID: "machine-3", stateDirectory: path.join(root, "unrelated") })

    assert.deepEqual(await sourceStore.addHandoff({ source, target: crossTarget, createdAt }), expected)
    assert.deepEqual(await targetStore.addHandoff({ source, target: crossTarget, createdAt }), expected)
    assert.deepEqual(await sourceStore.listFor(source), [expected])
    assert.deepEqual(await targetStore.listFor(crossTarget), [expected])

    await assert.rejects(
      () => unrelatedStore.addHandoff({ source, target: crossTarget, createdAt }),
      /must include a Session owned by this machine/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("handoff link can durably add the exact bounded transferred context", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-links-context-"))
  try {
    const first = new SessionLinkStore({ machineID: "machine-1", stateDirectory })
    const initial = await first.addHandoff({ source, target, createdAt: "2026-08-24T14:00:00.000Z" })
    const enriched = await first.addHandoff({
      source,
      target,
      createdAt: "later",
      transferredContext: "User: continue this work\n\nPI: prior answer"
    })
    assert.equal(enriched.createdAt, initial.createdAt)
    assert.equal(enriched.transferredContext, "User: continue this work\n\nPI: prior answer")

    const restarted = new SessionLinkStore({ machineID: "machine-1", stateDirectory })
    assert.deepEqual(await restarted.listFor(target), [enriched])
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
