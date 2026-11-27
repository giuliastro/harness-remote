import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { modeIsUnrestricted, sessionModeState } from "../src/acp-session-modes.js"

// The shapes below are what claude-agent-acp 0.84.0 and codex-acp 1.13.1 answered to session/new.
const CLAUDE_MODES = [
  { value: "default", name: "Manual", description: "Always ask before making changes" },
  { value: "acceptEdits", name: "Accept edits", description: "Automatically accept all file edits" },
  { value: "plan", name: "Plan", description: "Create a plan before making changes" },
  { value: "auto", name: "Auto", description: "Claude handles permission decisions" },
  { value: "bypassPermissions", name: "Bypass permissions", description: "Accepts all permissions" }
]

class ModeAcp extends EventEmitter {
  calls = []
  promptCapabilities = {}
  constructor({ configMode = true, legacyMode = true } = {}) {
    super()
    this.configMode = configMode
    this.legacyMode = legacyMode
    this.current = "default"
  }
  async start() {}
  close() {}
  diagnostics() { return {} }
  async listSessions() { return [{ sessionId: "s1", cwd: "/repo", title: "S1", updatedAt: new Date().toISOString() }] }
  #state() {
    return {
      ...(this.configMode ? { configOptions: [
        { id: "mode", category: "mode", currentValue: this.current, options: CLAUDE_MODES },
        { id: "model", category: "model", currentValue: "opus", options: [{ value: "opus" }] }
      ] } : {}),
      ...(this.legacyMode ? { modes: { currentModeId: this.current, availableModes: CLAUDE_MODES.map(({ value, ...mode }) => ({ id: value, ...mode })) } } : {})
    }
  }
  async request(method, params) {
    this.calls.push([method, params])
    if (method === "session/new") return { sessionId: "s1", ...this.#state() }
    if (method === "session/load") {
      // A harness reopens a Session in its own default mode.
      this.current = "default"
      return this.#state()
    }
    if (method === "session/set_config_option") {
      this.current = params.value
      return { configOptions: this.#state().configOptions }
    }
    if (method === "session/set_mode") {
      this.current = params.modeId
      return {}
    }
    return {}
  }
  switches() {
    return this.calls.filter(([method]) => method === "session/set_config_option" || method === "session/set_mode")
      .map(([method, params]) => `${method}:${params.value ?? params.modeId}`)
  }
}

test("modes come from the harness's mode config option with its own names", () => {
  const state = sessionModeState([{ id: "mode", category: "mode", currentValue: "default", options: CLAUDE_MODES }])
  assert.equal(state.configId, "mode")
  assert.equal(state.currentModeId, "default")
  assert.deepEqual(state.modes.map((mode) => mode.name), ["Manual", "Accept edits", "Plan", "Auto", "Bypass permissions"])
  assert.deepEqual(state.modes.filter((mode) => mode.unrestricted).map((mode) => mode.id), ["bypassPermissions"])
})

test("a model or reasoning option is never read as a mode, and no modes means none", () => {
  assert.equal(sessionModeState([{ id: "model", category: "model", options: [{ value: "a" }] }]), undefined)
  assert.equal(sessionModeState(undefined, undefined), undefined)
})

test("grouped select values and the legacy modes field are both understood", () => {
  const grouped = sessionModeState([{ id: "mode", category: "mode", currentValue: "plan", options: [{ group: "g", name: "G", options: [{ value: "build" }, { value: "plan" }] }] }])
  assert.deepEqual(grouped.modes.map((mode) => mode.id), ["build", "plan"])
  const legacy = sessionModeState([], { currentModeId: "agent", availableModes: [{ id: "agent-full-access", name: "Full access", _meta: { kind: "full_access" } }, { id: "agent", name: "Approve for me" }] })
  assert.equal(legacy.configId, undefined)
  assert.equal(legacy.currentModeId, "agent")
  assert.equal(legacy.modes[0].unrestricted, true)
  assert.equal(modeIsUnrestricted({ id: "read-only" }), false)
})

test("reading modes never opens a Session, opening the picker does", async () => {
  const acp = new ModeAcp()
  const service = new AcpService(acp)
  assert.deepEqual(await service.modes("s1"), { loaded: false, modes: [] })
  assert.equal(acp.calls.some(([method]) => method === "session/load"), false)
  const opened = await service.modes("s1", { load: true })
  assert.equal(opened.loaded, true)
  assert.equal(opened.currentModeId, "default")
  assert.equal(opened.modes.length, 5)
})

test("switching uses set_config_option, refuses unknown modes, and skips a no-op", async () => {
  const acp = new ModeAcp()
  const service = new AcpService(acp)
  const changed = await service.setMode("s1", "acceptEdits")
  assert.equal(changed.currentModeId, "acceptEdits")
  await service.setMode("s1", "acceptEdits")
  await assert.rejects(service.setMode("s1", "yolo"), /not available: yolo/)
  assert.deepEqual(acp.switches(), ["session/set_config_option:acceptEdits"])
})

test("an adapter with only the legacy modes field is switched with session/set_mode", async () => {
  const acp = new ModeAcp({ configMode: false })
  const service = new AcpService(acp)
  assert.equal((await service.setMode("s1", "plan")).currentModeId, "plan")
  assert.deepEqual(acp.switches(), ["session/set_mode:plan"])
})

test("a mode the harness switches to by itself is reported", async () => {
  const acp = new ModeAcp()
  const service = new AcpService(acp)
  await service.setMode("s1", "plan")
  acp.emit("notification", { method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "current_mode_update", currentModeId: "default" } } })
  assert.equal((await service.modes("s1")).currentModeId, "default")
})

test("the chosen mode is put back after the harness reopens the Session in its default", async () => {
  const acp = new ModeAcp()
  const service = new AcpService(acp)
  await service.setMode("s1", "acceptEdits")
  const loads = () => acp.calls.filter(([method]) => method === "session/load").length
  const before = loads()
  // A refreshed read reopens the Session with session/load, as after an idle unload, and the fake
  // harness reports its own default there.
  await service.messagePage("s1", { refresh: true })
  assert.ok(loads() > before, "the Session must actually have been reopened")
  assert.equal(acp.current, "acceptEdits")
  assert.equal((await service.modes("s1")).currentModeId, "acceptEdits")
})
