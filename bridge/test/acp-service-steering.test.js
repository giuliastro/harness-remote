import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { harnessProfile } from "../src/harness-profiles.js"

/**
 * A prompt that arrives while a transcript turn is already streaming follows the harness's
 * `midTurnPrompt` capability: Codex forwards it into the live turn through the adapter's
 * `_session/steering` method, every other harness keeps the long-standing queue. These tests pin
 * both halves of that split and the adapter-outcome handling around `_session/steering`.
 */
class RecordingSteeringAcp {
  calls = []
  #listeners = new Set()
  promptCapabilities = {}
  processID = 4242
  previousPromptDone = false
  waitingOnPreviousTurn = false
  constructor({ steer = "resolve", holdPrompt = false } = {}) {
    this.steer = steer
    // Only the first prompt is held so the live turn genuinely streams; any turn that starts after
    // the drain ends immediately, mirroring a real adapter whose turns finish on their own.
    this.holdsLeft = holdPrompt ? 1 : 0
  }
  on() { return this }
  off() { return this }
  async start() {}
  close() {}
  diagnostics() { return { processID: this.processID } }
  notify() {}
  async listSessions() { return [{ sessionId: "s1", cwd: "/repo", title: "S1", updatedAt: new Date().toISOString() }] }
  async request(method, params) {
    this.calls.push([method, params])
    if (method === "session/load" || method === "session/new") return { sessionId: "s1" }
    if (method === "session/prompt") {
      if (this.holdsLeft > 0) {
        this.holdsLeft -= 1
        await new Promise((resolve) => { this.releasePrompt = resolve })
      }
      this.previousPromptDone = true
      this.releasePrevious?.()
      return { stopReason: "end_turn" }
    }
    if (method === "_session/steering") {
      if (this.steer === "reject") throw new Error("steering is not supported here")
      // The real adapter starts a steering turn only after the previous prompt has drained, so the
      // startedNewTurn outcome arrives after the first session/prompt response, never alongside it.
      if (this.steer === "startedNewTurn" && !this.previousPromptDone) {
        this.waitingOnPreviousTurn = true
        await new Promise((resolve) => { this.releasePrevious = resolve })
        this.waitingOnPreviousTurn = false
      }
      return { outcome: this.steer }
    }
    return {}
  }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
}

async function userMessageCount(service, sessionID = "s1") {
  return (await service.messages(sessionID)).filter((message) => message.info.role === "user").length
}

/** One macrotask so the settled turn's queue drain has actually run before assertions look. */
function settleTick() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Waits for an observable bridge state instead of counting microtask hops inside the service, so
 * the tests follow behavior rather than the service's internal promise ordering.
 */
async function waitFor(condition, label) {
  for (let i = 0; i < 2000; i += 1) {
    if (condition()) return
    await settleTick()
  }
  assert.ok(condition(), label ?? "condition never held")
}

test("a steering harness forwards a prompt into the live turn instead of queueing it", async () => {
  const acp = new RecordingSteeringAcp({ holdPrompt: true, steer: "injected" })
  const service = new AcpService(acp, { midTurnPrompt: "steer" })
  const first = service.prompt("s1", "first")
  await waitFor(() => service.status("s1").type === "busy", "the first turn never started")
  await service.prompt("s1", "second")
  const steering = acp.calls.filter(([method]) => method === "_session/steering")
  assert.equal(steering.length, 1)
  assert.deepEqual(steering[0][1].prompt, [{ type: "text", text: "second" }])
  const prompts = acp.calls.filter(([method]) => method === "session/prompt").map(([method, params]) => params.prompt[0].text)
  assert.deepEqual(prompts, ["first"], "the steered prompt must not become a second session/prompt")
  assert.equal(await userMessageCount(service), 2, "the steered prompt is recorded and visible right away")
  acp.releasePrompt?.()
  await first
  await waitFor(() => service.status("s1").type === "idle", "the steered turn never settled")
})

test("an adapter that refuses steering hands the recorded prompt to the ordinary queue", async () => {
  const acp = new RecordingSteeringAcp({ holdPrompt: true, steer: "reject" })
  const service = new AcpService(acp, { midTurnPrompt: "steer" })
  const first = service.prompt("s1", "first")
  await waitFor(() => service.status("s1").type === "busy", "the first turn never started")
  await service.prompt("s1", "second")
  assert.equal(await userMessageCount(service), 2, "the steered attempt is still recorded exactly once")
  acp.releasePrompt?.()
  await first
  await waitFor(() => acp.calls.filter(([method]) => method === "session/prompt").length >= 2, "the queued message never started a turn")
  // The queue drains after the first turn: the held prompt answer ends, the queued message becomes
  // a regular session/prompt with its own recorded turn (no re-record of the same message).
  const prompts = acp.calls.filter(([method]) => method === "session/prompt").map(([method, params]) => params.prompt[0].text)
  assert.deepEqual(prompts, ["first", "second"])
  assert.equal(await userMessageCount(service), 2)
  await waitFor(() => service.status("s1").type === "idle", "the drained queue never settled")
})

test("a queueing harness never calls the adapter's steering method", async () => {
  const acp = new RecordingSteeringAcp({ holdPrompt: true })
  const service = new AcpService(acp) // default policy: queue
  const first = service.prompt("s1", "first")
  await waitFor(() => service.status("s1").type === "busy", "the first turn never started")
  await service.prompt("s1", "second")
  acp.releasePrompt?.()
  await first
  await waitFor(() => acp.calls.filter(([method]) => method === "session/prompt").length >= 2, "the queued message never started a turn")
  assert.equal(acp.calls.some(([method]) => method === "_session/steering"), false)
  const prompts = acp.calls.filter(([method]) => method === "session/prompt").map(([method, params]) => params.prompt[0].text)
  assert.deepEqual(prompts, ["first", "second"])
})

test("a slash command takes the queue even while a steering turn runs", async () => {
  const acp = new RecordingSteeringAcp({ holdPrompt: true })
  const service = new AcpService(acp, { midTurnPrompt: "steer" })
  const first = service.prompt("s1", "first")
  await waitFor(() => service.status("s1").type === "busy", "the first turn never started")
  await service.prompt("s1", "/rename New name")
  acp.releasePrompt?.()
  await first
  await waitFor(() => acp.calls.filter(([method]) => method === "session/prompt").length >= 2, "the queued slash command never started a turn")
  assert.equal(acp.calls.some(([method]) => method === "_session/steering"), false)
  const prompts = acp.calls.filter(([method]) => method === "session/prompt").map(([method, params]) => params.prompt[0].text)
  assert.deepEqual(prompts, ["first", "/rename New name"])
})

test("a steering request that resolves startedNewTurn keeps the session busy until it is settled", async () => {
  const acp = new RecordingSteeringAcp({ holdPrompt: true, steer: "startedNewTurn" })
  const service = new AcpService(acp, { midTurnPrompt: "steer" })
  const first = service.prompt("s1", "first")
  await waitFor(() => service.status("s1").type === "busy", "the first turn never started")
  const second = service.prompt("s1", "second")
  // The steering response is in flight inside the adapter until the previous turn drains, which is
  // the order the real adapter guarantees for a turn it starts itself.
  await waitFor(() => acp.waitingOnPreviousTurn, "the steering request never reached the adapter")
  acp.releasePrompt?.()
  await first
  await second
  await waitFor(() => service.status("s1").type === "busy", "the adopted turn never took over")
  // The adapter started the second prompt as its own turn that only its own stream can end, so the
  // bridge must keep reading as busy (an adopted turn) instead of reporting a mid-stream idle.
  assert.equal(await userMessageCount(service), 2, "the steered prompt is visible in the transcript")
  service.abort("s1")
  assert.equal(service.status("s1").type, "idle")
})

test("harness profiles declare exactly one steering harness", () => {
  const steering = Object.entries({
    omp: harnessProfile("omp"),
    pi: harnessProfile("pi"),
    claude: harnessProfile("claude"),
    copilot: harnessProfile("copilot"),
    opencode2: harnessProfile("opencode2"),
    mimo: harnessProfile("mimo"),
    codex: harnessProfile("codex")
  }).filter(([, profile]) => profile.capabilities.midTurnPrompt === "steer").map(([id]) => id)
  assert.deepEqual(steering, ["codex"])
})

/** A fake adapter that also streams session/update notifications, for transcript-order checks. */
class StreamingAcp extends EventEmitter {
  calls = []
  releases = []
  promptCapabilities = {}
  constructor({ setModel } = {}) {
    super()
    this.setModel = setModel
  }
  async start() {}
  close() {}
  notify() {}
  diagnostics() { return {} }
  async listSessions() { return [{ sessionId: "s1", cwd: process.cwd(), title: "S1", updatedAt: new Date().toISOString() }] }
  configOptions() {
    return [{ id: "model", currentValue: "provider/default", options: [{ value: "provider/default" }, { value: "provider/model" }] }]
  }
  chunk(text) {
    this.emit("notification", { method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } })
  }
  async request(method, params) {
    this.calls.push([method, params])
    if (method === "session/load" || method === "session/new") return { sessionId: "s1", configOptions: this.configOptions() }
    if (method === "session/prompt") {
      await new Promise((resolve) => this.releases.push(resolve))
      return { stopReason: "end_turn" }
    }
    if (method === "_session/steering") return { outcome: "injected" }
    if (method === "session/set_config_option") {
      await this.setModel?.(params)
      return { configOptions: this.configOptions() }
    }
    return {}
  }
}

async function transcriptShape(service) {
  return (await service.messages("s1")).map((message) => `${message.info.role}:${message.parts.map((part) => part.text ?? part.type).join("")}`)
}

test("output streamed after an injected steering prompt answers that prompt, below its user row", async () => {
  const acp = new StreamingAcp()
  const service = new AcpService(acp, { midTurnPrompt: "steer" })
  void service.prompt("s1", "first")
  await waitFor(() => acp.releases.length === 1, "the first turn never started")
  acp.chunk("working on first")
  await service.prompt("s1", "second")
  acp.chunk("answer to second")
  assert.deepEqual(await transcriptShape(service), [
    "user:first",
    "assistant:working on first",
    "user:second",
    "assistant:answer to second"
  ])
  acp.releases.shift()()
  await waitFor(() => service.status("s1").type === "idle", "the steered turn never settled")
})

test("a queued prompt keeps the session busy while its model is applied on dequeue", async () => {
  let releaseModel
  const acp = new StreamingAcp({ setModel: () => new Promise((resolve) => { releaseModel = resolve }) })
  const service = new AcpService(acp)
  void service.prompt("s1", "first")
  await waitFor(() => acp.releases.length === 1, "the first turn never started")
  await service.prompt("s1", "second", "provider/model")
  acp.releases.shift()()
  await waitFor(() => typeof releaseModel === "function", "the queued model switch never started")
  assert.equal(service.status("s1").type, "busy", "the gap between two turns must not read idle")
  // A prompt arriving during the switch waits behind the queued one instead of overtaking it.
  await service.prompt("s1", "third")
  releaseModel({})
  await waitFor(() => acp.releases.length === 1, "the queued prompt never started")
  acp.releases.shift()()
  await waitFor(() => acp.releases.length === 1, "the third prompt never started")
  const prompts = acp.calls.filter(([method]) => method === "session/prompt").map(([, params]) => params.prompt[0].text)
  assert.deepEqual(prompts, ["first", "second", "third"])
  acp.releases.shift()()
  await waitFor(() => service.status("s1").type === "idle", "the queue never drained")
})

test("a prompt queued before the running turn streams anything still sits below that turn's reply", async () => {
  const acp = new StreamingAcp()
  const service = new AcpService(acp)
  void service.prompt("s1", "first")
  await waitFor(() => acp.releases.length === 1, "the first turn never started")
  // Queued while the first turn is still "getting started": no assistant row exists yet.
  await service.prompt("s1", "second")
  acp.chunk("answer to first")
  assert.deepEqual(await transcriptShape(service), ["user:first", "assistant:answer to first", "user:second"])
  acp.releases.shift()()
  await waitFor(() => acp.releases.length === 1, "the queued prompt never started")
  acp.chunk("answer to second")
  assert.deepEqual(await transcriptShape(service), [
    "user:first",
    "assistant:answer to first",
    "user:second",
    "assistant:answer to second"
  ])
  acp.releases.shift()()
  await waitFor(() => service.status("s1").type === "idle", "the queue never drained")
})

test("a prompt arriving while the first one is still switching models waits instead of starting a parallel turn", async () => {
  let releaseModel
  const acp = new StreamingAcp({ setModel: () => new Promise((resolve) => { releaseModel = resolve }) })
  const service = new AcpService(acp)
  const first = service.prompt("s1", "first", "provider/model")
  await waitFor(() => typeof releaseModel === "function", "the first model switch never started")
  const second = service.prompt("s1", "second")
  releaseModel({})
  await Promise.all([first, second])
  const prompts = () => acp.calls.filter(([method]) => method === "session/prompt").map(([, params]) => params.prompt[0].text)
  assert.deepEqual(prompts(), ["first"], "the second prompt must queue behind the first turn, not run beside it")
  acp.releases.shift()()
  await waitFor(() => acp.releases.length === 1, "the queued prompt never started")
  assert.deepEqual(prompts(), ["first", "second"])
  acp.releases.shift()()
  await waitFor(() => service.status("s1").type === "idle", "the queue never drained")
})

test("a running turn's late prompt echo is still suppressed after another prompt is queued", async () => {
  const acp = new StreamingAcp()
  const service = new AcpService(acp)
  void service.prompt("s1", "first")
  await waitFor(() => acp.releases.length === 1, "the first turn never started")
  await service.prompt("s1", "second")
  // Some adapters echo the prompt they are running back as a user chunk.
  acp.emit("notification", { method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "first" } } } })
  acp.chunk("answer to first")
  assert.deepEqual(await transcriptShape(service), ["user:first", "assistant:answer to first", "user:second"])
  acp.releases.shift()()
  await waitFor(() => acp.releases.length === 1, "the queued prompt never started")
  acp.emit("notification", { method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "second" } } } })
  acp.chunk("answer to second")
  assert.deepEqual(await transcriptShape(service), ["user:first", "assistant:answer to first", "user:second", "assistant:answer to second"])
  acp.releases.shift()()
  await waitFor(() => service.status("s1").type === "idle", "the queue never drained")
})

test("a queued prompt is flagged queued in the transcript until it starts, and prompt() reports the disposition", async () => {
  const acp = new StreamingAcp()
  const service = new AcpService(acp)
  const first = await service.prompt("s1", "first")
  assert.equal(first.disposition, "started")
  await waitFor(() => acp.releases.length === 1, "the first turn never started")
  const second = await service.prompt("s1", "second")
  assert.equal(second.disposition, "queued")
  const queuedRow = (await service.messages("s1")).find((message) => message.info.id === second.messageID)
  assert.equal(queuedRow.info.queued, true, "the waiting prompt carries the queued flag")
  assert.equal((await service.messages("s1")).find((message) => message.info.id === first.messageID).info.queued, undefined)
  acp.releases.shift()()
  await waitFor(() => acp.releases.length === 1, "the queued prompt never started")
  const started = (await service.messages("s1")).find((message) => message.info.id === second.messageID)
  assert.equal(started.info.queued, undefined, "the flag clears when the daemon hands the prompt to the harness")
  acp.releases.shift()()
  await waitFor(() => service.status("s1").type === "idle", "the queue never drained")
})

test("a steering harness reports a steered prompt, and Stop removes a queued one with its flag", async () => {
  const steering = new StreamingAcp()
  const steerService = new AcpService(steering, { midTurnPrompt: "steer" })
  await steerService.prompt("s1", "first")
  await waitFor(() => steering.releases.length === 1, "the first turn never started")
  assert.equal((await steerService.prompt("s1", "second")).disposition, "steered")
  steering.releases.shift()()
  await waitFor(() => steerService.status("s1").type === "idle", "the steered turn never settled")

  const acp = new StreamingAcp()
  const service = new AcpService(acp)
  await service.prompt("s1", "first")
  await waitFor(() => acp.releases.length === 1, "the first turn never started")
  const queued = await service.prompt("s1", "second")
  service.abort("s1")
  assert.equal((await service.messages("s1")).some((message) => message.info.id === queued.messageID), false)
  acp.releases.shift()()
})

test("unqueue withdraws one waiting prompt and leaves the running turn and the rest of the queue alone", async () => {
  const acp = new StreamingAcp()
  const service = new AcpService(acp)
  await service.prompt("s1", "first")
  await waitFor(() => acp.releases.length === 1, "the first turn never started")
  const second = await service.prompt("s1", "second")
  await service.prompt("s1", "third")
  assert.equal(service.unqueue("s1", second.messageID), true)
  assert.equal(service.unqueue("s1", second.messageID), false, "a prompt no longer waiting cannot be withdrawn twice")
  assert.equal((await service.messages("s1")).some((message) => message.info.id === second.messageID), false)
  assert.equal(service.status("s1").type, "busy", "the running turn keeps running")
  acp.releases.shift()()
  await waitFor(() => acp.releases.length === 1, "the remaining queued prompt never started")
  const prompts = acp.calls.filter(([method]) => method === "session/prompt").map(([, params]) => params.prompt[0].text)
  assert.deepEqual(prompts, ["first", "third"])
  acp.releases.shift()()
  await waitFor(() => service.status("s1").type === "idle", "the queue never drained")
})
