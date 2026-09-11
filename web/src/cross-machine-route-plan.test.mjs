import assert from "node:assert/strict"
import test from "node:test"
import { planCrossMachineContinuation } from "./cross-machine-route-plan.ts"

function source() {
  return {
    key: "machine-a:codex:s1",
    ref: { machineID: "machine-a", agentID: "codex", sessionID: "s1", directory: "/repo" },
    machineID: "machine-a",
    sessionID: "s1",
    directory: "/repo",
    title: "Source",
    agentID: "codex",
    agentLabel: "Codex",
    backend: "codex",
    transport: "acp",
    config: { backend: "codex", host: "source.local", port: 4317, username: "", password: "", agentId: "codex" },
    external: false,
    modelsSupported: true,
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
  capabilities: { sessions: true, prompt: true, models: true }
}

function targetMachine(agent = targetAgent) {
  return {
    machineID: "machine-b",
    label: "Machine B",
    config: { backend: "opencode", host: "target.local", port: 4317, username: "", password: "" },
    agents: [agent]
  }
}

function preflight(decision = "automatic") {
  return {
    sourceMachineID: "machine-a",
    targetMachineID: "machine-b",
    sourceProjectId: "source-project",
    targetProjectId: "target-project",
    sourceIdentityVerified: decision !== "review",
    targetIdentityVerified: decision !== "review",
    decision,
    reason: decision === "automatic" ? "exact_workspace" : decision === "blocked" ? "project_mismatch" : "workspace_diverged",
    assessment: {
      project: decision === "blocked" ? "different" : "match",
      repository: decision === "blocked" ? "different" : "match",
      history: "match",
      branch: decision === "review" ? "different" : "match",
      head: "match",
      sourceDirty: false,
      targetDirty: false,
      exactWorkspace: decision === "automatic"
    }
  }
}

function services(decision = "automatic") {
  const calls = { load: 0, preflight: 0, preflightInput: null }
  return {
    calls,
    value: {
      async loadProjectRoute() {
        calls.load += 1
        return {
          sourceProject: { id: "source-project", machineID: "machine-a", name: "Repo", kind: "git", configured: true },
          targetProjects: [
            { id: "target-project", machineID: "machine-b", name: "Repo clone", kind: "git", configured: true }
          ]
        }
      },
      async preflightProject(input) {
        calls.preflight += 1
        calls.preflightInput = input
        return preflight(decision)
      }
    }
  }
}

test("automatic Project evidence yields a read-only ready plan", async () => {
  const harness = services("automatic")
  const plan = await planCrossMachineContinuation({
    source: source(),
    targetMachine: targetMachine(),
    targetAgent,
    targetProjectId: "target-project",
    services: harness.value
  })
  assert.equal(plan.disposition, "ready")
  assert.equal(plan.sourceProject.id, "source-project")
  assert.equal(plan.targetProject.id, "target-project")
  assert.equal(harness.calls.load, 1)
  assert.equal(harness.calls.preflight, 1)
  assert.equal(harness.calls.preflightInput.sourceProjectId, "source-project")
  assert.equal(harness.calls.preflightInput.targetProjectId, "target-project")
})

test("diverged-but-compatible workspace requires explicit confirmation", async () => {
  const harness = services("review")
  const plan = await planCrossMachineContinuation({
    source: source(),
    targetMachine: targetMachine(),
    targetAgent,
    targetProjectId: "target-project",
    services: harness.value
  })
  assert.equal(plan.disposition, "confirm")
  assert.equal(plan.preflight.decision, "review")
})

test("Project mismatch remains blocked in the read-only plan", async () => {
  const harness = services("blocked")
  const plan = await planCrossMachineContinuation({
    source: source(),
    targetMachine: targetMachine(),
    targetAgent,
    targetProjectId: "target-project",
    services: harness.value
  })
  assert.equal(plan.disposition, "blocked")
  assert.equal(plan.preflight.reason, "project_mismatch")
})

test("unavailable target harness fails before Project reads", async () => {
  const unavailable = { ...targetAgent, state: "unavailable" }
  const harness = services()
  await assert.rejects(
    planCrossMachineContinuation({
      source: source(),
      targetMachine: targetMachine(unavailable),
      targetAgent: unavailable,
      targetProjectId: "target-project",
      services: harness.value
    }),
    /cannot create a writable native Session/
  )
  assert.equal(harness.calls.load, 0)
  assert.equal(harness.calls.preflight, 0)
})

test("stale target Project selection fails closed before Git preflight", async () => {
  const harness = services()
  harness.value.loadProjectRoute = async () => ({
    sourceProject: { id: "source-project", machineID: "machine-a", name: "Repo", kind: "git", configured: true },
    targetProjects: []
  })
  await assert.rejects(
    planCrossMachineContinuation({
      source: source(),
      targetMachine: targetMachine(),
      targetAgent,
      targetProjectId: "target-project",
      services: harness.value
    }),
    /no longer available/
  )
  assert.equal(harness.calls.preflight, 0)
})
