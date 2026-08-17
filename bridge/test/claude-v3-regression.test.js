import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { HARNESS_PROFILES, resolveAcpLaunch } from "../src/harness-profiles.js"
import { detectBackends, resolveLaunchPlan } from "../src/launcher.js"
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
    access: () => {}
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
