import assert from "node:assert/strict"
import test from "node:test"
import { WorkThreadController } from "../src/work-thread-controller.js"

function activeTask(transport) {
  return {
    id: `task-${transport}`,
    status: "running",
    agentId: transport === "acp" ? "codex" : "opencode",
    workspace: { mode: "project", path: "/repo" },
    run: {
      id: `run-${transport}`,
      sequence: 1,
      agentId: transport === "acp" ? "codex" : "opencode",
      sessionId: `session-${transport}`,
      transport,
      directory: "/repo",
      prompt: "Start work",
      status: "running",
      startedAt: "2026-08-21T12:00:00.000Z"
    }
  }
}

function storeFor(initial) {
  let current = structuredClone(initial)
  let transitions = 0
  return {
    stateDirectory: "/tmp/taskdesk-test",
    get transitions() { return transitions },
    get current() { return structuredClone(current) },
    async get() { return structuredClone(current) },
    async setRunState(_taskID, update) {
      transitions += 1
      current = {
        ...current,
        status: update.status,
        run: structuredClone(update.run ?? current.run),
        error: update.error ?? null
      }
      return structuredClone(current)
    }
  }
}

for (const transport of ["acp", "http"]) {
  test(`${transport} startup grace does not mistake a not-yet-busy native Session for a completed turn`, async () => {
    const store = storeFor(activeTask(transport))
    let now = "2026-08-21T12:00:14.999Z"
    const controller = new WorkThreadController({
      taskStore: store,
      taskRunController: {
        acpService: () => ({ status: () => ({ type: "idle" }) }),
        taskLauncher: { async inspectRun() { return "completed" } }
      },
      clock: () => now
    })

    const duringGrace = await controller.reconcile(store.current.id)
    assert.equal(duringGrace.status, "running")
    assert.equal(store.transitions, 0)

    now = "2026-08-21T12:00:15.001Z"
    const afterGrace = await controller.reconcile(store.current.id)
    assert.equal(afterGrace.status, "completed")
    assert.equal(store.transitions, 1)
  })
}
