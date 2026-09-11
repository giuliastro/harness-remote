import assert from "node:assert/strict"
import { acknowledgeCrossMachineTargetSession, createCrossMachineTargetSession } from "./cross-machine-target-client.ts"
import { acknowledgeNativeSessionHandoff, handoffNativeSession } from "./native-session-handoff.ts"

class MemoryStorage {
  constructor(entries = []) { this.map = new Map(entries) }
  get length() { return this.map.size }
  key(index) { return [...this.map.keys()][index] ?? null }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(String(key), String(value)) }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
}

const source = {
  key: "machine-1:pi:source-1",
  ref: { machineID: "machine-1", agentID: "pi", sessionID: "source-1", directory: "/repo" },
  machineID: "machine-1",
  agentID: "pi",
  agentLabel: "PI",
  backend: "pi",
  transport: "acp",
  sessionID: "source-1",
  directory: "/repo",
  title: "Source",
  config: {
    backend: "pi",
    agentId: "pi",
    host: "127.0.0.1",
    port: 4999,
    username: "",
    password: ""
  },
  external: false,
  modelsSupported: true,
  commandsSupported: false,
  renameSupported: false,
  deleteSupported: false,
  requiresExplicitClaim: false,
  canStop: true
}

const storageKey = "harness-remote.native-session-handoff.v1:machine-1:pi:source-1"
const oldCreatedAt = Date.now() - (24 * 60 * 60 * 1000)
const model = { providerID: "omp", modelID: "omp-fast" }
const oldPending = {
  clientRequestId: "handoff-old-request",
  targetAgentID: "omp",
  title: "Source",
  model,
  createdAt: oldCreatedAt
}

const originalStorage = globalThis.localStorage
const originalFetch = globalThis.fetch
try {
  const storage = new MemoryStorage([[storageKey, JSON.stringify(oldPending)]])
  globalThis.localStorage = storage

  let acceptedBody
  globalThis.fetch = async (_url, options) => {
    acceptedBody = JSON.parse(options.body)
    return new Response(JSON.stringify({
      status: "accepted",
      result: {
        target: { machineID: "machine-1", agentID: "omp", sessionID: "target-1", directory: "/repo" },
        link: {
          type: "handoff",
          source: source.ref,
          target: { machineID: "machine-1", agentID: "omp", sessionID: "target-1", directory: "/repo" },
          createdAt: new Date().toISOString()
        }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }

  const accepted = await handoffNativeSession(source, "omp", "Source", model)
  assert.equal(accepted.status, "accepted")
  assert.equal(acceptedBody.clientRequestId, oldPending.clientRequestId, "resource creation must reuse its idempotency key even after 24 hours")
  assert.equal(
    JSON.parse(storage.getItem(storageKey)).clientRequestId,
    oldPending.clientRequestId,
    "accepted creation must retain its key until the caller durably stores the returned target"
  )
  acknowledgeNativeSessionHandoff(source)
  assert.equal(storage.getItem(storageKey), null, "caller acknowledgement may clear the creation key after target persistence")

  storage.setItem(storageKey, JSON.stringify(oldPending))
  globalThis.fetch = async () => { throw new Error("lost response") }
  await assert.rejects(
    () => handoffNativeSession(source, "omp", "Source", model),
    /delivery status is unknown/
  )
  assert.equal(
    JSON.parse(storage.getItem(storageKey)).clientRequestId,
    oldPending.clientRequestId,
    "ambiguous resource creation must retain the original idempotency key without TTL expiry"
  )

  storage.setItem(storageKey, JSON.stringify({ ...oldPending, clientRequestId: "definite-rejection" }))
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "model rejected" }), {
    status: 409,
    headers: { "Content-Type": "application/json" }
  })
  await assert.rejects(() => handoffNativeSession(source, "omp", "Source", model), /model rejected/)
  assert.equal(storage.getItem(storageKey), null, "a definite 4xx may release the resource-creation key")

  let attemptedWithoutRecoveryStorage = false
  globalThis.localStorage = {
    get length() { return 0 },
    key() { return null },
    getItem() { return null },
    setItem() { throw new Error("storage full") },
    removeItem() {},
    clear() {}
  }
  globalThis.fetch = async () => {
    attemptedWithoutRecoveryStorage = true
    throw new Error("network should not be reached")
  }
  await assert.rejects(
    () => handoffNativeSession(source, "omp", "Source", model),
    /Cannot persist Session handoff recovery state/
  )
  assert.equal(attemptedWithoutRecoveryStorage, false, "resource creation must not start without durable recovery state")

  globalThis.localStorage = storage
  let retryBody
  globalThis.fetch = async (_url, options) => {
    retryBody = JSON.parse(options.body)
    return new Response(JSON.stringify({
      status: "accepted",
      result: {
        target: { machineID: "machine-1", agentID: "omp", sessionID: "target-2", directory: "/repo" }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  await handoffNativeSession(source, "omp", "Source", model)
  assert.notEqual(retryBody.clientRequestId, "definite-rejection", "after a proven rejection a new resource-creation attempt may use a new id")
} finally {
  globalThis.fetch = originalFetch
  if (originalStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = originalStorage
}

// Cross-machine target creation has the same exactly-once resource rule, but its recovery identity
// additionally binds the destination machine + Project + harness. The target path is never supplied
// by the client; the daemon resolves it from projectId.
try {
  const storage = new MemoryStorage()
  globalThis.localStorage = storage
  const crossStorageKey = "harness-remote.cross-machine-target.v1:machine-1:pi:source-1"
  const targetConfig = {
    backend: "codex",
    agentId: "stale-agent-routing-must-not-own-machine-route",
    host: "target.example",
    port: 5099,
    username: "",
    password: ""
  }
  const input = {
    source,
    targetMachineID: "machine-2",
    targetConfig,
    projectId: "machine-2:repo",
    targetAgentID: "codex",
    title: "Source",
    model: { providerID: "openai", modelID: "gpt-5.6", variant: "high" }
  }

  const bodies = []
  const urls = []
  globalThis.fetch = async (url, options) => {
    urls.push(String(url))
    const body = JSON.parse(options.body)
    bodies.push(body)
    return new Response(JSON.stringify({
      status: "accepted",
      clientRequestId: body.clientRequestId,
      result: {
        target: { machineID: "machine-2", agentID: "codex", sessionID: "target-cross-1", directory: "/target/repo" }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }

  const first = await createCrossMachineTargetSession(input)
  assert.equal(first.status, "accepted")
  assert.match(urls[0], /target\.example:5099\/v1\/session-handoff-target$/)
  assert.deepEqual(bodies[0].source, source.ref)
  assert.equal(bodies[0].projectId, "machine-2:repo")
  assert.equal(bodies[0].targetAgentID, "codex")
  assert.deepEqual(bodies[0].model, { providerID: "openai", modelID: "gpt-5.6" })
  assert.equal(bodies[0].variant, "high")
  assert.equal(Object.hasOwn(bodies[0], "directory"), false, "target directory must be resolved only by the target daemon Project catalog")
  const durableRequestId = JSON.parse(storage.getItem(crossStorageKey)).clientRequestId
  assert.equal(first.clientRequestId, durableRequestId)

  await createCrossMachineTargetSession(input)
  assert.equal(bodies[1].clientRequestId, durableRequestId, "accepted creation must still reuse the same id until the caller persists and acknowledges the target")
  await assert.rejects(
    () => createCrossMachineTargetSession({ ...input, targetAgentID: "claude" }),
    /previous cross-machine target creation is unresolved/,
    "one unresolved source creation must not be redirected to another target"
  )
  assert.equal(bodies.length, 2, "conflicting target selection must fail before network I/O")

  acknowledgeCrossMachineTargetSession(source)
  assert.equal(storage.getItem(crossStorageKey), null)

  globalThis.fetch = async () => { throw new Error("lost target response") }
  await assert.rejects(
    () => createCrossMachineTargetSession(input),
    /Target creation status is unknown/,
  )
  const ambiguousId = JSON.parse(storage.getItem(crossStorageKey)).clientRequestId

  let recoveredBody
  globalThis.fetch = async (_url, options) => {
    recoveredBody = JSON.parse(options.body)
    return new Response(JSON.stringify({
      status: "accepted",
      clientRequestId: recoveredBody.clientRequestId,
      result: {
        target: { machineID: "machine-2", agentID: "codex", sessionID: "target-cross-recovered", directory: "/target/repo" }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  const recovered = await createCrossMachineTargetSession(input)
  assert.equal(recovered.clientRequestId, ambiguousId)
  assert.equal(recoveredBody.clientRequestId, ambiguousId, "lost responses must reconcile the original target creation instead of replaying with a new id")

  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Unknown project: machine-2:repo" }), {
    status: 404,
    headers: { "Content-Type": "application/json" }
  })
  await assert.rejects(() => createCrossMachineTargetSession(input), /Unknown project/)
  assert.equal(storage.getItem(crossStorageKey), null, "a definite target-side 4xx may release the creation key")

  let attemptedWithoutRecoveryStorage = false
  globalThis.localStorage = {
    get length() { return 0 },
    key() { return null },
    getItem() { return null },
    setItem() { throw new Error("storage full") },
    removeItem() {},
    clear() {}
  }
  globalThis.fetch = async () => {
    attemptedWithoutRecoveryStorage = true
    throw new Error("network should not be reached")
  }
  await assert.rejects(
    () => createCrossMachineTargetSession(input),
    /Cannot persist cross-machine handoff recovery state/
  )
  assert.equal(attemptedWithoutRecoveryStorage, false, "cross-machine resource creation must not start without durable recovery state")
} finally {
  globalThis.fetch = originalFetch
  if (originalStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = originalStorage
}

console.log("native Session handoff recovery tests passed")