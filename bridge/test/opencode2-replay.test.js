import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { harnessProfile } from "../src/harness-profiles.js"

class NativeReplay extends EventEmitter {
  text = "1 2 3"
  sessionCapabilities = { resume: {} }
  async start() {}
  async listSessions() { return [{ sessionId: "s1", cwd: "/repo", title: "Stop test" }] }
  async request(method) {
    if (method !== "session/load") throw new Error(`unexpected method ${method}`)
    for (const [role, text] of [["user", "Count"], ["agent", this.text], ["user", "Continue"], ["agent", "OK"]]) {
      this.emit("notification", {
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: `${role}_message_chunk`, content: { type: "text", text } } }
      })
    }
    return { configOptions: [{ id: "model", currentValue: "opencode/longcat-2.5-preview-free" }] }
  }
}

function texts(page) {
  return page.messages.map((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""))
}

test("OpenCode 2 native replay replaces a shorter cached stopped reply and preserves later turns", async () => {
  const profile = harnessProfile("opencode2")
  const acp = new NativeReplay()
  const service = new AcpService(acp, { replayAuthoritative: profile.replayAuthoritative })
  const initial = await service.messagePage("s1")
  assert.deepEqual(texts(initial), ["Count", "1 2 3", "Continue", "OK"])
  acp.text = "1 2 3 4 5"
  const reopened = await service.messagePage("s1", { refresh: true })
  assert.deepEqual(texts(reopened), ["Count", "1 2 3 4 5", "Continue", "OK"])
  for (const index of [0, 2, 3]) {
    assert.equal(reopened.messages[index].info.id, initial.messages[index].info.id)
    assert.deepEqual(reopened.messages[index].info.time, initial.messages[index].info.time)
  }
  assert.deepEqual(reopened.model, { providerID: "opencode", modelID: "longcat-2.5-preview-free" })
  assert.deepEqual(texts(await service.messagePage("s1", { refresh: true })), texts(reopened))
})
