import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createCrossMachineHandoffServer } from "../src/cross-machine-handoff-server.js"

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

test("ledger accept failure after target creation becomes uncertain and is never replayed", async () => {
  let creates = 0
  let entry
  const operationLedger = {
    async begin(input) {
      if (entry) return { duplicate: true, state: entry.state, entry: structuredClone(entry) }
      entry = { ...input, state: "pending" }
      return { duplicate: false, state: "pending", entry: structuredClone(entry) }
    },
    async accept() {
      throw new Error("disk full after session/new")
    },
    async fail(input) {
      assert.equal(input.ambiguous, true)
      entry = { ...entry, state: "uncertain" }
    }
  }
  const project = { id: "machine-b:repo", machineId: "machine-b", path: "/target/repo", kind: "git" }
  const server = createCrossMachineHandoffServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    projectCatalog: async () => [project],
    operationLedger,
    async createTargetSession(input) {
      creates += 1
      return {
        target: {
          machineID: "machine-b",
          agentID: input.targetAgentID,
          sessionID: "created-but-ledger-write-failed",
          directory: project.path
        }
      }
    }
  })
  const port = await listen(server)
  const payload = {
    clientRequestId: "ledger-failure-1",
    source: { machineID: "machine-a", agentID: "codex", sessionID: "source-1", directory: "/source/repo" },
    projectId: project.id,
    targetAgentID: "pi"
  }
  const post = () => fetch(`http://127.0.0.1:${port}/v1/session-handoff-target`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
  try {
    const first = await post()
    assert.equal(first.status, 202)
    assert.equal((await first.json()).status, "uncertain")

    const retry = await post()
    assert.equal(retry.status, 202)
    assert.equal((await retry.json()).status, "uncertain")
    assert.equal(creates, 1, "a failed accepted-ledger write must never permit a second target creation")
  } finally {
    await close(server)
  }
})
