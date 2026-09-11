import assert from "node:assert/strict"
import test from "node:test"
import {
  federatedModelIdentity,
  federatedProjectIdentity,
  federatedSessionBucket,
  matchesFederatedSessionQuery,
  projectFederatedSession
} from "./native-session-federation.ts"

function session(overrides = {}) {
  return {
    id: "session-1",
    title: "Fix reconnect handling",
    directory: "/workspace/harness-remote",
    time: { created: 1, updated: 2 },
    project: { id: "project-1", name: "Harness Remote", worktree: "/workspace/harness-remote" },
    model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
    ...overrides
  }
}

test("operational buckets distinguish active, attention, failure, completion and unknown recent states", () => {
  for (const type of ["working", "busy", "running", "in_progress", "retrying", "waiting"]) {
    assert.equal(federatedSessionBucket({ type }), "active", type)
  }
  for (const type of ["attention", "needs-attention", "blocked", "input-required"]) {
    assert.equal(federatedSessionBucket({ type }), "attention", type)
  }
  for (const type of ["error", "failed", "rejected", "interrupted", "aborted", "cancelled", "offline", "stopped"]) {
    assert.equal(federatedSessionBucket({ type }), "failed", type)
  }
  for (const type of ["completed", "done", "finished", "succeeded", "success"]) {
    assert.equal(federatedSessionBucket({ type }), "completed", type)
  }
  assert.equal(federatedSessionBucket({ type: "something-new" }), "recent")
  assert.equal(federatedSessionBucket(undefined), "recent")
})

test("live presentation wins over stale discovery state without inventing stronger semantics", () => {
  assert.equal(federatedSessionBucket({ type: "working" }, "ready"), "active", "ready alone must not erase a still-active native status")
  assert.equal(federatedSessionBucket({ type: "completed" }, "working"), "active")
  assert.equal(federatedSessionBucket({ type: "working" }, "attention"), "attention")
  assert.equal(federatedSessionBucket({ type: "working" }, "stopped"), "failed")
})

test("project identity remains machine-scoped and uses already-known project metadata", () => {
  assert.deepEqual(federatedProjectIdentity({
    machineID: "machine-a",
    session: session(),
    projectName: "HR",
    projectPath: "/workspace/harness-remote"
  }), {
    key: "machine-a:/workspace/harness-remote",
    label: "HR"
  })
  assert.equal(federatedProjectIdentity({ machineID: "machine-b", session: session() }).key, "machine-b:/workspace/harness-remote")
})

test("model identity keeps provider, native model id and variant without catalog lookups", () => {
  assert.deepEqual(federatedModelIdentity(session().model), {
    key: "openai:gpt-5.6:high",
    label: "openai · gpt-5.6 · high"
  })
  assert.deepEqual(federatedModelIdentity(null), { key: "", label: "Unknown model" })
})

test("federated projection extends search to machine, Project, harness and model without transcript reads", () => {
  const projection = projectFederatedSession({
    machineID: "machine-a",
    machineName: "Studio PC",
    agentID: "codex",
    agentLabel: "Codex",
    session: session({ status: { type: "completed" } }),
    projectName: "Harness Remote",
    projectPath: "/workspace/harness-remote"
  })

  assert.equal(projection.bucket, "completed")
  assert.equal(projection.projectKey, "machine-a:/workspace/harness-remote")
  assert.equal(projection.modelKey, "openai:gpt-5.6:high")
  for (const query of ["reconnect", "studio pc", "harness remote", "codex", "openai", "gpt-5.6", "high"]) {
    assert.equal(matchesFederatedSessionQuery(projection, query), true, query)
  }
  assert.equal(matchesFederatedSessionQuery(projection, "claude"), false)
})
