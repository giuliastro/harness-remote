import assert from "node:assert/strict"
import test from "node:test"
import { buildWorkThreadTimeline } from "./work-thread-timeline.ts"

function message(sessionID, id, role, created, text) {
  return {
    info: { id, sessionID, role, time: { created } },
    parts: [{ id: `${id}:text`, messageID: id, type: "text", text }]
  }
}

function baseTask(run) {
  return {
    id: "task-1",
    machineId: "machine-1",
    projectId: "project-1",
    project: { name: "Harness Remote", path: "/repo", kind: "git" },
    agentId: run.agentId,
    prompt: run.prompt,
    model: run.model,
    status: "completed",
    workspace: { mode: "worktree", path: "/repo-task" },
    run,
    runs: [run],
    createdAt: run.startedAt,
    updatedAt: run.finishedAt
  }
}

function texts(entry) {
  return entry.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
}

test("a delayed assistant fragment remains inside the single logical assistant turn", () => {
  const run = {
    id: "run-1",
    sequence: 1,
    agentId: "omp",
    model: { providerID: "openai", modelID: "slow-model" },
    sessionId: "session-omp",
    status: "completed",
    transport: "acp",
    directory: "/repo-task",
    prompt: "Do a long audit",
    startedAt: "2026-08-21T10:00:00.000Z",
    finishedAt: "2026-08-21T10:01:00.000Z"
  }
  const start = Date.parse(run.startedAt)
  const late = Date.parse(run.finishedAt) + 45_000
  const timeline = buildWorkThreadTimeline(baseTask(run), {
    "session-omp": [
      message("session-omp", "user-1", "user", start + 1, run.prompt),
      message("session-omp", "assistant-1", "assistant", start + 20_000, "First part"),
      message("session-omp", "assistant-2", "assistant", late, "Delayed final part")
    ]
  }, { omp: { label: "Oh My Pi", backend: "omp" } })

  assert.deepEqual(timeline.map((entry) => [entry.info.role, texts(entry)]), [
    ["user", "Do a long audit"],
    ["assistant", "First part\nDelayed final part"]
  ])
  assert.equal(timeline.filter((entry) => entry.info.role === "assistant").length, 1)
})

test("an unrelated native-session turn is not silently absorbed into the Task", () => {
  const run = {
    id: "run-1",
    sequence: 1,
    agentId: "omp",
    sessionId: "session-omp",
    status: "completed",
    transport: "acp",
    directory: "/repo-task",
    prompt: "TaskDesk request",
    startedAt: "2026-08-21T10:00:00.000Z",
    finishedAt: "2026-08-21T10:01:00.000Z"
  }
  const timeline = buildWorkThreadTimeline(baseTask(run), {
    "session-omp": [
      message("session-omp", "user-task", "user", 1, run.prompt),
      message("session-omp", "assistant-task", "assistant", 2, "Task answer"),
      message("session-omp", "user-manual", "user", 3, "Manual native-session question"),
      message("session-omp", "assistant-manual", "assistant", 4, "Manual native answer")
    ]
  }, { omp: { label: "Oh My Pi", backend: "omp" } })

  assert.deepEqual(timeline.map(texts), ["TaskDesk request", "Task answer"])
})
