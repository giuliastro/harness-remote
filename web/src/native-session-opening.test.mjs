import assert from "node:assert/strict"
import { api } from "./api.ts"
import { nativeSessionSurfaceTarget } from "./native-session-discovery.ts"
import { registerNativeSessionV3Adapter } from "./native-session-v3-adapter.ts"

const config = { host: "127.0.0.1", port: 4097, username: "test", password: "", backend: "opencode" }
const record = {
  key: "opencode:opening", agentId: "opencode", agentLabel: "OpenCode", backend: "opencode",
  transport: "http", abortSupported: true, modelsSupported: true, renameSupported: true,
  deleteSupported: true, session: { id: "opening", title: "Busy Session", directory: "/repo" },
  status: { type: "idle" }
}

// The rail observed a new running turn after the last discovery snapshot. Opening its row must
// retain that activity throughout a slow first-page read, without waiting for content to appear.
const active = nativeSessionSurfaceTarget("machine", config, record, "working")
const updates = []
const registration = registerNativeSessionV3Adapter(active, (conversation) => updates.push(conversation.status))
const originalLoadPage = api.loadMessagePage
let releasePage
api.loadMessagePage = () => new Promise((resolve) => { releasePage = resolve })
try {
  assert.equal(registration.conversation.status, "running", "a working row must mount a working controller")
  const read = registration.controller.loadMessagePage(active.config, active.sessionID, active.directory)
  assert.equal((await registration.controller.refreshConversation(active.config, registration.conversation.id)).status,
    "running", "pending transcript loading must not turn the Session ready")
  releasePage({
    messages: [{
      info: { id: "opening-user", role: "user", sessionID: "opening", time: { created: 1 } },
      parts: [{ id: "opening-text", type: "text", text: "Still working" }]
    }],
    hasMore: false
  })
  await read
  assert.ok(updates.length > 0)
  assert.ok(updates.every((status) => status === "running"), "content hydration must not emit a false completion")
} finally {
  api.loadMessagePage = originalLoadPage
  registration.dispose()
}

assert.equal(record.status.type, "idle", "opening must not mutate the shared discovery record")
assert.equal(nativeSessionSurfaceTarget("machine", config, record).status.type, "idle",
  "an ordinary idle Session must stay idle")
assert.equal(nativeSessionSurfaceTarget("machine", config, {
  ...record, status: { type: "busy" }
}, "ready").status.type, "idle", "live completion must also retire a stale busy discovery snapshot")
const retry = { type: "retry", attempt: 2, message: "Provider retry", next: 1234 }
assert.deepEqual(nativeSessionSurfaceTarget("machine", config, {
  ...record, status: retry
}, "working").status, retry, "opening must preserve retry details when discovery already agrees")
console.log("native Session opening tests passed")
