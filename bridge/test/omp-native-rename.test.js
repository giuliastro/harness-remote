import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { harnessProfile } from "../src/harness-profiles.js"

class RenameOmpAcp extends EventEmitter {
  agentInfo = { version: "18.0.6" }
  title = "Session 019faa51"
  prompts = []

  async start() {}

  async listSessions() {
    return [{
      sessionId: "019faa51-rename-test",
      title: this.title,
      cwd: process.cwd(),
      updatedAt: "2026-08-26T18:00:00.000Z"
    }]
  }

  async request(method, params) {
    if (method === "session/load") return { configOptions: [] }
    if (method === "session/prompt") {
      const text = params.prompt?.find((part) => part.type === "text")?.text || ""
      this.prompts.push(text)
      if (text.startsWith("/rename ")) this.title = text.slice("/rename ".length)
      return { stopReason: "end_turn" }
    }
    return {}
  }

  notify() {}
}

test("OMP profile persists rename through OMP's native /rename ACP command", async () => {
  const profile = harnessProfile("omp")
  assert.equal(profile.nativeRenameCommand, "rename")
  assert.equal(profile.preferListedTitles, true)

  const acp = new RenameOmpAcp()
  const service = new AcpService(acp, {
    historyLoader: async () => [],
    nativeRenameCommand: profile.nativeRenameCommand,
    preferListedTitles: profile.preferListedTitles
  })

  const renamed = await service.renameSession("019faa51-rename-test", "Risolvi altra issue e crea PR")
  assert.equal(renamed.title, "Risolvi altra issue e crea PR")
  assert.deepEqual(acp.prompts, ["/rename Risolvi altra issue e crea PR"])

  const listed = await service.listSessions()
  assert.equal(listed[0].title, "Risolvi altra issue e crea PR")
})
