import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { harnessProfile } from "../src/harness-profiles.js"

const id = "codex-session"
const envelope = (role, text) => ({ info: { id: `${id}:byte:${role}`, role, sessionID: id }, parts: [{ type: "text", text }] })

class Acp extends EventEmitter {
  async start() {}
  async listSessions() { return [{ sessionId: id, cwd: "/sandbox" }] }
  async request(method) {
    if (method === "session/new") return { sessionId: id, configOptions: [{ id: "model", currentValue: "gpt-6-luna" }] }
    if (method === "session/prompt") {
      this.emit("notification", { method: "session/update", params: { sessionId: id, update: { sessionUpdate: "agent_message_chunk", messageId: "native-live-id", content: { type: "text", text: "CODEX-OK" } } } })
      return { stopReason: "end_turn" }
    }
    throw new Error(`Unexpected method ${method}`)
  }
}

test("Codex owned paging keeps an ACP reply visible while journal durability lags", async () => {
  const profile = harnessProfile("codex")
  let journalReads = 0
  const journal = async () => []
  journal.page = async () => { journalReads += 1; return { messages: [envelope("user", "Test prompt")], hasMore: false, before: null } }
  const service = new AcpService(new Acp(), { historyLoader: journal, journalPageWhileOwned: profile.journalPageWhileOwned, modelProviderID: "codex" })
  await service.createSession({ directory: "/sandbox" })
  await service.promptAndWait(id, "Test prompt")
  const page = await service.messagePage(id)
  assert.deepEqual(page.messages.map((m) => m.parts.map((p) => p.text).join("")), ["Test prompt", "CODEX-OK"])
  assert.equal(journalReads, 0)
  assert.deepEqual(page.model, { providerID: "codex", modelID: "gpt-6-luna" })

  journal.page = async () => { journalReads += 1; return { messages: [envelope("user", "Test prompt"), envelope("assistant", "CODEX-OK")], hasMore: false, before: null } }
  const reopened = new AcpService(new Acp(), { historyLoader: journal, journalPageWhileOwned: profile.journalPageWhileOwned })
  const nativePage = await reopened.messagePage(id)
  assert.equal(journalReads, 1)
  assert.equal(nativePage.messages[1].info.id, `${id}:byte:assistant`)
})
