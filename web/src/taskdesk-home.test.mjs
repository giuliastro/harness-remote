import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  agentLabel,
  modelLabel,
  normalizeTaskStatus,
  sortTasksByActivity,
  taskStatusLabel,
  taskTitle
} from "./taskdeskHomeModel.ts"

function task(overrides = {}) {
  return {
    id: "task-1",
    machineId: "machine-1",
    projectId: "project-1",
    project: { name: "Harness Remote", path: "/repo", kind: "git" },
    agentId: "codex",
    prompt: "Fix the authentication regression\nMore context",
    model: { providerID: "openai", modelID: "gpt-test", variant: "high" },
    status: "running",
    workspace: { mode: "worktree", path: "/repo-task" },
    run: null,
    createdAt: "2026-08-18T10:00:00.000Z",
    updatedAt: "2026-08-18T11:00:00.000Z",
    ...overrides
  }
}

test("TaskDesk normalizes backend lifecycle states for the Tasks view", () => {
  assert.equal(normalizeTaskStatus("created"), "preparing")
  assert.equal(normalizeTaskStatus("pending"), "queued")
  assert.equal(normalizeTaskStatus("busy"), "running")
  assert.equal(normalizeTaskStatus("needs_attention"), "waiting")
  assert.equal(normalizeTaskStatus("succeeded"), "completed")
  assert.equal(normalizeTaskStatus("error"), "failed")
  assert.equal(normalizeTaskStatus("aborted"), "cancelled")
  assert.equal(normalizeTaskStatus("custom-state"), "unknown")
  assert.equal(taskStatusLabel("custom-state"), "custom-state")
})

test("TaskDesk derives stable task row labels without flattening Tasks into Sessions", () => {
  const value = task()
  assert.equal(taskTitle(value), "Fix the authentication regression")
  assert.equal(modelLabel(value), "gpt-test · high")
  assert.equal(agentLabel([
    { id: "codex", label: "Codex CLI", backend: "codex", transport: "acp", managed: false, state: "available", capabilities: {} }
  ], value.agentId), "Codex CLI")
  assert.equal(agentLabel([], "pi"), "pi")
})

test("TaskDesk sorts Tasks by durable task activity rather than session order", () => {
  const older = task({ id: "older", updatedAt: "2026-08-18T09:00:00.000Z" })
  const newer = task({ id: "newer", updatedAt: "2026-08-18T12:00:00.000Z" })
  assert.deepEqual(sortTasksByActivity([older, newer]).map((item) => item.id), ["newer", "older"])
})

test("Universal workspace cannot starve initial loading with overlapping polls", () => {
  const source = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  assert.match(source, /const AGENT_SESSION_LOAD_TIMEOUT_MS = 12_000/)
  assert.match(source, /const refreshInFlight = useRef\(false\)/)
  assert.match(source, /if \(refreshInFlight\.current\) return/)
  assert.match(source, /await withTimeout\(Promise\.all\(\[/)
  assert.match(source, /refreshInFlight\.current = false/)
})
