import assert from "node:assert/strict"
import test from "node:test"
import { buildWorkThreadTimeline, CONVERSATION_EVENT_ROLE } from "./work-thread-timeline.ts"

function message(sessionID, id, role, created, text) {
  return {
    info: { id, sessionID, role, time: { created } },
    parts: text === undefined ? [] : [{ id: `${id}:text`, messageID: id, type: "text", text }]
  }
}

function run(overrides = {}) {
  return {
    id: "run-1",
    sequence: 1,
    agentId: "codex",
    model: { providerID: "openai", modelID: "gpt-test" },
    sessionId: "session-codex",
    status: "completed",
    transport: "acp",
    directory: "/repo-task",
    prompt: "Initial request",
    startedAt: "2026-08-21T10:00:00.000Z",
    finishedAt: "2026-08-21T10:01:00.000Z",
    ...overrides
  }
}

function task(overrides = {}) {
  const firstRun = run()
  return {
    id: "task-1",
    machineId: "machine-1",
    projectId: "project-1",
    project: { name: "Harness Remote", path: "/repo", kind: "git" },
    agentId: "codex",
    prompt: "Initial request",
    model: { providerID: "openai", modelID: "gpt-test" },
    status: "completed",
    workspace: { mode: "worktree", path: "/repo-task" },
    run: firstRun,
    runs: [firstRun],
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:01:00.000Z",
    ...overrides
  }
}

const agents = {
  codex: { label: "Codex", backend: "codex" },
  claude: { label: "Claude", backend: "claude" },
  pi: { label: "PI", backend: "pi" }
}

function textOf(entry) {
  return entry.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
}

test("one persisted Run renders one user instruction and one logical assistant turn", () => {
  const first = run()
  const started = Date.parse(first.startedAt)
  const value = task({ run: first, runs: [first] })
  const timeline = buildWorkThreadTimeline(value, {
    "session-codex": [
      message("session-codex", "u1", "user", started + 1, first.prompt),
      message("session-codex", "a-note", "assistant", started + 5_000, "Checking the implementation."),
      {
        info: { id: "a-tool", sessionID: "session-codex", role: "assistant", time: { created: started + 10_000 } },
        parts: [{ id: "tool", messageID: "a-tool", type: "tool", tool: "Read", callID: "read-1", state: { status: "completed" } }]
      },
      message("session-codex", "a-final", "assistant", started + 15_000, "The implementation is now correct.")
    ]
  }, agents)

  assert.equal(timeline.filter((entry) => entry.info.role === "user").length, 1)
  assert.equal(timeline.filter((entry) => entry.info.role === "assistant").length, 1)
  assert.deepEqual(timeline.find((entry) => entry.info.role === "assistant").parts.map((part) => part.type), ["text", "tool", "text"])
})

test("same native Session reused for many Runs follows native user-turn boundaries", () => {
  const first = run({ sessionId: "same-session" })
  const second = run({
    id: "run-2",
    sequence: 2,
    prompt: "Please refine that",
    sessionId: "same-session",
    startedAt: "2026-08-21T10:02:00.000Z",
    finishedAt: "2026-08-21T10:03:00.000Z"
  })
  const value = task({ run: second, runs: [first, second] })
  const native = [
    message("same-session", "u1", "user", 1, first.prompt),
    message("same-session", "a1", "assistant", 2, "First answer"),
    message("same-session", "u2", "user", 3, second.prompt),
    message("same-session", "a2", "assistant", 4, "Second answer")
  ]
  const timeline = buildWorkThreadTimeline(value, { "same-session": native }, agents)
  assert.deepEqual(timeline.map(textOf), ["Initial request", "First answer", "Please refine that", "Second answer"])
})

test("replayed timestamps do not affect Run ownership", () => {
  const first = run({ sessionId: "replayed-session" })
  const second = run({
    id: "run-2",
    sequence: 2,
    prompt: "Please refine that",
    sessionId: "replayed-session",
    startedAt: "2026-08-21T10:02:00.000Z",
    finishedAt: "2026-08-21T10:03:00.000Z"
  })
  const value = task({ run: second, runs: [first, second] })
  const replayedAt = Date.parse("2026-08-21T12:00:00.000Z")
  const timeline = buildWorkThreadTimeline(value, {
    "replayed-session": [
      message("replayed-session", "u1", "user", replayedAt, first.prompt),
      message("replayed-session", "a1", "assistant", replayedAt + 1, "First answer"),
      message("replayed-session", "u2", "user", replayedAt + 2, second.prompt),
      message("replayed-session", "a2", "assistant", replayedAt + 3, "Second answer")
    ]
  }, agents)
  assert.deepEqual(timeline.map(textOf), ["Initial request", "First answer", "Please refine that", "Second answer"])
})

test("TaskDesk handoff packet never becomes a You message", () => {
  const first = run()
  const second = run({
    id: "run-2",
    sequence: 2,
    agentId: "claude",
    model: { providerID: "anthropic", modelID: "claude-sonnet", variant: "high" },
    prompt: "Check the architecture too",
    sessionId: "session-claude",
    startedAt: "2026-08-21T10:02:00.000Z",
    finishedAt: "2026-08-21T10:03:00.000Z"
  })
  const value = task({ run: second, runs: [first, second] })
  const handoff = [
    "You are taking over an existing TaskDesk task.",
    "The context below was transferred by TaskDesk. It is not native conversational memory from another harness.",
    "",
    "TASK OBJECTIVE",
    "Initial request",
    "",
    "USER INSTRUCTION",
    second.prompt,
    "",
    "Continue from the shared workspace and the transferred Task Context. Inspect the current files before assuming previous work is correct."
  ].join("\n")
  const timeline = buildWorkThreadTimeline(value, {
    "session-codex": [
      message("session-codex", "u1", "user", 1, first.prompt),
      message("session-codex", "a1", "assistant", 2, "Codex result")
    ],
    "session-claude": [
      message("session-claude", "u2", "user", 3, handoff),
      message("session-claude", "a2", "assistant", 4, "Claude result")
    ]
  }, agents)

  assert.equal(timeline.some((entry) => textOf(entry).includes("You are taking over an existing TaskDesk task")), false)
  assert.deepEqual(timeline.map(textOf), [
    "Initial request",
    "Codex result",
    "Continued with Claude · claude-sonnet · high · context transferred",
    second.prompt,
    "Claude result"
  ])
})

test("changing only the model is visible in the conversation timeline", () => {
  const first = run({ sessionId: "same-session" })
  const second = run({
    id: "run-2",
    sequence: 2,
    model: { providerID: "openai", modelID: "gpt-next", variant: "high" },
    prompt: "Continue with the stronger model",
    sessionId: "same-session",
    startedAt: "2026-08-21T10:02:00.000Z",
    finishedAt: "2026-08-21T10:03:00.000Z"
  })
  const value = task({ run: second, runs: [first, second] })
  const timeline = buildWorkThreadTimeline(value, {
    "same-session": [
      message("same-session", "u1", "user", 1, first.prompt),
      message("same-session", "a1", "assistant", 2, "First answer"),
      message("same-session", "u2", "user", 3, second.prompt),
      message("same-session", "a2", "assistant", 4, "Second answer")
    ]
  }, agents)

  assert.deepEqual(timeline.map(textOf), [
    "Initial request",
    "First answer",
    "Model changed to gpt-next · high · continuing with Codex",
    second.prompt,
    "Second answer"
  ])
})

test("unrelated native-session turns are not absorbed into the Task", () => {
  const first = run()
  const value = task({ run: first, runs: [first] })
  const timeline = buildWorkThreadTimeline(value, {
    "session-codex": [
      message("session-codex", "task-user", "user", 1, first.prompt),
      message("session-codex", "task-assistant", "assistant", 2, "Task answer"),
      message("session-codex", "manual-user", "user", 3, "Manual native-session question"),
      message("session-codex", "manual-assistant", "assistant", 4, "Manual native answer")
    ]
  }, agents)
  assert.deepEqual(timeline.map(textOf), ["Initial request", "Task answer"])
})

test("persisted outcome fills history when the native Session cannot be read", () => {
  const first = run({ outcome: "Persisted result from the old backend" })
  const timeline = buildWorkThreadTimeline(task({ run: first, runs: [first] }), {}, agents)
  assert.deepEqual(timeline.map((entry) => [entry.info.role, textOf(entry)]), [
    ["user", "Initial request"],
    ["assistant", "Persisted result from the old backend"]
  ])
  assert.equal(timeline[1].taskdesk.kind, "fallback-result")
})

test("a failed Run keeps its error on its logical assistant turn after a later success", () => {
  const first = run({ status: "failed", error: { message: "Session native-1 not found" } })
  const second = run({
    id: "run-2",
    sequence: 2,
    prompt: "Continue safely",
    sessionId: "session-codex-2",
    startedAt: "2026-08-21T10:02:00.000Z",
    finishedAt: "2026-08-21T10:03:00.000Z"
  })
  const value = task({ status: "completed", error: null, run: second, runs: [first, second] })
  const timeline = buildWorkThreadTimeline(value, {
    "session-codex": [
      message("session-codex", "u1", "user", 1, first.prompt),
      message("session-codex", "a1", "assistant", 2, "Partial answer")
    ],
    "session-codex-2": [
      message("session-codex-2", "u2", "user", 3, second.prompt),
      message("session-codex-2", "a2", "assistant", 4, "Recovered answer")
    ]
  }, agents)

  const assistants = timeline.filter((entry) => entry.info.role === "assistant")
  assert.equal(assistants.length, 2)
  assert.equal(assistants[0].info.error?.message, "Session native-1 not found")
  assert.equal(assistants[1].info.error, undefined)
})

test("PI working text stays ordered with reasoning and one terminal response", () => {
  const first = run({ agentId: "pi", sessionId: "session-pi" })
  const value = task({ agentId: "pi", run: first, runs: [first] })
  const native = {
    info: { id: "pi-a1", sessionID: "session-pi", role: "assistant", time: { created: 2 } },
    parts: [
      { id: "partial", messageID: "pi-a1", type: "text", text: "Checking the stale session" },
      { id: "think", messageID: "pi-a1", type: "reasoning", text: "Inspect session ownership." },
      { id: "final", messageID: "pi-a1", type: "text", text: "The stale session fallback is fixed." }
    ]
  }
  const timeline = buildWorkThreadTimeline(value, {
    "session-pi": [message("session-pi", "u1", "user", 1, first.prompt), native]
  }, agents)
  const assistant = timeline.find((entry) => entry.info.role === "assistant")
  assert.deepEqual(assistant.parts.map((part) => part.type), ["text", "reasoning", "text"])
  assert.equal(textOf(assistant), "Checking the stale session\nThe stale session fallback is fixed.")
})

// Session-first mode: the native Session is the whole thread, so a turn no Run prompt claims is
// still native truth and has to be rendered. Without this the anchor Run of a projected native
// Session (prompt "") matched nothing and the whole transcript disappeared, which is how a Claude
// Session that the harness itself showed in full arrived here as "Start the conversation".
const nativeOptions = { includeUnmatchedNativeTurns: true }

function anchorTask(overrides = {}) {
  const anchor = run({ id: "anchor", prompt: "", sessionId: "session-claude", agentId: "claude" })
  return task({
    id: "native-session-v3:machine:claude:session-claude",
    agentId: "claude",
    prompt: "",
    run: anchor,
    runs: [anchor],
    ...overrides
  })
}

test("a native Session with no matching Run still renders its transcript", () => {
  const timeline = buildWorkThreadTimeline(anchorTask(), {
    "session-claude": [
      message("session-claude", "u1", "user", 1_000, "Correggere glitch dell'interfaccia mobile"),
      message("session-claude", "a1", "assistant", 2_000, "Ho corretto il glitch.")
    ]
  }, agents, nativeOptions)

  assert.deepEqual(timeline.map((entry) => [entry.info.role, textOf(entry)]), [
    ["user", "Correggere glitch dell'interfaccia mobile"],
    ["assistant", "Ho corretto il glitch."]
  ])
  assert.equal(timeline[0].taskdesk.kind, "native")
  assert.equal(timeline[1].taskdesk.agentLabel, "Claude")
})

test("a durable Task still refuses native turns that are not its own", () => {
  const first = run()
  const timeline = buildWorkThreadTimeline(task({ run: first, runs: [first] }), {
    "session-codex": [
      message("session-codex", "task-user", "user", 1, first.prompt),
      message("session-codex", "task-assistant", "assistant", 2, "Task answer"),
      message("session-codex", "manual-user", "user", 3, "Manual native-session question"),
      message("session-codex", "manual-assistant", "assistant", 4, "Manual native answer")
    ]
  }, agents)
  assert.deepEqual(timeline.map(textOf), ["Initial request", "Task answer"])
})

test("a handoff packet with no user instruction keeps its reply visible", () => {
  const packet = [
    "You are taking over an existing TaskDesk task.",
    "The context below was transferred by TaskDesk. It is not native conversational memory from another harness.",
    "",
    "TASK OBJECTIVE",
    "Lavora sul workspace condiviso",
    "",
    "USER INSTRUCTION",
    "",
    "",
    "Continue from the shared workspace and the transferred Task Context."
  ].join("\n")
  const timeline = buildWorkThreadTimeline(anchorTask(), {
    "session-claude": [
      message("session-claude", "u1", "user", 1_000, packet),
      message("session-claude", "a1", "assistant", 2_000, "Ho ispezionato il workspace.")
    ]
  }, agents, nativeOptions)

  assert.deepEqual(timeline.map((entry) => entry.info.role), [CONVERSATION_EVENT_ROLE, "assistant"])
  assert.match(textOf(timeline[0]), /Context transferred by TaskDesk/)
  assert.equal(textOf(timeline[1]), "Ho ispezionato il workspace.")
  // The envelope is never quoted back at the user as something they wrote.
  assert.equal(timeline.some((entry) => textOf(entry).includes("You are taking over")), false)
})

test("a native turn recovered after a matched Run keeps transcript order", () => {
  const first = run({ sessionId: "session-claude", agentId: "claude", prompt: "First request", startedAt: "1970-01-01T00:00:01.000Z" })
  const value = task({
    id: "native-session-v3:machine:claude:session-claude",
    agentId: "claude",
    prompt: "First request",
    run: first,
    runs: [first]
  })
  const timeline = buildWorkThreadTimeline(value, {
    "session-claude": [
      message("session-claude", "u1", "user", 1_000, "First request"),
      message("session-claude", "a1", "assistant", 2_000, "First answer"),
      message("session-claude", "u2", "user", 3_000, "Asked directly in the harness"),
      message("session-claude", "a2", "assistant", 4_000, "Answered in the harness")
    ]
  }, agents, nativeOptions)

  assert.deepEqual(timeline.map(textOf), [
    "First request",
    "First answer",
    "Asked directly in the harness",
    "Answered in the harness"
  ])
})

test("a native Session whose replay starts with assistant output is not dropped", () => {
  const timeline = buildWorkThreadTimeline(anchorTask(), {
    "session-claude": [
      message("session-claude", "a0", "assistant", 500, "Recovered summary of earlier work"),
      message("session-claude", "u1", "user", 1_000, "Continua"),
      message("session-claude", "a1", "assistant", 2_000, "Continuo.")
    ]
  }, agents, nativeOptions)

  assert.deepEqual(timeline.map(textOf), [
    "Recovered summary of earlier work",
    "Continua",
    "Continuo."
  ])
})
