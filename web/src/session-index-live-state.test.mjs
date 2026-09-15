import assert from "node:assert/strict"
import test from "node:test"
import { discoverAgentNativeSessionPage } from "./native-session-discovery.ts"
import { reuseList } from "./workspace-runtime-merge.ts"
import { taskDeskLiveEvent } from "./taskdesk-live-events.ts"
import {
  LIVE_SESSION_STATUS_GRACE_MS,
  liveSessionIndexStatus,
  noteSessionIndexLiveEvent,
  noteSessionIndexStreamConnected,
  sessionIndexLiveRevision,
  withSessionIndexLiveRevision
} from "./session-index-live-state.ts"

const base = {
  backend: "opencode",
  host: "127.0.0.1",
  port: 4097,
  username: "harness",
  password: "secret"
}

const agent = {
  id: "opencode",
  label: "OpenCode",
  backend: "opencode",
  transport: "http",
  state: "available",
  capabilities: {
    sessions: true,
    abort: true,
    models: true,
    sessionRename: true,
    sessionDelete: true
  }
}

const machineSnapshot = {
  machine: { id: "machine-1", name: "Machine" },
  agents: [agent]
}

function session(status) {
  return {
    id: "ses_a",
    title: "A",
    directory: "/tmp/project",
    time: { created: 1, updated: 2 },
    ...(status ? { status: { type: status } } : {})
  }
}

test("OpenCode lifecycle edges invalidate an otherwise-identical machine snapshot, token chunks do not", () => {
  noteSessionIndexStreamConnected(base)
  const previous = [{ machine: { id: "saved" }, snapshot: withSessionIndexLiveRevision(base, machineSnapshot) }]

  const before = sessionIndexLiveRevision(base)
  noteSessionIndexLiveEvent(base, { type: "message.part.delta", sessionID: "ses_a" })
  assert.equal(sessionIndexLiveRevision(base), before)
  const tokenOnly = [{ machine: { id: "saved" }, snapshot: withSessionIndexLiveRevision(base, machineSnapshot) }]
  assert.equal(reuseList(previous, tokenOnly), previous, "streamed token chunks must not fan out into Session discovery")

  noteSessionIndexLiveEvent(base, { type: "session.status", sessionID: "ses_a", status: "busy" })
  const lifecycle = [{ machine: { id: "saved" }, snapshot: withSessionIndexLiveRevision(base, machineSnapshot) }]
  assert.equal(reuseList(previous, lifecycle), lifecycle, "a lifecycle edge must invalidate the Session rail even when /v1/machine is unchanged")
})

test("OpenCode session.status normalization preserves the streamed status type", () => {
  const event = taskDeskLiveEvent(undefined, {
    type: "session.status",
    properties: { sessionID: "ses_a", status: { type: "idle" } }
  })
  assert.deepEqual(event, { type: "session.status", sessionID: "ses_a", status: "idle" })
})

test("a fresh streamed idle edge beats a briefly stale busy status read", async () => {
  const now = Date.now()
  noteSessionIndexLiveEvent(base, { type: "session.status", sessionID: "ses_a", status: "idle" }, now)
  assert.deepEqual(liveSessionIndexStatus(base, "ses_a", now), { type: "idle" })

  const page = await discoverAgentNativeSessionPage(base, agent, undefined, {
    async listGlobalSessionPage() {
      return { sessions: [session()] }
    },
    async listSessions() {
      throw new Error("paged discovery should succeed")
    },
    async listStatuses() {
      return { ses_a: { type: "busy" } }
    }
  })
  assert.equal(page.records[0].status?.type, "idle")

  assert.equal(
    liveSessionIndexStatus(base, "ses_a", now + LIVE_SESSION_STATUS_GRACE_MS + 1),
    undefined,
    "stream authority must be bounded so a missed future event cannot pin the row forever"
  )
})

test("stream reconnect drops transient status authority and forces a new Session-index epoch", () => {
  noteSessionIndexLiveEvent(base, { type: "session.status", sessionID: "ses_a", status: "idle" })
  const before = sessionIndexLiveRevision(base)
  assert.equal(liveSessionIndexStatus(base, "ses_a")?.type, "idle")

  noteSessionIndexStreamConnected(base)
  assert.equal(liveSessionIndexStatus(base, "ses_a"), undefined)
  assert.equal(sessionIndexLiveRevision(base), before + 1)
})
