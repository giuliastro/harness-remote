import assert from "node:assert/strict"
import test from "node:test"
import { createCrossMachineTargetRuntime } from "../src/cross-machine-target-runtime.js"

const source = {
  machineID: "machine-a",
  agentID: "codex",
  sessionID: "source-native-1",
  directory: "/source/repo"
}
const project = {
  id: "machine-b:repo",
  machineId: "machine-b",
  name: "repo",
  path: "/target/repo",
  kind: "git"
}

function daemonFor(entry, { resolveModel } = {}) {
  return {
    hostEntry(id) { return id === "pi" ? entry : undefined },
    registry: { host(id) { return id === "pi" ? { capabilities: { sessions: true } } : undefined } },
    async resolveModel(...args) { return resolveModel ? resolveModel(...args) : args[1] }
  }
}

function input(overrides = {}) {
  return {
    source,
    project,
    targetAgentID: "pi",
    model: { providerID: "openai", modelID: "gpt-5.6-codex" },
    variant: "high",
    title: "Continue here",
    ...overrides
  }
}

test("ACP target creation uses only the target Project path and checkpoints before lineage enrichment", async () => {
  const calls = []
  const service = {
    async listSessions(directory) { calls.push(["list", directory]); return [] },
    async createSession(options) { calls.push(["create", options]); return { id: "pi-native-2" } },
    async renameSession(id, title) { calls.push(["rename", id, title]) }
  }
  const links = {
    async addHandoff(link) {
      calls.push(["link", link])
      return { type: "handoff", ...link, createdAt: "2026-09-11T18:00:00.000Z" }
    }
  }
  const checkpoints = []
  const runtime = createCrossMachineTargetRuntime({
    daemon: daemonFor({ kind: "acp", host: { capabilities: { sessions: true } } }, {
      resolveModel: async (agentID, model, options) => {
        calls.push(["model", agentID, model, options])
        return model
      }
    }),
    machineID: "machine-b",
    acpService: () => service,
    sessionLinkStore: links
  })

  const result = await runtime.createTargetSession(input(), {
    async checkpoint(value) { checkpoints.push(structuredClone(value)) }
  })

  assert.deepEqual(calls[0], ["model", "pi", { providerID: "openai", modelID: "gpt-5.6-codex", variant: "high" }, { directory: project.path }])
  assert.deepEqual(calls[1], ["list", project.path])
  assert.deepEqual(calls[2], ["create", { directory: project.path }])
  assert.deepEqual(checkpoints[0], {
    target: { machineID: "machine-b", agentID: "pi", sessionID: "pi-native-2", directory: project.path }
  })
  assert.deepEqual(calls[3], ["rename", "pi-native-2", "Continue here"])
  assert.equal(calls[4][0], "link")
  assert.deepEqual(calls[4][1].source, source)
  assert.deepEqual(calls[4][1].target, result.target)
  assert.equal(result.link.type, "handoff")
  assert.deepEqual(checkpoints[1], result)
  assert.equal(calls.some((call) => call[0] === "prompt"), false)
})

test("HTTP target creation lists before creating and uses the catalog path rather than the source path", async () => {
  const requests = []
  const host = {
    readinessHost: "127.0.0.1",
    port: 5555,
    username: "daemon",
    password: "secret",
    capabilities: { sessions: true },
    async start() {}
  }
  const fetchImpl = async (url, options) => {
    requests.push([url, options])
    if (options.method === "GET") {
      return { ok: true, status: 200, async json() { return [] } }
    }
    return { ok: true, status: 200, async json() { return { id: "http-target-1" } } }
  }
  const links = { async addHandoff(link) { return { type: "handoff", ...link, createdAt: "now" } } }
  const runtime = createCrossMachineTargetRuntime({
    daemon: daemonFor({ kind: "http", host }),
    machineID: "machine-b",
    acpService: () => undefined,
    sessionLinkStore: links,
    fetchImpl
  })
  const result = await runtime.createTargetSession(input({ model: null, variant: undefined, title: undefined }))
  assert.equal(requests.length, 2)
  assert.equal(requests[0][0], `http://127.0.0.1:5555/session?directory=${encodeURIComponent(project.path)}`)
  assert.equal(requests[0][1].method, "GET")
  assert.equal(requests[1][0], `http://127.0.0.1:5555/session?directory=${encodeURIComponent(project.path)}`)
  assert.equal(requests[1][1].method, "POST")
  assert.match(requests[1][1].headers.Authorization, /^Basic /)
  assert.equal(requests.some(([url]) => url.includes(encodeURIComponent(source.directory))), false)
  assert.equal(result.target.directory, project.path)
})

test("runtime rejects a local source and a target Project owned by another machine before session/new", async () => {
  let creates = 0
  const service = {
    async listSessions() { return [] },
    async createSession() { creates += 1; return { id: "should-not-exist" } }
  }
  const runtime = createCrossMachineTargetRuntime({
    daemon: daemonFor({ kind: "acp", host: { capabilities: { sessions: true } } }),
    machineID: "machine-b",
    acpService: () => service,
    sessionLinkStore: { async addHandoff() {} }
  })
  await assert.rejects(
    () => runtime.createTargetSession(input({ source: { ...source, machineID: "machine-b" } })),
    /source Session on another machine/
  )
  await assert.rejects(
    () => runtime.createTargetSession(input({ project: { ...project, machineId: "machine-c" } })),
    /Target Project must belong to this machine/
  )
  assert.equal(creates, 0)
})

test("ambiguous ACP create carries a before-list recovery snapshot and unique reconciliation returns one target", async () => {
  let sessions = [{ id: "old", directory: project.path }]
  const service = {
    async listSessions() { return sessions },
    async createSession() {
      sessions = [...sessions, { id: "new-target", directory: project.path }]
      throw new Error("response lost")
    }
  }
  const links = { async addHandoff(link) { return { type: "handoff", ...link, createdAt: "now" } } }
  const runtime = createCrossMachineTargetRuntime({
    daemon: daemonFor({ kind: "acp", host: { capabilities: { sessions: true } } }),
    machineID: "machine-b",
    acpService: () => service,
    sessionLinkStore: links
  })
  let recovery
  try {
    await runtime.createTargetSession(input({ model: null }))
    assert.fail("expected ambiguous creation")
  } catch (error) {
    assert.equal(error.ambiguous, true)
    recovery = error.recovery
  }
  assert.deepEqual(recovery, {
    kind: "cross-machine-target-create-v1",
    targetAgentID: "pi",
    projectId: project.id,
    directory: project.path,
    beforeSessionIDs: ["old"]
  })
  const result = await runtime.reconcileTargetSession(input({ model: null }), recovery)
  assert.equal(result.target.sessionID, "new-target")
  assert.deepEqual(result.link.source, source)
})

test("reconciliation refuses zero or multiple new candidates", async () => {
  let sessions = [{ id: "old", directory: project.path }]
  const service = { async listSessions() { return sessions } }
  const runtime = createCrossMachineTargetRuntime({
    daemon: daemonFor({ kind: "acp", host: { capabilities: { sessions: true } } }),
    machineID: "machine-b",
    acpService: () => service,
    sessionLinkStore: { async addHandoff(link) { return { type: "handoff", ...link } } }
  })
  const recovery = {
    kind: "cross-machine-target-create-v1",
    targetAgentID: "pi",
    projectId: project.id,
    directory: project.path,
    beforeSessionIDs: ["old"]
  }
  assert.equal(await runtime.reconcileTargetSession(input({ model: null }), recovery), undefined)
  sessions = [
    { id: "old", directory: project.path },
    { id: "new-1", directory: project.path },
    { id: "new-2", directory: project.path }
  ]
  assert.equal(await runtime.reconcileTargetSession(input({ model: null }), recovery), undefined)
})
