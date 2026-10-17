import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { createPiHistoryLoader } from "../src/pi-session-history.js"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "harness-pi-history-"))
  const project = path.join(root, "project")
  await mkdir(project, { recursive: true })
  const sessionID = "01pi-session"
  const file = path.join(project, `2026-08-18T00-00-00-000Z_${sessionID}.jsonl`)
  const records = [
    { type: "session", version: 3, id: sessionID, timestamp: "2026-08-18T10:00:00.000Z", cwd: project },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-08-18T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "First prompt" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-18T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Complete PI answer" }] } },
    { type: "session_info", id: "n1", parentId: "a1", timestamp: "2026-08-18T10:00:03.000Z", name: "PI native title" }
  ]
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  return { root, project, sessionID, file }
}

function visible(messages) {
  return messages.map((message) => ({ role: message.info.role, text: message.parts.map((part) => part.text ?? "").join("") }))
}

test("PI journal loader reads the authoritative current branch without opening ACP", async () => {
  const { root, sessionID } = await fixture()
  const loader = createPiHistoryLoader(root)
  assert.deepEqual(visible(await loader(sessionID)), [
    { role: "user", text: "First prompt" },
    { role: "assistant", text: "Complete PI answer" }
  ])
})

test("PI journal loader follows the current leaf instead of replaying abandoned branches", async () => {
  const { root, sessionID, file } = await fixture()
  const records = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
  records.splice(3, 0, {
    type: "message",
    id: "abandoned",
    parentId: "u1",
    timestamp: "2026-08-18T10:00:02.500Z",
    message: { role: "assistant", content: [{ type: "text", text: "Abandoned branch" }] }
  })
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  const loader = createPiHistoryLoader(root)
  assert.deepEqual(visible(await loader(sessionID)), [
    { role: "user", text: "First prompt" },
    { role: "assistant", text: "Complete PI answer" }
  ])
})

test("PI journal pager follows only the active branch across cursor pages", async () => {
  const { root, sessionID, file, project } = await fixture()
  const records = [
    { type: "session", version: 3, id: sessionID, parentId: null, timestamp: "2026-08-18T10:00:00.000Z", cwd: project },
    { type: "message", id: "u0", parentId: sessionID, timestamp: "2026-08-18T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "u0" }] } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "2026-08-18T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "a0" }] } },
    { type: "message", id: "abandoned-a", parentId: "u0", timestamp: "2026-08-18T10:00:02.500Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } },
    { type: "message", id: "u1", parentId: "a0", timestamp: "2026-08-18T10:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "u1" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-18T10:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } },
    { type: "session_info", id: "n1", parentId: "a1", timestamp: "2026-08-18T10:00:05.000Z", name: "PI native title" },
    { type: "message", id: "u2", parentId: "n1", timestamp: "2026-08-18T10:00:06.000Z", message: { role: "user", content: [{ type: "text", text: "u2" }] } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-08-18T10:00:07.000Z", message: { role: "assistant", content: [{ type: "text", text: "a2" }] } },
    { type: "session_info", id: "n2", parentId: "a2", timestamp: "2026-08-18T10:00:08.000Z", name: "PI final title" }
  ]
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n")

  const loader = createPiHistoryLoader(root)
  const full = visible(await loader(sessionID))
  assert.deepEqual(full.map((entry) => entry.text), ["u0", "a0", "u1", "a1", "u2", "a2"])

  const first = await loader.page(sessionID, { limit: 2 })
  assert.deepEqual(visible(first.messages).map((entry) => entry.text), ["u2", "a2"])
  assert.equal(first.hasMore, true)
  assert.ok(first.before)

  const second = await loader.page(sessionID, { limit: 2, before: first.before })
  assert.deepEqual(visible(second.messages).map((entry) => entry.text), ["u1", "a1"])
  assert.equal(second.hasMore, true)
  assert.ok(second.before)

  const third = await loader.page(sessionID, { limit: 2, before: second.before })
  assert.deepEqual(visible(third.messages).map((entry) => entry.text), ["u0", "a0"])
  assert.equal(third.hasMore, false)
  assert.equal(third.before, null)

  const ids = [...third.messages, ...second.messages, ...first.messages].map((message) => message.info.id)
  assert.equal(new Set(ids).size, 6, "cursor pages must not duplicate a PI message")
})

test("PI journal pager rejects invalid cursors instead of silently changing branches", async () => {
  const { root, sessionID } = await fixture()
  const loader = createPiHistoryLoader(root)
  await assert.rejects(() => loader.page(sessionID, { before: "not-a-valid-cursor", limit: 2 }), /Invalid PI history cursor/)
  const impossible = Buffer.from(JSON.stringify({ offset: 0, target: "missing-parent" }), "utf8").toString("base64url")
  await assert.rejects(() => loader.page(sessionID, { before: impossible, limit: 2 }), /Invalid PI history cursor/)
})

// Regression: a provider failure can leave ACP replay incomplete even though PI's journal is complete.
test("PI journal stays authoritative after an ACP load when a provider error was retried", async () => {
  const { root, sessionID, file } = await fixture()
  const records = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
  records.splice(2, 2,
    {
      type: "message",
      id: "a-error",
      parentId: "u1",
      timestamp: "2026-08-18T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Partial reasoning before provider failure" }],
        stopReason: "error",
        errorMessage: "Streaming response failed: [502] Upstream error from NVidia: Internal server error"
      }
    },
    {
      type: "message",
      id: "a-retry",
      parentId: "a-error",
      timestamp: "2026-08-18T10:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }], stopReason: "stop" }
    },
    {
      type: "message",
      id: "u2",
      parentId: "a-retry",
      timestamp: "2026-08-18T10:00:04.000Z",
      message: { role: "user", content: [{ type: "text", text: "Follow-up" }] }
    },
    {
      type: "message",
      id: "a2",
      parentId: "u2",
      timestamp: "2026-08-18T10:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Follow-up answer" }], stopReason: "stop" }
    },
    { type: "session_info", id: "n2", parentId: "a2", timestamp: "2026-08-18T10:00:06.000Z", name: "PI native title" }
  )
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n")

  const loader = createPiHistoryLoader(root)
  class PartialReplayPiAcp extends StrictPiAcp {
    async request(method, params) {
      if (method === "session/load") {
        if (this.open) throw new Error("Invalid params: session already open")
        this.open = true
        this.loads += 1
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: "user_message_chunk", messageId: "replayed-user", content: { type: "text", text: "First prompt" } }
          }
        })
        return { configOptions: [{ id: "model", currentValue: "pi-model", options: [{ value: "pi-model", name: "PI model" }] }] }
      }
      return super.request(method, params)
    }
  }
  const session = { root, sessionID, file, project: path.dirname(file) }
  const acp = new PartialReplayPiAcp(loader, session)
  const service = new AcpService(acp, { historyLoader: loader, reloadOnHistoryRefresh: false, preferListedTitles: true })

  const expected = [
    { role: "user", text: "First prompt" },
    { role: "assistant", text: "Partial reasoning before provider failure" },
    { role: "assistant", text: "Recovered answer" },
    { role: "user", text: "Follow-up" },
    { role: "assistant", text: "Follow-up answer" }
  ]
  assert.deepEqual(visible(await service.messages(sessionID, true)), expected)
  await service.models(sessionID)
  assert.equal(acp.loads, 1)
  assert.deepEqual(visible(await service.messages(sessionID, true)), expected,
    "opening PI via ACP for models must not replace the journal with a partial replay")
})

test("PI history treats only native aborted assistant messages as cancellations", async () => {
  const { root, sessionID, file, project } = await fixture()
  const records = [
    { type: "session", version: 3, id: sessionID, parentId: null, timestamp: "2026-08-18T10:00:00.000Z", cwd: project },
    { type: "message", id: "u1", parentId: sessionID, timestamp: "2026-08-18T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "First prompt" }] } },
    { type: "message", id: "cancel-empty", parentId: "u1", timestamp: "2026-08-18T10:00:02.000Z", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted" } },
    { type: "message", id: "cancel-partial", parentId: "cancel-empty", timestamp: "2026-08-18T10:00:03.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Partial reasoning" }, { type: "text", text: "Partial answer" }], stopReason: "aborted", errorMessage: "Request aborted" } },
    { type: "message", id: "u2", parentId: "cancel-partial", timestamp: "2026-08-18T10:00:04.000Z", message: { role: "user", content: [{ type: "text", text: "Follow-up" }] } },
    { type: "message", id: "failure", parentId: "u2", timestamp: "2026-08-18T10:00:05.000Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request aborted" } },
    { type: "thinking_level_change", id: "level", parentId: "failure", timestamp: "2026-08-18T10:00:06.000Z", thinkingLevel: "high" },
    { type: "message", id: "a3", parentId: "level", timestamp: "2026-08-18T10:00:07.000Z", message: { role: "assistant", provider: "openrouter", model: "qwen/qwen3.8-27b:free", content: [{ type: "text", text: "Follow-up answer" }], stopReason: "stop" } }
  ]
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n")

  const loader = createPiHistoryLoader(root)
  const full = await loader(sessionID)
  assert.deepEqual(full.map((message) => message.info.id), ["u1", "cancel-empty", "cancel-partial", "u2", "failure", "a3"])
  assert.deepEqual(visible(full), [
    { role: "user", text: "First prompt" },
    { role: "assistant", text: "" },
    { role: "assistant", text: "Partial reasoningPartial answer" },
    { role: "user", text: "Follow-up" },
    { role: "assistant", text: "" },
    { role: "assistant", text: "Follow-up answer" }
  ])
  assert.deepEqual(full.map((message) => message.info.interrupted === true), [false, true, true, false, false, false],
    "a Stop is kept as a neutral interruption, even when it produced no output yet")
  assert.equal(full[2].info.error, undefined, "aborted partial output remains history without a failed-turn marker")
  assert.deepEqual(full[4].info.error, { name: "HarnessTurnError", message: "Request aborted" },
    "an error stop remains a failure even when its provider text says request aborted")

  const pageGroups = []
  let page = await loader.page(sessionID, { limit: 2 })
  assert.deepEqual(page.model, { providerID: "openrouter", modelID: "qwen/qwen3.8-27b:free", variant: "high" })
  while (true) {
    pageGroups.push(page.messages)
    if (!page.before) break
    page = await loader.page(sessionID, { limit: 2, before: page.before })
  }
  const pages = pageGroups.reverse().flat()
  assert.deepEqual(pages.map((message) => message.info.id), full.map((message) => message.info.id),
    "paged history must retain the same branch while traversing the skipped empty cancellation")
  assert.equal(pages.find((message) => message.info.id === "cancel-partial").info.error, undefined)
  assert.deepEqual(pages.find((message) => message.info.id === "failure").info.error, full[4].info.error)
})

test("PI journal rename appends the same session_info record PI list/resume uses", async () => {
  const { root, sessionID, file } = await fixture()
  const loader = createPiHistoryLoader(root)
  await loader.renameSession(sessionID, "Renamed from Harness Remote")
  const records = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
  const renamed = records.at(-1)
  assert.equal(renamed.type, "session_info")
  assert.equal(renamed.name, "Renamed from Harness Remote")
  assert.equal(renamed.parentId, "n1")
})

test("PI live paging never unions a partial ACP answer with an already flushed journal answer", async () => {
  const sessionID = "pi-live-progress"
  const envelope = (id, role, text) => ({
    info: { id, role, sessionID, time: { created: Date.now() } },
    parts: [{ id: `${id}:text`, messageID: id, type: "text", text }]
  })
  let persisted = []
  const history = async () => persisted
  history.authoritativeHistory = true
  let finishTurn
  class StreamingPi extends EventEmitter {
    async start() {}
    async listSessions() { return [{ sessionId: sessionID, cwd: "/sandbox" }] }
    async request(method) {
      if (method === "session/load") return {}
      if (method === "session/prompt") return new Promise((resolve) => { finishTurn = resolve })
      throw new Error(`Unexpected method ${method}`)
    }
    chunk(text) {
      this.emit("notification", { method: "session/update", params: { sessionId: sessionID,
        update: { sessionUpdate: "agent_message_chunk", messageId: "acp-live", content: { type: "text", text } } } })
    }
  }
  const acp = new StreamingPi()
  const service = new AcpService(acp, { historyLoader: history })
  await service.prompt(sessionID, "Test the response")
  acp.chunk("PI-FREE")
  persisted = [
    envelope("journal-user", "user", "Test the response"),
    envelope("journal-assistant", "assistant", "PI-FREE-ROUTER-UI-VERIFIED")
  ]
  const streamed = await service.messagePage(sessionID)
  assert.deepEqual(visible(streamed.messages), [
    { role: "user", text: "Test the response" },
    { role: "assistant", text: "PI-FREE" }
  ])
  acp.chunk("-ROUTER-UI-VERIFIED")
  const completed = await service.messagePage(sessionID)
  assert.deepEqual(visible(completed.messages), [
    { role: "user", text: "Test the response" },
    { role: "assistant", text: "PI-FREE-ROUTER-UI-VERIFIED" }
  ])
  assert.equal(completed.messages[1].info.id, "acp-live")
  finishTurn({ stopReason: "end_turn" })
  await new Promise((resolve) => setImmediate(resolve))
  const journal = await service.messagePage(sessionID)
  assert.deepEqual(visible(journal.messages), visible(persisted))
  assert.equal(journal.messages[1].info.id, "journal-assistant")
})

class StrictPiAcp extends EventEmitter {
  constructor(loader, session) {
    super()
    this.loader = loader
    this.session = session
    this.open = false
    this.loads = 0
    this.closes = 0
    this.prompts = 0
    this.promptCapabilities = {}
  }
  async listSessions() {
    const records = (await readFile(this.session.file, "utf8")).trim().split("\n").map(JSON.parse)
    const title = [...records].reverse().find((record) => record.type === "session_info")?.name
    return [{ sessionId: this.session.sessionID, cwd: this.session.project, title, updatedAt: new Date().toISOString() }]
  }
  async request(method, params) {
    if (method === "session/load") {
      if (this.open) throw new Error("Invalid params: session already open")
      this.open = true
      this.loads += 1
      return { configOptions: [{ id: "model", currentValue: "pi-model", options: [{ value: "pi-model", name: "PI model" }] }] }
    }
    if (method === "session/close") {
      this.open = false
      this.closes += 1
      return {}
    }
    if (method === "session/prompt") {
      if (!this.open) throw new Error("Invalid params: unknown session")
      this.prompts += 1
      return { stopReason: "end_turn" }
    }
    throw new Error(`Unexpected request: ${method}`)
  }
  notify() {}
}

test("PI open, model load, refresh, rename and prompt never double-open the ACP session", async () => {
  const session = await fixture()
  const loader = createPiHistoryLoader(session.root)
  const acp = new StrictPiAcp(loader, session)
  const service = new AcpService(acp, {
    historyLoader: loader,
    reloadOnHistoryRefresh: false,
    preferListedTitles: true
  })

  assert.equal((await service.messages(session.sessionID, true)).length, 2)
  assert.equal(acp.loads, 0, "reading PI history must not open the ACP session")

  assert.equal((await service.models(session.sessionID)).length, 1)
  assert.equal(acp.loads, 1, "model discovery may open PI once")
  assert.equal((await service.messages(session.sessionID, true)).length, 2)
  assert.equal(acp.loads, 1, "history refresh must not session/load an already open PI session")

  const renamed = await service.renameSession(session.sessionID, "Renamed from app")
  assert.equal(renamed.title, "Renamed from app")
  assert.equal(acp.closes, 1, "rename closes a live PI session before touching its journal")
  assert.equal(acp.open, false)

  await service.prompt(session.sessionID, "Next prompt")
  assert.equal(acp.loads, 2, "the next prompt reopens PI exactly once")
  assert.equal(acp.prompts, 1)
})
