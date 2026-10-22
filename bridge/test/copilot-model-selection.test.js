import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

const SESSION_ID = "copilot-auto-session"

class FakeCopilotAcp extends EventEmitter {
  calls = []
  constructor({ advertiseModelCommand = true, modelAlreadySelected = false } = {}) {
    super()
    this.advertiseModelCommand = advertiseModelCommand
    this.modelAlreadySelected = modelAlreadySelected
  }
  async start() {}
  close() {}
  notify() {}
  diagnostics() { return { processID: 777 } }
  async listSessions() {
    return [{ sessionId: SESSION_ID, cwd: "/repo", title: "Copilot session", updatedAt: "2026-10-13T10:00:00.000Z" }]
  }
  async request(method, params) {
    this.calls.push({ method, params })
    if (method === "session/new") {
      return {
        sessionId: SESSION_ID,
        configOptions: [{ id: "mode", currentValue: "interactive", options: [{ value: "interactive" }] }]
      }
    }
    if (method === "session/load") {
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: this.advertiseModelCommand ? [{ name: "model", description: "Select model" }] : []
          }
        }
      })
      return {
        configOptions: [{ id: "mode", currentValue: "interactive", options: [{ value: "interactive" }] }]
      }
    }
    if (method === "session/prompt") {
      const text = params.prompt?.[0]?.text ?? ""
      if (text.startsWith("/model ")) {
        if (this.modelAlreadySelected) {
          this.emit("notification", {
            method: "session/update",
            params: { sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: [{ id: "mode", currentValue: "interactive", options: [{ value: "interactive" }] }] } }
          })
          return { stopReason: "end_turn" }
        }
        this.emit("notification", {
          method: "session/update",
          params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Model changed to: Auto for this session" } } }
        })
      } else {
        this.emit("notification", {
          method: "session/update",
          params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Assistant reply" } } }
        })
      }
      return { stopReason: "end_turn" }
    }
    throw new Error(`Unexpected ACP method: ${method}`)
  }
}

class FakeCopilotCatalog {
  resolveCalls = []
  async list() { return { models: [{ providerID: "copilot", modelID: "auto", modelName: "Auto" }] } }
  async resolve(model) {
    this.resolveCalls.push(model)
    if (model.providerID !== "copilot" || model.modelID !== "auto") throw new Error("Selected model is no longer available")
    return { providerID: "copilot", modelID: "auto", modelName: "Auto" }
  }
}

function createService(acp, catalog, snapshotDirectory) {
  return new AcpService(acp, {
    snapshotDirectory,
    fallbackModelCatalog: catalog,
    modelProviderID: "copilot",
    fallbackModelSelectionMethod: "session/prompt",
    fallbackModelCommand: "model"
  })
}

function modelCommands(acp) {
  return acp.calls
    .filter(({ method, params }) => method === "session/prompt" && params.prompt?.[0]?.text?.startsWith("/model "))
    .map(({ params }) => params.prompt[0].text)
}

function transcriptText(messages) {
  return messages.flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

test("Copilot Auto selection uses the native command and keeps its acknowledgement out of the transcript", async () => {
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "copilot-model-select-"))
  let service
  try {
    const acp = new FakeCopilotAcp()
    service = createService(acp, new FakeCopilotCatalog(), snapshotDirectory)
    await service.createSession({ directory: "/repo" })
    await service.setModel(SESSION_ID, "copilot/auto")
    assert.deepEqual(modelCommands(acp), ["/model auto"])

    await service.promptAndWait(SESSION_ID, "Continue after choosing Auto")
    const text = transcriptText(await service.messages(SESSION_ID))
    assert.match(text, /Continue after choosing Auto/)
    assert.match(text, /Assistant reply/)
    assert.doesNotMatch(text, /Model changed to:/)
    assert.equal(acp.calls.filter(({ method }) => method === "session/prompt").length, 3)
  } finally {
    await service?.flushSnapshots()
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
})

test("unknown Copilot model is rejected before sending a native model command", async () => {
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "copilot-model-unknown-"))
  let service
  try {
    const acp = new FakeCopilotAcp()
    service = createService(acp, new FakeCopilotCatalog(), snapshotDirectory)
    await service.createSession({ directory: "/repo" })
    await assert.rejects(service.setModel(SESSION_ID, "copilot/not-real"), /no longer available/)
    assert.deepEqual(modelCommands(acp), [])
  } finally {
    await service?.flushSnapshots()
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
})

test("Copilot model selection refuses an unadvertised native command without sending it as a prompt", async () => {
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "copilot-model-command-"))
  let service
  try {
    const acp = new FakeCopilotAcp({ advertiseModelCommand: false })
    service = createService(acp, new FakeCopilotCatalog(), snapshotDirectory)
    await service.createSession({ directory: "/repo" })
    await assert.rejects(service.setModel(SESSION_ID, "copilot/auto"), /does not advertise its native model-selection command/)
    assert.deepEqual(modelCommands(acp), [])
    assert.equal(acp.calls.filter(({ method }) => method === "session/prompt").length, 0)
  } finally {
    await service?.flushSnapshots()
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
})

test("Copilot selection is restored from snapshots and reapplied before the next prompt", async () => {
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "copilot-model-restart-"))
  let firstService
  let restartedService
  try {
    const catalog = new FakeCopilotCatalog()
    const firstAcp = new FakeCopilotAcp()
    firstService = createService(firstAcp, catalog, snapshotDirectory)
    await firstService.createSession({ directory: "/repo" })
    await firstService.setModel(SESSION_ID, "copilot/auto")
    await firstService.flushSnapshots()

    const restartedAcp = new FakeCopilotAcp()
    restartedService = createService(restartedAcp, catalog, snapshotDirectory)
    const available = await restartedService.models(SESSION_ID)
    assert.equal(available.find((model) => model.modelID === "auto")?.currentValue, true)
    await restartedService.promptAndWait(SESSION_ID, "Continue after restart")
    assert.deepEqual(modelCommands(restartedAcp), ["/model auto"])
    assert.match(transcriptText(await restartedService.messages(SESSION_ID)), /Assistant reply/)
  } finally {
    await firstService?.flushSnapshots()
    await restartedService?.flushSnapshots()
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
})


test("Copilot already-selected Auto accepts its native configuration acknowledgement without a text reply", async () => {
  const acp = new FakeCopilotAcp({ modelAlreadySelected: true })
  const service = createService(acp, new FakeCopilotCatalog())
  await service.createSession({ directory: "/repo" })
  await service.setModel(SESSION_ID, "copilot/auto")
  await service.promptAndWait(SESSION_ID, "Continue with Auto")
  assert.deepEqual(modelCommands(acp), ["/model auto", "/model auto"])
  assert.match(transcriptText(await service.messages(SESSION_ID)), /Assistant reply/)
})

test("native Copilot replay preserves adjacent stopped and continuation user messages separately", async () => {
  const acp = new FakeCopilotAcp()
  const request = acp.request.bind(acp)
  acp.request = async (method, params) => {
    const result = await request(method, params)
    if (method === "session/load") {
      for (const text of ["Stopped prompt", "Continuation after stop"]) {
        acp.emit("notification", { method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } } })
      }
    }
    return result
  }
  const service = new AcpService(acp, { replayAuthoritative: true, replayUserChunksAreMessages: true })
  const messages = await service.messages(SESSION_ID)
  assert.deepEqual(messages.map((message) => message.parts.map((part) => part.text).join("")), ["Stopped prompt", "Continuation after stop"])
})

test("project-scoped reads use an already-created Session without scanning every project", async () => {
  const acp = new FakeCopilotAcp()
  acp.listSessions = async () => { throw new Error("Unexpected full project scan") }
  const service = new AcpService(acp, { refreshSessionListOnRead: false })
  await service.createSession({ directory: "/repo" })
  assert.deepEqual(await service.messages(SESSION_ID), [])
  await service.promptAndWait(SESSION_ID, "Continue in the known project")
  assert.match(transcriptText(await service.messages(SESSION_ID)), /Assistant reply/)
})
