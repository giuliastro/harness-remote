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

/**
 * Claude Code resumes on its own when a background command or subagent it was waiting on finishes:
 * the adapter streams a new turn after the previous session/prompt already resolved, with no
 * session/prompt of its own. The bridge has to adopt that turn rather than drop or orphan it.
 */
class AgentTurnAcp extends StreamingAcp {
  notifications = []
  notify(method, params) { this.notifications.push([method, params]) }
  update(update) {
    this.emit("notification", { method: "session/update", params: { sessionId: "s1", update } })
  }
  toolCall(toolCallId, status = "pending") {
    this.update({ sessionUpdate: "tool_call", toolCallId, title: "Read File", kind: "read", status })
  }
  toolDone(toolCallId) {
    this.update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" })
  }
}

/** The adopted-turn sweep runs on a real timer, so waiting on it needs wall-clock time. */
async function waitForTime(condition, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(condition(), label ?? "condition never held")
}

const AGENT_TURN_OPTIONS = { agentTurnSettleIdleMs: 60, agentTurnGraceMs: 0 }

async function finishFirstTurn(acp, service, reply = "waiting for the background task") {
  await service.prompt("s1", "run it in the background")
  await waitFor(() => acp.releases.length === 1, "the first turn never started")
  acp.chunk(reply)
  acp.releases.shift()()
  await waitFor(() => service.status("s1").type === "idle", "the first turn never settled")
}

test("a turn the agent starts after its prompt resolved is adopted as a new busy reply and settles on silence", async () => {
  const acp = new AgentTurnAcp()
  const service = new AcpService(acp, AGENT_TURN_OPTIONS)
  const statuses = []
  service.subscribe((event) => { if (event.type === "session.updated") statuses.push(service.status("s1").type) })
  await finishFirstTurn(acp, service)
  statuses.length = 0

  acp.toolCall("t-read")
  assert.equal(service.status("s1").type, "busy", "the resumed turn must read as running")
  assert.equal(service.hasAdoptedTurn("s1"), true)
  acp.toolDone("t-read")
  acp.chunk("the background task printed DONE")

  const messages = await service.messages("s1")
  assert.deepEqual(messages.map((message) => message.info.role), ["user", "assistant", "assistant"],
    "the resumed output is a reply of its own, not appended to the earlier one")
  assert.equal(messages[1].parts.map((part) => part.text).join(""), "waiting for the background task")
  assert.deepEqual(messages[2].parts.map((part) => part.type === "tool" ? `tool:${part.state.status}` : part.text),
    ["tool:completed", "the background task printed DONE"])

  await waitForTime(() => service.status("s1").type === "idle", "the adopted turn never settled")
  assert.equal(service.hasAdoptedTurn("s1"), false)
  assert.deepEqual(statuses, ["busy", "idle"])
})

test("output arriving right after a turn ended stays that turn's tail and does not open a new one", async () => {
  const acp = new AgentTurnAcp()
  const service = new AcpService(acp, { agentTurnSettleIdleMs: 60, agentTurnGraceMs: 60_000 })
  await finishFirstTurn(acp, service)
  acp.chunk(" late tail")
  assert.equal(service.status("s1").type, "idle")
  assert.equal(service.hasAdoptedTurn("s1"), false)
})

test("a Session this bridge never ran a turn in does not adopt unsolicited output", async () => {
  const acp = new AgentTurnAcp()
  const service = new AcpService(acp, AGENT_TURN_OPTIONS)
  await service.messages("s1")
  acp.chunk("someone else's turn")
  assert.equal(service.status("s1").type, "idle")
  assert.equal((await service.messages("s1")).length, 0)
})

test("a prompt sent during an adopted turn queues behind it and starts once the turn settles", async () => {
  const acp = new AgentTurnAcp()
  const service = new AcpService(acp, AGENT_TURN_OPTIONS)
  await finishFirstTurn(acp, service)
  acp.chunk("resuming after the subagent finished")
  const queued = await service.prompt("s1", "and now this")
  assert.equal(queued.disposition, "queued")
  await waitForTime(() => acp.releases.length === 1, "the queued prompt never started after the adopted turn")
  assert.equal(service.hasAdoptedTurn("s1"), false)
  const prompts = acp.calls.filter(([method]) => method === "session/prompt").map(([, params]) => params.prompt[0].text)
  assert.deepEqual(prompts, ["run it in the background", "and now this"])
  acp.chunk("answer to the queued prompt")
  assert.deepEqual(await transcriptShape(service), [
    "user:run it in the background",
    "assistant:waiting for the background task",
    "assistant:resuming after the subagent finished",
    "user:and now this",
    "assistant:answer to the queued prompt"
  ])
  acp.releases.shift()()
  await waitFor(() => service.status("s1").type === "idle", "the queued turn never settled")
})

test("Stop ends an adopted turn: the harness is cancelled and its later output is dropped", async () => {
  const acp = new AgentTurnAcp()
  const service = new AcpService(acp, AGENT_TURN_OPTIONS)
  await finishFirstTurn(acp, service)
  acp.chunk("resuming")
  assert.equal(service.status("s1").type, "busy")
  service.abort("s1")
  assert.equal(service.status("s1").type, "idle")
  assert.equal(service.hasAdoptedTurn("s1"), false)
  assert.deepEqual(acp.notifications, [["session/cancel", { sessionId: "s1" }]])
  acp.chunk(" after stop")
  assert.equal(service.status("s1").type, "idle")
  assert.deepEqual(await transcriptShape(service), [
    "user:run it in the background",
    "assistant:waiting for the background task",
    "assistant:resuming"
  ])
})

test("an adopted turn stays open while a tool call it opened is still running", async () => {
  const acp = new AgentTurnAcp()
  const service = new AcpService(acp, AGENT_TURN_OPTIONS)
  await finishFirstTurn(acp, service)
  acp.toolCall("t-long", "in_progress")
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(service.status("s1").type, "busy", "a running tool keeps the adopted turn open past the idle window")
  acp.toolDone("t-long")
  await waitForTime(() => service.status("s1").type === "idle", "the adopted turn never settled after its tool ended")
})

test("Claude replies streamed back to back become separate paragraphs, keyed by the adapter's message id", async () => {
  const textParts = async (service) => (await service.messages("s1"))
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text))
  const stream = (acp, messageId, text) => acp.update({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } })

  const claude = new AgentTurnAcp()
  const service = new AcpService(claude, { ...AGENT_TURN_OPTIONS, assistantMessageIDsSeparateReplies: true })
  await service.prompt("s1", "run both in the background")
  await waitFor(() => claude.releases.length === 1, "the turn never started")
  stream(claude, "msg_a", "I will report back")
  stream(claude, "msg_a", " when they finish.")
  // The first background task finished while the turn was still open: a new API message follows.
  stream(claude, "msg_b", "The first one printed UNO.")
  assert.deepEqual(await textParts(service), ["I will report back when they finish.", "The first one printed UNO."])
  claude.releases.shift()()
  await waitFor(() => service.status("s1").type === "idle", "the turn never settled")

  // PI mints a fresh id per fragment, so without the option the fragments stay one paragraph.
  const pi = new AgentTurnAcp()
  const piService = new AcpService(pi, AGENT_TURN_OPTIONS)
  await piService.prompt("s1", "hello")
  await waitFor(() => pi.releases.length === 1, "the turn never started")
  stream(pi, "frag-1", "Hel")
  stream(pi, "frag-2", "lo")
  assert.deepEqual(await textParts(piService), ["Hello"])
  pi.releases.shift()()
  await waitFor(() => piService.status("s1").type === "idle", "the turn never settled")
})
