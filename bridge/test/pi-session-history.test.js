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
