import assert from "node:assert/strict"
import test from "node:test"
import { continueNativeSessionAcrossMachine } from "./cross-machine-continuation.ts"
import { sendCrossMachineFirstPrompt } from "./cross-machine-first-prompt.ts"

class MemoryStorage {
  #values = new Map()
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null }
  setItem(key, value) { this.#values.set(key, String(value)) }
  removeItem(key) { this.#values.delete(key) }
  clear() { this.#values.clear() }
}

globalThis.localStorage = new MemoryStorage()

function sourceTarget() {
  return {
    key: "machine-a:codex:s1",
    ref: { machineID: "machine-a", agentID: "codex", sessionID: "s1", directory: "/repo" },
    machineID: "machine-a",
    sessionID: "s1",
    directory: "/repo",
    title: "Source session",
    agentID: "codex",
    agentLabel: "Codex",
    backend: "codex",
    transport: "acp",
    config: { backend: "codex", host: "source.local", port: 4317, username: "", password: "", agentId: "codex" },
    external: false,
    modelsSupported: true,
    commandsSupported: true,
    renameSupported: false,
    deleteSupported: false,
    model: null,
    requiresExplicitClaim: false,
    canStop: false
  }
}

const targetAgent = {
  id: "claude",
  label: "Claude",
  backend: "claude",
  transport: "acp",
  state: "available",
  capabilities: { sessions: true, prompt: true, models: true, commands: true }
}

function targetMachine() {
  return {
    machineID: "machine-b",
    label: "Machine B",
    config: { backend: "opencode", host: "target.local", port: 4317, username: "", password: "" },
    agents: [targetAgent]
  }
}

function exactPreflight() {
  return {
    sourceMachineID: "machine-a",
    targetMachineID: "machine-b",
    sourceProjectId: "source-project",
    targetProjectId: "target-project",
    sourceIdentityVerified: true,
    targetIdentityVerified: true,
    decision: "automatic",
    reason: "exact_workspace",
    assessment: {
      project: "match",
      repository: "match",
      history: "match",
      branch: "match",
      head: "match",
      sourceDirty: false,
      targetDirty: false,
      exactWorkspace: true
    }
  }
}

function messages() {
  return [
    { info: { role: "user" }, parts: [{ type: "text", text: "Inspect the failing build" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "The bridge test is the remaining failure." }] }
  ]
}

function serviceHarness({ firstPrompt, preflight = exactPreflight() } = {}) {
  const calls = {
    create: 0,
    acknowledge: 0,
    links: [],
    promptIds: [],
    promptInputs: [],
    marked: 0,
    preflight: 0
  }
  const services = {
    async preflightProject() {
      calls.preflight += 1
      return preflight
    },
    requireProjectApproval(result, { confirmed = false } = {}) {
      if (result.decision === "blocked") throw new Error("blocked project")
      if (result.decision === "review" && !confirmed) throw new Error("needs confirmation")
    },
    async createTargetSession() {
      calls.create += 1
      return {
        status: "accepted",
        clientRequestId: "create-1",
        result: {
          target: { machineID: "machine-b", agentID: "claude", sessionID: "target-1", directory: "/repo-copy" }
        }
      }
    },
    acknowledgeTargetSession() { calls.acknowledge += 1 },
    async loadSourceMessages() { return messages() },
    async registerSessionLink(config, link) { calls.links.push({ host: config.host, link }) },
    async sendFirstPrompt(input) {
      calls.promptIds.push(input.clientRequestId)
      calls.promptInputs.push(input)
      if (firstPrompt) return firstPrompt(input, calls)
      return { status: "accepted", clientRequestId: input.clientRequestId }
    },
    markHandoffContextSent() { calls.marked += 1 }
  }
  return { services, calls }
}

function continuationInput(services, overrides = {}) {
  return {
    source: {
      ...sourceTarget(),
      // Representative source-side authorization from #371's boundary acceptance scenario. It is
      // deliberately present on the source so the test can prove that continuity does not imply
      // permission inheritance on another machine/runtime.
      permission: [{ permission: "bash", pattern: "deploy production", action: "allow" }]
    },
    sourceProjectId: "source-project",
    targetMachine: targetMachine(),
    targetProjectId: "target-project",
    targetAgent,
    prompt: "Continue with the bridge fix",
    attachments: [],
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high" },
    services,
    ...overrides
  }
}

test("lost first-prompt response retries the same target and prompt request id", async () => {
  localStorage.clear()
  let first = true
  const { services, calls } = serviceHarness({
    firstPrompt: async (input) => {
      if (first) {
        first = false
        throw new Error("lost response after dispatch")
      }
      return { status: "accepted", clientRequestId: input.clientRequestId }
    }
  })

  await assert.rejects(
    continueNativeSessionAcrossMachine(continuationInput(services)),
    /lost response after dispatch/
  )
  const result = await continueNativeSessionAcrossMachine(continuationInput(services))

  assert.equal(calls.create, 1, "retry must reuse the already-created native target")
  assert.equal(calls.promptIds.length, 2)
  assert.equal(calls.promptIds[0], calls.promptIds[1], "ambiguous first-prompt retry must reuse the exact request id")
  assert.equal(calls.preflight, 2, "Project continuity is rechecked before recovery mutations")
  assert.equal(calls.links.length, 4, "the same lineage edge is retried on both machine-local stores")
  assert.deepEqual(calls.links.map((entry) => entry.host), ["source.local", "target.local", "source.local", "target.local"])
  assert.match(calls.links[0].link.transferredContext, /remaining failure/)
  assert.doesNotMatch(calls.links[0].link.transferredContext, /deploy production/, "source authorization must not leak into portable context")
  assert.equal(calls.promptInputs[0].target.permission, undefined, "first-prompt target must not inherit source authority")
  assert.equal(calls.marked, 1)
  assert.equal(result.target.machineID, "machine-b")
  assert.equal(result.target.sessionID, "target-1")
  assert.equal(result.target.requiresExplicitClaim, false, "fresh target writer ownership must not require a synthetic source claim")
  assert.equal(result.target.permission, undefined, "source authority metadata must not be copied")
})

test("review Project evidence blocks mutation until explicitly confirmed", async () => {
  localStorage.clear()
  const review = {
    ...exactPreflight(),
    decision: "review",
    reason: "workspace_diverged",
    assessment: { ...exactPreflight().assessment, head: "different", exactWorkspace: false }
  }
  const { services, calls } = serviceHarness({ preflight: review })

  await assert.rejects(
    continueNativeSessionAcrossMachine(continuationInput(services)),
    /needs confirmation/
  )
  assert.equal(calls.create, 0)

  const result = await continueNativeSessionAcrossMachine(continuationInput(services, { confirmedProjectContinuity: true }))
  assert.equal(calls.create, 1)
  assert.equal(result.preflight.decision, "review")
})

test("a conflicting retry cannot redirect an unresolved continuation", async () => {
  localStorage.clear()
  const { services, calls } = serviceHarness({
    firstPrompt: async () => { throw new Error("network lost") }
  })
  await assert.rejects(continueNativeSessionAcrossMachine(continuationInput(services)), /network lost/)

  await assert.rejects(
    continueNativeSessionAcrossMachine(continuationInput(services, { prompt: "Do something else" })),
    /already in progress/
  )
  assert.equal(calls.create, 1)
  assert.equal(calls.promptIds.length, 1)
})

test("attachments are rejected before any cross-machine mutation", async () => {
  localStorage.clear()
  const { services, calls } = serviceHarness()
  await assert.rejects(
    continueNativeSessionAcrossMachine(continuationInput(services, {
      attachments: [{ mime: "image/png", filename: "x.png", url: "data:image/png;base64,x" }]
    })),
    /does not transfer images yet/
  )
  assert.equal(calls.preflight, 0)
  assert.equal(calls.create, 0)
})

test("first-prompt transport preserves the caller-owned id and bounded context packet", async () => {
  const previousFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ status: "accepted" }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    const target = {
      ...sourceTarget(),
      key: "machine-b:claude:target-1",
      ref: { machineID: "machine-b", agentID: "claude", sessionID: "target-1", directory: "/repo-copy" },
      machineID: "machine-b",
      sessionID: "target-1",
      directory: "/repo-copy",
      agentID: "claude",
      agentLabel: "Claude",
      backend: "claude",
      config: { backend: "claude", host: "target.local", port: 4317, username: "", password: "", agentId: "claude" }
    }
    const result = await sendCrossMachineFirstPrompt({
      target,
      clientRequestId: "prompt-fixed-id",
      text: "Proceed",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      transferredContext: "Source evidence"
    })

    assert.equal(result.clientRequestId, "prompt-fixed-id")
    assert.equal(captured.body.clientRequestId, "prompt-fixed-id")
    assert.equal(captured.body.attachments.length, 0)
    assert.match(captured.body.text, /TRANSFERRED TASK CONTEXT\nSource evidence/)
    assert.match(captured.body.text, /USER INSTRUCTION\nProceed/)
  } finally {
    globalThis.fetch = previousFetch
  }
})
