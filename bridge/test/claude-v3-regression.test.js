import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService, settleUnfinishedActivity } from "../src/acp-service.js"
import { HARNESS_PROFILES, resolveAcpLaunch } from "../src/harness-profiles.js"
import { detectBackends, resolveLaunchPlan } from "../src/launcher.js"
import {
  CLAUDE_REPORTED_BUSY_STALE_MS,
  corroborateClaudeSessionStatus
} from "../src/server.js"
import { TaskLauncher } from "../src/task-launcher.js"

test("Claude remains a first-class v3 ACP backend", () => {
  const profile = HARNESS_PROFILES.claude
  assert.equal(profile.id, "claude")
  assert.equal(profile.label, "Claude Code")
  assert.equal(profile.adapterCommand, "claude-agent-acp")
  assert.equal(profile.capabilities.sessions, true)
  assert.equal(profile.capabilities.prompt, true)
  assert.equal(profile.capabilities.models, true)
  assert.equal(profile.capabilities.todos, true)
  assert.equal(profile.recoverMissingSessionOnPrompt, true)
  assert.equal(HARNESS_PROFILES.omp.recoverMissingSessionOnPrompt, undefined)
})

test("Claude public status stops reporting a finished stale turn as Working", () => {
  const now = 1_800_000_000_000
  const busy = { type: "busy" }
  const recentPrompt = [{
    method: "session/prompt",
    sessionID: "claude-session",
    idleMs: 5_000
  }]
  assert.deepEqual(
    corroborateClaudeSessionStatus(
      busy,
      "claude-session",
      recentPrompt,
      now - CLAUDE_REPORTED_BUSY_STALE_MS - 1,
      now
    ),
    busy
  )

  const stalePrompt = [{
    method: "session/prompt",
    sessionID: "claude-session",
    idleMs: CLAUDE_REPORTED_BUSY_STALE_MS + 1
  }]
  assert.deepEqual(
    corroborateClaudeSessionStatus(
      busy,
      "claude-session",
      stalePrompt,
      now - CLAUDE_REPORTED_BUSY_STALE_MS - 1,
      now
    ),
    { type: "idle" }
  )

  assert.deepEqual(
    corroborateClaudeSessionStatus(
      busy,
      "claude-session",
      [],
      now - CLAUDE_REPORTED_BUSY_STALE_MS + 1,
      now
    ),
    { type: "idle" }
  )
  assert.deepEqual(
    corroborateClaudeSessionStatus(
      { type: "idle" },
      "claude-session",
      stalePrompt,
      now - CLAUDE_REPORTED_BUSY_STALE_MS * 2,
      now
    ),
    { type: "idle" }
  )
})

test("machine discovery detects Claude and can select it as the daemon primary", () => {
  const pathValue = ["/bin", "/tools"].join(path.delimiter)
  const existing = new Set([
    path.join("/tools", "claude"),
    path.join("/tools", "codex"),
    path.join("/tools", "opencode")
  ])
  const detected = detectBackends({
    pathValue,
    platform: "linux",
    exists: (candidate) => existing.has(candidate),
    access: () => {},
    readVersion: () => "1.19.0"
  })
  assert.deepEqual(detected, ["claude", "codex", "opencode"])
  assert.deepEqual(resolveLaunchPlan(["--backend", "claude"], detected), {
    mode: "daemon",
    backend: "claude",
    detected,
    openCode: true
  })
})

test("Claude ACP launch prefers an installed adapter and otherwise keeps the pinned fallback", () => {
  const profile = HARNESS_PROFILES.claude
  assert.deepEqual(resolveAcpLaunch(profile, { find: () => "/tools/claude-agent-acp" }), {
    command: "/tools/claude-agent-acp",
    args: [],
    source: "path"
  })
  const fallback = resolveAcpLaunch(profile, { find: () => null })
  assert.equal(fallback.source, "npx")
  assert.match(fallback.args.join(" "), /@agentclientprotocol\/claude-agent-acp@/)
})

test("Claude bare model ids are applied through the shared ACP session service", async () => {
  class FakeAcp extends EventEmitter {
    constructor() {
      super()
      this.calls = []
    }
    async start() {}
    async request(method, params) {
      this.calls.push({ method, params })
      if (method === "session/new") {
        return {
          sessionId: "claude-session",
          configOptions: [{
            id: "model",
            currentValue: "opus",
            options: [{ value: "sonnet" }, { value: "opus" }]
          }]
        }
      }
      if (method === "session/set_config_option") return {}
      throw new Error(`Unexpected ACP method: ${method}`)
    }
  }

  const acp = new FakeAcp()
  const service = new AcpService(acp)
  const session = await service.createSession({
    directory: "/repo",
    title: "Claude task",
    model: "claude/sonnet"
  })

  assert.equal(session.id, "claude-session")
  assert.deepEqual(acp.calls, [
    { method: "session/new", params: { cwd: "/repo", mcpServers: [] } },
    {
      method: "session/set_config_option",
      params: { sessionId: "claude-session", configId: "model", value: "sonnet" }
    }
  ])
})

test("Claude reloads a Session whose agent process lost its in-memory handle", async () => {
  class RecoveringClaudeAcp extends EventEmitter {
    constructor() {
      super()
      this.open = false
      this.loads = 0
      this.prompts = 0
    }

    async listSessions() {
      return [{ sessionId: ACTIVITY_SESSION, cwd: process.cwd(), title: "Recoverable Claude Session", updatedAt: new Date().toISOString() }]
    }

    async request(method, params) {
      if (method === "session/load") {
        this.loads += 1
        this.open = true
        return { configOptions: [] }
      }
      if (method !== "session/prompt") throw new Error(`Unexpected request: ${method}`)
      this.prompts += 1
      if (!this.open) throw new Error("Internal error: Session not found")
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `reply ${this.prompts}` } }
        }
      })
      return { stopReason: "end_turn" }
    }

    notify() {}
  }

  const acp = new RecoveringClaudeAcp()
  const service = new AcpService(acp, { recoverMissingSessionOnPrompt: true })
  await service.promptAndWait(ACTIVITY_SESSION, "one")

  acp.open = false
  await service.promptAndWait(ACTIVITY_SESSION, "two")

  assert.equal(acp.loads, 2)
  assert.equal(acp.prompts, 3)
  assert.deepEqual((await service.messages(ACTIVITY_SESSION)).filter((message) => message.info.role === "user").map((message) => message.parts[0].text), ["one", "two"])
  assert.equal((await service.messages(ACTIVITY_SESSION)).at(-1).info.error, undefined)
})

test("Claude TaskDesk launch uses the same ACP service that owns visible sessions", async () => {
  const calls = []
  const service = {
    async createSession(input) {
      calls.push(["create", input])
      return { id: "claude-task-session" }
    },
    async promptAndWait(sessionID, text) {
      calls.push(["prompt", sessionID, text])
    }
  }
  const daemon = {
    hostEntry: (id) => id === "claude" ? { kind: "acp", host: {} } : undefined,
    registry: { host: () => ({ state: "available" }) }
  }
  const launcher = new TaskLauncher({ daemon, acpService: () => service })
  const task = {
    id: "task-claude-1234",
    agentId: "claude",
    prompt: "Implement the Claude fix",
    model: { providerID: "claude", modelID: "sonnet" },
    workspace: { mode: "project", path: "/repo" }
  }

  const run = await launcher.createSession(task)
  let completed = false
  await launcher.startPrompt(task, run, { onCompleted: () => { completed = true } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(calls, [
    ["create", { directory: "/repo", title: "Task task-cla", model: "claude/sonnet" }],
    ["prompt", "claude-task-session", "Implement the Claude fix"]
  ])
  assert.equal(completed, true)
})

const ACTIVITY_SESSION = "01a02000-0000-7000-8000-000000000000"

function toolParts(messages) {
  return messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool")
    .map((part) => [part.state?.title ?? part.tool, part.state?.status])
}

test("activity a Claude turn left open stops reading as running", () => {
  const now = 1_800_000_000_000
  const messages = [{
    info: { id: "m1", role: "assistant", sessionID: ACTIVITY_SESSION, time: { created: now } },
    parts: [
      { type: "reasoning", text: "still thinking", time: { start: now - 6_000 } },
      { type: "tool", tool: "Bash", callID: "c1", state: { status: "running", time: { start: now - 5_000 } } },
      { type: "tool", tool: "Read", callID: "c2", state: { status: "pending", time: { start: now - 4_000 } } },
      { type: "tool", tool: "Edit", callID: "c3", state: { status: "completed", time: { start: now - 3_000, end: now - 2_000 } } },
      { type: "tool", tool: "Grep", callID: "c4", state: { status: "error", time: { start: now - 1_000 } } },
      { type: "reasoning", text: "thought it through", time: { start: now - 900, end: now - 800 } },
      { type: "text", text: "done" }
    ]
  }]

  assert.equal(settleUnfinishedActivity(messages, { now }), 3)
  assert.deepEqual(
    messages[0].parts.map((part) => part.state?.status ?? part.type),
    ["reasoning", "incomplete", "incomplete", "completed", "error", "reasoning", "text"]
  )
  // An outcome the harness never reported may not be invented, and the timing of the parts that did
  // report one may not be rewritten.
  assert.equal(messages[0].parts[0].time.end, now)
  assert.equal(messages[0].parts[1].state.time.end, now)
  assert.equal(messages[0].parts[3].state.time.end, now - 2_000)
  assert.equal(messages[0].parts[4].state.time.end, undefined)
  assert.equal(messages[0].parts[5].time.end, now - 800)
  assert.equal(settleUnfinishedActivity(messages, { now }), 0)
})

test("reopened history closes its thinking at its own start instead of claiming the outage", () => {
  const now = 1_800_000_000_000
  const messages = [{
    info: { id: "m1", role: "assistant", sessionID: ACTIVITY_SESSION, time: { created: now - 86_400_000 } },
    parts: [{ type: "reasoning", text: "thinking", time: { start: now - 86_400_000 } }]
  }]

  assert.equal(settleUnfinishedActivity(messages, { now, historical: true }), 1)
  assert.equal(messages[0].parts[0].time.end, now - 86_400_000)
})

/** Claude's adapter is observed to open tool calls it never closes; the transcript kept spinning. */
class ClaudeToolCallAcp extends EventEmitter {
  constructor({ closeSecondCall = false } = {}) {
    super()
    this.closeSecondCall = closeSecondCall
    this.cancelled = []
  }

  async listSessions() {
    return [{ sessionId: ACTIVITY_SESSION, cwd: process.cwd(), title: "Claude activity", updatedAt: new Date().toISOString() }]
  }

  #toolCall(id, title) {
    this.emit("notification", {
      method: "session/update",
      params: {
        sessionId: ACTIVITY_SESSION,
        update: { sessionUpdate: "tool_call", toolCallId: id, title, status: "in_progress", rawInput: { command: title } }
      }
    })
  }

  async request(method, params) {
    if (method === "session/load") return { configOptions: [] }
    if (method !== "session/prompt") throw new Error(`Unexpected request: ${method}`)
    this.emit("notification", {
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Run the suite first." } }
      }
    })
    this.#toolCall("call-1", "npm test")
    this.emit("notification", {
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: "415 passing" }
      }
    })
    this.#toolCall("call-2", "npm run build")
    if (this.closeSecondCall) {
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "completed" }
        }
      })
    }
    this.emit("notification", {
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }
      }
    })
    return { stopReason: "end_turn" }
  }

  notify(method, params) {
    if (method === "session/cancel") this.cancelled.push(params.sessionId)
  }
}

test("a finished Claude turn settles the activity its tool calls never closed", async () => {
  const service = new AcpService(new ClaudeToolCallAcp())
  await service.prompt(ACTIVITY_SESSION, "run the suite")
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(service.status(ACTIVITY_SESSION), { type: "idle" })
  assert.deepEqual(toolParts(await service.messages(ACTIVITY_SESSION)), [
    ["npm test", "completed"],
    ["npm run build", "incomplete"]
  ])
})

test("a Claude tool call still reads as running while its turn is live", async () => {
  const acp = new ClaudeToolCallAcp()
  let release = () => {}
  const held = new Promise((resolve) => { release = resolve })
  const request = acp.request.bind(acp)
  acp.request = async (method, params) => {
    const result = await request(method, params)
    if (method === "session/prompt") await held
    return result
  }

  const service = new AcpService(acp)
  await service.prompt(ACTIVITY_SESSION, "run the suite")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(service.status(ACTIVITY_SESSION), { type: "busy" })
  assert.deepEqual(toolParts(await service.messages(ACTIVITY_SESSION)), [
    ["npm test", "completed"],
    ["npm run build", "running"]
  ])

  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(toolParts(await service.messages(ACTIVITY_SESSION)), [
    ["npm test", "completed"],
    ["npm run build", "incomplete"]
  ])
})

test("stopping a Claude turn settles the tool call it interrupted", async () => {
  const acp = new ClaudeToolCallAcp()
  let release = () => {}
  const held = new Promise((resolve) => { release = resolve })
  const request = acp.request.bind(acp)
  acp.request = async (method, params) => {
    const result = await request(method, params)
    if (method === "session/prompt") await held
    return result
  }

  const service = new AcpService(acp)
  await service.prompt(ACTIVITY_SESSION, "run the suite")
  await new Promise((resolve) => setTimeout(resolve, 20))
  service.abort(ACTIVITY_SESSION)

  assert.deepEqual(acp.cancelled, [ACTIVITY_SESSION])
  assert.deepEqual(toolParts(await service.messages(ACTIVITY_SESSION)), [
    ["npm test", "completed"],
    ["npm run build", "incomplete"]
  ])
  release()
})

test("a Claude turn that does close its tool calls is left exactly as reported", async () => {
  const service = new AcpService(new ClaudeToolCallAcp({ closeSecondCall: true }))
  await service.prompt(ACTIVITY_SESSION, "run the suite")
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(toolParts(await service.messages(ACTIVITY_SESSION)), [
    ["npm test", "completed"],
    ["npm run build", "completed"]
  ])
})

test("replayed Claude history never reopens a tool call as running activity", async () => {
  class ReplayAcp extends EventEmitter {
    async listSessions() {
      return [{ sessionId: ACTIVITY_SESSION, cwd: process.cwd(), title: "Claude history", updatedAt: new Date().toISOString() }]
    }

    async request(method, params) {
      if (method !== "session/load") throw new Error(`Unexpected request: ${method}`)
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "run the suite" } }
        }
      })
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "old-call", title: "npm test", status: "in_progress", rawInput: {} }
        }
      })
      return { configOptions: [] }
    }

    notify() {}
  }

  const service = new AcpService(new ReplayAcp())
  assert.deepEqual(toolParts(await service.messages(ACTIVITY_SESSION)), [["npm test", "incomplete"]])
})

test("a snapshot written mid-turn reopens with settled activity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-claude-activity-"))
  const snapshot = {
    version: 1,
    messages: [{
      info: { id: "m1", role: "assistant", sessionID: ACTIVITY_SESSION, time: { created: Date.now() } },
      parts: [{
        id: "call-1",
        messageID: "m1",
        type: "tool",
        tool: "Bash",
        callID: "call-1",
        state: { status: "running", title: "npm test", input: {}, time: { start: Date.now() - 1_000 } }
      }]
    }],
    todos: [],
    title: "Claude activity"
  }
  await writeFile(
    path.join(directory, `${Buffer.from(ACTIVITY_SESSION).toString("base64url")}.json`),
    JSON.stringify(snapshot),
    "utf8"
  )

  class SnapshotAcp extends EventEmitter {
    async listSessions() {
      return [{ sessionId: ACTIVITY_SESSION, cwd: process.cwd(), title: "Claude activity", updatedAt: new Date().toISOString() }]
    }

    async request(method) {
      if (method === "session/load") return { configOptions: [] }
      throw new Error(`Unexpected request: ${method}`)
    }

    notify() {}
  }

  const service = new AcpService(new SnapshotAcp(), { snapshotDirectory: directory })
  assert.deepEqual(toolParts(await service.messages(ACTIVITY_SESSION)), [["npm test", "incomplete"]])
})

test("a Session reported idle by the status correction settles its stale activity too", async () => {
  const acp = new ClaudeToolCallAcp()
  let release = () => {}
  const held = new Promise((resolve) => { release = resolve })
  const request = acp.request.bind(acp)
  acp.request = async (method, params) => {
    const result = await request(method, params)
    if (method === "session/prompt") await held
    return result
  }

  const service = new AcpService(acp)
  await service.prompt(ACTIVITY_SESSION, "run the suite")
  await new Promise((resolve) => setTimeout(resolve, 20))
  // The turn is still flagged busy in the service, which is the stale state the public status
  // correction resolves; the transcript has to follow it rather than keep spinning.
  assert.deepEqual(service.status(ACTIVITY_SESSION), { type: "busy" })
  assert.equal(service.settleReportedIdleActivity(ACTIVITY_SESSION), 1)
  assert.deepEqual(toolParts(await service.messages(ACTIVITY_SESSION)), [
    ["npm test", "completed"],
    ["npm run build", "incomplete"]
  ])
  assert.equal(service.settleReportedIdleActivity(ACTIVITY_SESSION), 0)
  release()
})

test("thinking that a Claude tool call interrupts is closed by that tool call", async () => {
  const service = new AcpService(new ClaudeToolCallAcp({ closeSecondCall: true }))
  await service.prompt(ACTIVITY_SESSION, "run the suite")
  await new Promise((resolve) => setTimeout(resolve, 20))

  const reasoning = (await service.messages(ACTIVITY_SESSION))
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "reasoning")
  assert.equal(reasoning.length, 1)
  // Only the message-chunk path used to close reasoning, so thinking followed by a tool call — the
  // ordinary Claude shape — kept its Activity section on Working for the rest of the transcript.
  assert.ok(reasoning[0].time.start > 0)
  assert.ok(reasoning[0].time.end >= reasoning[0].time.start)
})
