import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createCrossMachineHandoffServer, targetCreationLedgerIdentity } from "../src/cross-machine-handoff-server.js"
import { SessionOperationLedger } from "../src/session-operation-ledger.js"

const source = {
  machineID: "machine-a",
  agentID: "codex",
  sessionID: "native-1",
  directory: "/source/repo"
}

const project = {
  id: "machine-b:repo",
  machineId: "machine-b",
  name: "repo",
  path: "/target/repo",
  kind: "git"
}

function body(overrides = {}) {
  return {
    clientRequestId: "cross-request-1",
    source,
    projectId: project.id,
    targetAgentID: "pi",
    model: { providerID: "openai", modelID: "gpt-5.6-codex" },
    variant: "high",
    title: "Continue native work",
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

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

async function withServer(options, run) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-cross-machine-target-"))
  const operationLedger = new SessionOperationLedger({ machineID: "machine-b", stateDirectory })
  const server = createCrossMachineHandoffServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    projectCatalog: async () => [project],
    operationLedger,
    ...options
  })
  const port = await listen(server)
  try { return await run(port, operationLedger) }
  finally {
    await close(server)
    await rm(stateDirectory, { recursive: true, force: true })
  }
}

function post(port, payload = body()) {
  return fetch(`http://127.0.0.1:${port}/v1/session-handoff-target`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
}

test("target-create resolves the target path from projectId and accepted retry returns the exact same native Session", async () => {
  let creates = 0
  const expected = {
    target: { machineID: "machine-b", agentID: "pi", sessionID: "pi-native-2", directory: project.path }
  }
  await withServer({
    async createTargetSession(input) {
      creates += 1
      assert.deepEqual(input.source, source)
      assert.equal(input.project.id, project.id)
      assert.equal(input.project.path, project.path)
      assert.equal(input.targetAgentID, "pi")
      assert.deepEqual(input.model, { providerID: "openai", modelID: "gpt-5.6-codex" })
      return expected
    }
  }, async (port) => {
    const first = await post(port)
    const retry = await post(port)
    assert.equal(first.status, 200)
    assert.equal(retry.status, 200)
    assert.deepEqual((await first.json()).result, expected)
    assert.deepEqual((await retry.json()).result, expected)
    assert.equal(creates, 1)
  })
})

test("client cannot smuggle a target directory and unknown Projects never dispatch creation", async () => {
  let creates = 0
  await withServer({ async createTargetSession() { creates += 1 } }, async (port) => {
    const arbitraryPath = await post(port, body({ directory: "/etc" }))
    assert.equal(arbitraryPath.status, 400)
    assert.match((await arbitraryPath.json()).error, /derived from projectId/)

    const unknown = await post(port, body({ clientRequestId: "unknown-project", projectId: "machine-b:missing" }))
    assert.equal(unknown.status, 404)
    assert.match((await unknown.json()).error, /Unknown project/)
    assert.equal(creates, 0)
  })
})

test("semantic changes conflict under the same source-scoped durable request id", async () => {
  let creates = 0
  await withServer({
    async createTargetSession(input) {
      creates += 1
      return { target: { machineID: "machine-b", agentID: input.targetAgentID, sessionID: "native-2", directory: project.path } }
    }
  }, async (port) => {
    assert.equal((await post(port)).status, 200)
    const conflict = await post(port, body({ targetAgentID: "omp" }))
    assert.equal(conflict.status, 409)
    assert.match((await conflict.json()).error, /already used for a different native Session operation/)
    assert.equal(creates, 1)
  })
})

test("source identity is part of the ledger scope so identical native ids on different machines do not collide", async () => {
  let creates = 0
  await withServer({
    async createTargetSession(input) {
      creates += 1
      return {
        target: {
          machineID: "machine-b",
          agentID: input.targetAgentID,
          sessionID: `target-${creates}`,
          directory: project.path
        }
      }
    }
  }, async (port) => {
    const first = await post(port)
    const secondSource = { ...source, machineID: "machine-c" }
    const second = await post(port, body({ source: secondSource }))
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.notEqual((await first.json()).result.target.sessionID, (await second.json()).result.target.sessionID)
    assert.equal(creates, 2)

    const firstScope = targetCreationLedgerIdentity(body())
    const secondScope = targetCreationLedgerIdentity(body({ source: secondSource }))
    assert.notEqual(firstScope.sessionID, secondScope.sessionID)
    assert.equal(firstScope.sessionID.includes(source.directory), false)
  })
})

test("checkpointed target identity survives later enrichment failure and prevents duplicate creation", async () => {
  let creates = 0
  const expected = {
    target: { machineID: "machine-b", agentID: "pi", sessionID: "checkpointed-target", directory: project.path }
  }
  await withServer({
    async createTargetSession(_input, { checkpoint }) {
      creates += 1
      await checkpoint(expected)
      throw new Error("lineage enrichment failed")
    }
  }, async (port) => {
    const first = await post(port)
    const retry = await post(port)
    assert.equal(first.status, 200)
    assert.equal(retry.status, 200)
    assert.deepEqual((await first.json()).result, expected)
    assert.deepEqual((await retry.json()).result, expected)
    assert.equal(creates, 1)
  })
})

test("ambiguous creation is never replayed and one unique read-only reconciliation can make it durable", async () => {
  let creates = 0
  let reconciles = 0
  const recovery = {
    kind: "cross-machine-target-create",
    targetAgentID: "pi",
    projectId: project.id,
    beforeSessionIDs: ["old-target"]
  }
  const expected = {
    target: { machineID: "machine-b", agentID: "pi", sessionID: "recovered-target", directory: project.path }
  }
  await withServer({
    async createTargetSession() {
      creates += 1
      const error = new Error("session/new response lost")
      error.ambiguous = true
      error.recovery = recovery
      throw error
    },
    async reconcileTargetSession(input, storedRecovery) {
      reconciles += 1
      assert.deepEqual(input.source, source)
      assert.equal(input.project.path, project.path)
      assert.deepEqual(storedRecovery, recovery)
      return expected
    }
  }, async (port) => {
    const first = await post(port)
    assert.equal(first.status, 202)
    assert.equal((await first.json()).status, "uncertain")

    const retry = await post(port)
    assert.equal(retry.status, 200)
    assert.deepEqual((await retry.json()).result, expected)
    assert.equal(creates, 1)
    assert.equal(reconciles, 1)

    const stable = await post(port)
    assert.equal(stable.status, 200)
    assert.deepEqual((await stable.json()).result, expected)
    assert.equal(creates, 1)
    assert.equal(reconciles, 1)
  })
})
