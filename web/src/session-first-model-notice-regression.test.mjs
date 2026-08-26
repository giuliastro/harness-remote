import assert from "node:assert/strict"
import test from "node:test"
import { buildWorkThreadTimeline, CONVERSATION_EVENT_ROLE } from "./work-thread-timeline.ts"

const agents = {
  codex: { label: "Codex", backend: "codex" }
}

function message(sessionID, id, role, created, text) {
  return {
    info: { id, sessionID, role, time: { created } },
    parts: [{ id: `${id}:text`, messageID: id, type: "text", text }]
  }
}

function projectionRun({ id, sequence, prompt, model, startedAt }) {
  return {
    id,
    sequence,
    agentId: "codex",
    model,
    role: sequence === 1 ? "implement" : "continue",
    sessionId: "native-session",
    status: "completed",
    transport: "acp",
    directory: "/tmp/project",
    prompt,
    startedAt,
    finishedAt: startedAt
  }
}

test("native Session model enrichment cannot fabricate a model-changed lifecycle line", () => {
  const first = projectionRun({
    id: "native-session-v3:machine:codex:native-session:native-user:u1",
    sequence: 1,
    prompt: "Initial request",
    model: { providerID: "codex", modelID: "gpt-old" },
    startedAt: "2026-08-26T08:00:00.000Z"
  })
  const second = projectionRun({
    id: "native-session-v3:machine:codex:native-session:request:req-1",
    sequence: 2,
    prompt: "Continue with the model this Session proposed",
    model: { providerID: "codex", modelID: "gpt-current" },
    startedAt: "2026-08-26T08:01:00.000Z"
  })
  const task = {
    id: "native-session-v3:machine:codex:native-session",
    agentId: "codex",
    prompt: first.prompt,
    status: "completed",
    workspace: { mode: "project", path: "/tmp/project" },
    run: second,
    runs: [first, second],
    createdAt: first.startedAt,
    updatedAt: second.startedAt,
    error: null
  }

  const timeline = buildWorkThreadTimeline(task, {
    "native-session": [
      message("native-session", "u1", "user", 1, first.prompt),
      message("native-session", "a1", "assistant", 2, "First answer"),
      message("native-session", "u2", "user", 3, second.prompt),
      message("native-session", "a2", "assistant", 4, "Second answer")
    ]
  }, agents)

  assert.equal(timeline.some((entry) => entry.info.role === CONVERSATION_EVENT_ROLE), false)
  assert.deepEqual(timeline
    .filter((entry) => entry.info.role === "user")
    .map((entry) => entry.parts.map((part) => part.text || "").join("")), [first.prompt, second.prompt])
})
