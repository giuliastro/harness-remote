import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ApprovalDecisionStore } from "../src/approval-decision-store.js"

async function stateDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "hr-approval-decisions-"))
}

function identity(overrides = {}) {
  return {
    machineID: "machine-1",
    agentID: "opencode",
    sessionID: "session-1",
    directory: "/work/project",
    ...overrides
  }
}

function decision(overrides = {}) {
  return {
    ...identity(),
    requestID: "permission-1",
    requestedAction: "write",
    boundary: ["src/**"],
    explanation: "The tool needs to update project files.",
    decision: "once",
    decidedAt: "2026-09-11T07:50:00.000Z",
    ...overrides
  }
}

test("persists and reloads observational approval decisions", async () => {
  const directory = await stateDirectory()
  const first = new ApprovalDecisionStore({ machineID: "machine-1", stateDirectory: directory })
  const recorded = await first.record(decision())
  assert.equal(recorded.type, "authorization-decision")
  assert.equal(recorded.semantics, "one-shot")

  const second = new ApprovalDecisionStore({ machineID: "machine-1", stateDirectory: directory })
  assert.deepEqual(await second.listFor(identity()), [recorded])
  const payload = JSON.parse(await readFile(path.join(directory, "approval-decisions.json"), "utf8"))
  assert.equal(payload.machineID, "machine-1")
  assert.equal(payload.records.length, 1)
})

test("same request and decision are idempotent but a conflicting decision is rejected", async () => {
  const directory = await stateDirectory()
  const store = new ApprovalDecisionStore({ machineID: "machine-1", stateDirectory: directory })
  const first = await store.record(decision())
  const second = await store.record(decision({ decidedAt: "2026-09-11T07:51:00.000Z" }))
  assert.deepEqual(second, first)
  await assert.rejects(() => store.record(decision({ decision: "reject" })), /different recorded decision/i)
})

test("decision semantics are descriptive metadata, not reusable Harness Remote authority", async () => {
  const directory = await stateDirectory()
  const store = new ApprovalDecisionStore({ machineID: "machine-1", stateDirectory: directory })
  const once = await store.record(decision({ requestID: "once", decision: "once" }))
  const always = await store.record(decision({ requestID: "always", decision: "always", decidedAt: "2026-09-11T07:51:00.000Z" }))
  const reject = await store.record(decision({ requestID: "reject", decision: "reject", decidedAt: "2026-09-11T07:52:00.000Z" }))
  assert.equal(once.semantics, "one-shot")
  assert.equal(always.semantics, "harness-reusable")
  assert.equal(reject.semantics, "denied")
  for (const record of [once, always, reject]) {
    assert.equal("authorized" in record, false)
    assert.equal("replay" in record, false)
  }
})

test("list is machine/session scoped and newest first", async () => {
  const directory = await stateDirectory()
  const store = new ApprovalDecisionStore({ machineID: "machine-1", stateDirectory: directory })
  await store.record(decision({ requestID: "old", decidedAt: "2026-09-11T07:50:00.000Z" }))
  await store.record(decision({ requestID: "new", decidedAt: "2026-09-11T07:52:00.000Z" }))
  await store.record(decision({ requestID: "other", sessionID: "session-2", decidedAt: "2026-09-11T07:53:00.000Z" }))
  assert.deepEqual((await store.listFor(identity())).map((entry) => entry.requestID), ["new", "old"])
  await assert.rejects(() => store.listFor(identity({ machineID: "machine-2" })), /target this machine/i)
})

test("bounds retained decisions and validates provider-neutral record fields", async () => {
  const directory = await stateDirectory()
  const store = new ApprovalDecisionStore({ machineID: "machine-1", stateDirectory: directory, limit: 2 })
  await store.record(decision({ requestID: "one", decidedAt: "2026-09-11T07:50:00.000Z" }))
  await store.record(decision({ requestID: "two", decidedAt: "2026-09-11T07:51:00.000Z" }))
  await store.record(decision({ requestID: "three", decidedAt: "2026-09-11T07:52:00.000Z" }))
  assert.deepEqual((await store.listFor(identity())).map((entry) => entry.requestID), ["three", "two"])
  await assert.rejects(() => store.record(decision({ requestID: "bad", decision: "approve" })), /once, always or reject/i)
  await assert.rejects(() => store.record(decision({ requestID: "bad-boundary", boundary: new Array(65).fill("x") })), /too many entries/i)
  await assert.rejects(() => store.record(decision({ machineID: "machine-2" })), /machine scope/i)
})

test("corrupt state is quarantined rather than blocking future records", async () => {
  const directory = await stateDirectory()
  await writeFile(path.join(directory, "approval-decisions.json"), "{not-json", "utf8")
  const store = new ApprovalDecisionStore({ machineID: "machine-1", stateDirectory: directory })
  assert.deepEqual(await store.listFor(identity()), [])
  const files = await readdir(directory)
  assert.ok(files.some((name) => name.startsWith("approval-decisions.json.corrupt-")))
  await store.record(decision())
  assert.equal((await store.listFor(identity())).length, 1)
})
