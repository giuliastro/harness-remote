import assert from "node:assert/strict"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

/**
 * One ACP connection with several native Sessions, enough to exercise close/reload bookkeeping.
 * The fake deliberately has no journal: reloading after an unload must go through session/load, just
 * as Claude Code's adapter does.
 */
class FakeAcp {
  calls = []
  pendingRequests = []
  holdPrompt = false
  holdClose = false
  #sessions = new Map()
  #next = 0
  #releasePrompt
  #releaseClose

  on() { return this }
  off() { return this }
  async start() {}
  close() {}
  notify() {}
  diagnostics() { return { pendingRequests: this.pendingRequests } }
  async listSessions() { return [...this.#sessions.values()] }

  async request(method, params) {
    this.calls.push([method, params])
    if (method === "session/new") {
      const sessionId = `s${++this.#next}`
      this.#sessions.set(sessionId, { sessionId, cwd: params.cwd, updatedAt: new Date().toISOString() })
      return { sessionId }
    }
    if (method === "session/load") {
      const session = this.#sessions.get(params.sessionId)
      if (!session) throw new Error("Session not found")
      return { sessionId: session.sessionId }
    }
    if (method === "session/close") {
      if (this.holdClose) {
        this.holdClose = false
        await new Promise((resolve) => { this.#releaseClose = resolve })
      }
      return {}
    }
    if (method === "session/prompt") {
      if (this.holdPrompt) {
        this.holdPrompt = false
        await new Promise((resolve) => { this.#releasePrompt = resolve })
      }
      return { stopReason: "end_turn" }
    }
    return {}
  }

  releasePrompt() {
    this.#releasePrompt?.()
    this.#releasePrompt = undefined
  }

  releaseClose() {
    this.#releaseClose?.()
    this.#releaseClose = undefined
  }

  count(method) {
    return this.calls.filter(([name]) => name === method).length
  }
}

function settleTick() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitFor(condition, label) {
  for (let i = 0; i < 2000; i += 1) {
    if (condition()) return
    await settleTick()
  }
  assert.ok(condition(), label ?? "condition never held")
}

test("an idle native Session is closed and reloaded on the next read", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp, {
    idleUnloadMs: 60_000,
    canUnloadIdleSession: async () => true
  })
  const session = await service.createSession({ directory: "/repo" })

  assert.deepEqual(await service.sweepIdleSessions({ now: Date.now() + 59_000 }), [])
  assert.equal(service.diagnostics().openNativeSessions, 1)

  assert.deepEqual(await service.sweepIdleSessions({ now: Date.now() + 61_000 }), [session.id])
  assert.equal(acp.count("session/close"), 1)
  assert.equal(service.diagnostics().openNativeSessions, 0)
  assert.equal(service.diagnostics().idleUnload.unloads, 1)

  const messages = await service.messages(session.id)
  assert.deepEqual(messages, [])
  assert.equal(acp.count("session/load"), 1, "reading the unloaded Session must reopen it")
  assert.equal(service.diagnostics().openNativeSessions, 1)
})

test("a Session with a turn in flight is never unloaded", async () => {
  const acp = new FakeAcp()
  acp.holdPrompt = true
  const service = new AcpService(acp, {
    idleUnloadMs: 60_000,
    canUnloadIdleSession: async () => true
  })
  const session = await service.createSession({ directory: "/repo" })
  const turn = service.prompt(session.id, "work")
  await waitFor(() => service.status(session.id).type === "busy", "the turn never started")

  assert.deepEqual(await service.sweepIdleSessions({ now: Date.now() + 3_600_000 }), [])
  assert.equal(acp.count("session/close"), 0)

  acp.releasePrompt()
  await turn
  await waitFor(() => service.status(session.id).type === "idle", "the turn never settled")
  assert.deepEqual(await service.sweepIdleSessions({ now: Date.now() + 3_600_000 }), [session.id])
  assert.equal(acp.count("session/close"), 1)
})

test("a Session with a pending ACP request is never unloaded", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp, {
    idleUnloadMs: 60_000,
    canUnloadIdleSession: async () => true
  })
  const session = await service.createSession({ directory: "/repo" })
  acp.pendingRequests = [{ method: "session/prompt", sessionID: session.id }]

  assert.deepEqual(await service.sweepIdleSessions({ now: Date.now() + 3_600_000 }), [])
  assert.equal(acp.count("session/close"), 0)
})

test("a harness that cannot prove the Session is idle keeps it open", async () => {
  const acp = new FakeAcp()
  let safe = false
  const service = new AcpService(acp, {
    idleUnloadMs: 60_000,
    canUnloadIdleSession: async () => safe
  })
  const session = await service.createSession({ directory: "/repo" })

  assert.deepEqual(await service.sweepIdleSessions({ now: Date.now() + 3_600_000 }), [])
  assert.equal(acp.count("session/close"), 0)
  assert.equal(service.diagnostics().openNativeSessions, 1)

  safe = true
  assert.deepEqual(await service.sweepIdleSessions({ now: Date.now() + 3_600_000 }), [session.id])
  assert.equal(acp.count("session/close"), 1)
})

test("the open-Session cap closes the least recently used idle Sessions", async () => {
  const acp = new FakeAcp()
  let safe = false
  const service = new AcpService(acp, {
    maxLoadedSessions: 2,
    canUnloadIdleSession: async () => safe
  })
  const first = await service.createSession({ directory: "/repo" })
  await settleTick()
  const second = await service.createSession({ directory: "/repo" })
  await settleTick()
  const third = await service.createSession({ directory: "/repo" })
  assert.equal(service.diagnostics().openNativeSessions, 3, "the cap is soft while unloading is unproven")

  safe = true
  // The creation of the third Session already started a limit sweep that found unloading unsafe;
  // let it settle so this one does not overlap a close it is about to perform itself.
  await settleTick()
  await settleTick()
  assert.deepEqual(await service.sweepIdleSessions({ protect: [third.id] }), [first.id])
  assert.equal(service.diagnostics().openNativeSessions, 2)
  assert.equal(acp.count("session/close"), 1)
  assert.deepEqual(acp.calls.filter(([method]) => method === "session/close").map(([, params]) => params.sessionId), [first.id])
})

test("a prompt after an unload reloads the transcript before it starts the turn", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp, {
    idleUnloadMs: 60_000,
    canUnloadIdleSession: async () => true
  })
  const session = await service.createSession({ directory: "/repo" })
  await service.prompt(session.id, "first")
  await waitFor(() => service.status(session.id).type === "idle", "the first turn never settled")
  const before = await service.messages(session.id)
  assert.equal(before.filter((message) => message.info.role === "user").length, 1)

  assert.deepEqual(await service.sweepIdleSessions({ now: Date.now() + 61_000 }), [session.id])
  const loadsAfterClose = acp.count("session/load")

  await service.prompt(session.id, "second")
  await waitFor(() => service.status(session.id).type === "idle", "the reloaded turn never settled")
  assert.equal(acp.count("session/load"), loadsAfterClose + 1)
  const after = await service.messages(session.id)
  assert.equal(after.filter((message) => message.info.role === "user").length, 2)
  assert.equal(after.filter((message) => message.parts?.some((part) => part.text === "first")).length, 1, "the reload must not duplicate history")
})

test("a prompt that arrives while the idle guard is deciding keeps the Session open", async () => {
  const acp = new FakeAcp()
  let releaseGuard
  const deciding = new Promise((resolve) => { releaseGuard = resolve })
  const service = new AcpService(acp, {
    idleUnloadMs: 60_000,
    canUnloadIdleSession: async () => {
      await deciding
      return true
    }
  })
  const session = await service.createSession({ directory: "/repo" })
  const sweeping = service.sweepIdleSessions({ now: Date.now() + 61_000 })
  const turn = service.prompt(session.id, "work")
  releaseGuard()

  assert.deepEqual(await sweeping, [])
  await turn
  assert.equal(acp.count("session/close"), 0)
  assert.equal(acp.count("session/load"), 0, "the Session never left the adapter")
})

test("a prompt that arrives while the Session is being closed waits and reloads it", async () => {
  const acp = new FakeAcp()
  acp.holdClose = true
  const service = new AcpService(acp, {
    idleUnloadMs: 60_000,
    canUnloadIdleSession: async () => true
  })
  const session = await service.createSession({ directory: "/repo" })
  await service.prompt(session.id, "first")
  await waitFor(() => service.status(session.id).type === "idle", "the first turn never settled")

  acp.holdClose = true
  const sweeping = service.sweepIdleSessions({ now: Date.now() + 61_000 })
  await waitFor(() => acp.count("session/close") === 1, "the close never started")
  const turn = service.prompt(session.id, "second")
  acp.releaseClose()

  assert.deepEqual(await sweeping, [session.id])
  await turn
  await waitFor(() => service.status(session.id).type === "idle", "the reloaded turn never settled")
  const methods = acp.calls.map(([method]) => method)
  assert.ok(methods.indexOf("session/close") < methods.indexOf("session/load"), "the prompt must wait for the close")
  const after = await service.messages(session.id)
  assert.equal(after.filter((message) => message.info.role === "user").length, 2)
})
