import assert from "node:assert/strict"
import test from "node:test"
import { discoverAgentNativeSessionPage } from "./native-session-discovery.ts"
import { taskDeskLiveEvent } from "./taskdesk-live-events.ts"
import {
  LIVE_SESSION_STATUS_GRACE_MS,
  clearSessionIndexLiveError,
  clearSessionIndexLiveState,
  clearSessionIndexLiveStatuses,
  liveSessionIndexError,
  liveSessionIndexStatus,
  noteSessionIndexLiveEvent,
  noteSessionIndexStreamConnected,
  sessionIndexInvalidationRevision,
  sessionIndexLifecycleEvent,
  subscribeSessionIndexInvalidation
} from "./session-index-live-state.ts"

const base = {
  backend: "opencode",
  host: "127.0.0.1",
  port: 4097,
  username: "harness",
  password: "secret",
  agentId: "opencode"
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

function session(status) {
  return {
    id: "ses_a",
    title: "A",
    directory: "/tmp/project",
    time: { created: 1, updated: 2 },
    ...(status ? { status: { type: status } } : {})
  }
}

test("OpenCode lifecycle edges invalidate the Session index while token chunks do not", () => {
  let notifications = 0
  let observedStatus
  const unsubscribe = subscribeSessionIndexInvalidation(() => {
    notifications += 1
    observedStatus = liveSessionIndexStatus(base, "ses_a")
  })
  const before = sessionIndexInvalidationRevision()

  noteSessionIndexLiveEvent(base, { type: "message.part.delta", sessionID: "ses_a" })
  assert.equal(sessionIndexInvalidationRevision(), before)
  assert.equal(notifications, 0, "streamed token chunks must not fan out into Session discovery")
  assert.equal(sessionIndexLifecycleEvent("message.part.delta"), false)

  noteSessionIndexLiveEvent(base, { type: "session.status", sessionID: "ses_a", status: "busy" })
  assert.equal(sessionIndexInvalidationRevision(), before + 1)
  assert.equal(notifications, 1, "a lifecycle edge must invalidate the Session rail directly")
  assert.deepEqual(observedStatus, { type: "busy" }, "the invalidation subscriber must observe the already-updated live status")
  assert.equal(sessionIndexLifecycleEvent("session.status"), true)
  unsubscribe()
})

test("an ACP turn end invalidates the Session index while its per-chunk message.updated does not", () => {
  const omp = { ...base, backend: "omp", agentId: "omp" }
  let notifications = 0
  const unsubscribe = subscribeSessionIndexInvalidation(() => { notifications += 1 })

  // The bridge's own envelope, as AcpService emits it while streaming and when the turn settles.
  for (let index = 0; index < 50; index += 1) {
    noteSessionIndexLiveEvent(omp, taskDeskLiveEvent("message.updated", { type: "message.updated", sessionId: "omp_a" }))
  }
  assert.equal(notifications, 0, "ACP streams message.updated per chunk; it must not re-read every Session index")

  noteSessionIndexLiveEvent(omp, taskDeskLiveEvent("session.updated", { type: "session.updated", sessionId: "omp_a" }))
  assert.equal(notifications, 1, "the session.updated that ends an ACP turn must reach the rail")

  noteSessionIndexLiveEvent(base, { type: "message.updated", sessionID: "ses_a" })
  assert.equal(notifications, 2, "OpenCode's terminal message.updated keeps its second chance")
  unsubscribe()
})

test("OpenCode session.status normalization preserves the streamed status type", () => {
  const event = taskDeskLiveEvent(undefined, {
    type: "session.status",
    properties: { sessionID: "ses_a", status: { type: "idle" } }
  })
  assert.deepEqual(event, { type: "session.status", sessionID: "ses_a", status: "idle" })
})

test("OpenCode retry normalization preserves provider reason, attempt and next retry", () => {
  const event = taskDeskLiveEvent(undefined, {
    type: "session.status",
    properties: {
      sessionID: "ses_retry",
      status: {
        type: "retry",
        attempt: 2,
        message: "No available channel",
        next: 1_700_000_000_000
      }
    }
  })
  assert.deepEqual(event, {
    type: "session.status",
    sessionID: "ses_retry",
    status: "retry",
    statusMessage: "No available channel",
    statusAttempt: 2,
    statusNext: 1_700_000_000_000
  })

  noteSessionIndexLiveEvent(base, event, 1_000)
  assert.deepEqual(liveSessionIndexStatus(base, "ses_retry", 1_001), {
    type: "retry",
    attempt: 2,
    message: "No available channel",
    next: 1_700_000_000_000
  })
})

test("OpenCode session.error survives navigation until a real retry resumes", () => {
  const failure = taskDeskLiveEvent(undefined, {
    type: "session.error",
    properties: {
      sessionID: "ses_error",
      error: {
        name: "ApiError",
        data: { message: "No available channel" }
      }
    }
  })
  assert.deepEqual(failure, {
    type: "session.error",
    sessionID: "ses_error",
    errorMessage: "No available channel"
  })

  noteSessionIndexLiveEvent(base, failure, 2_000)
  assert.equal(liveSessionIndexError(base, "ses_error", 2_001), "No available channel")
  assert.deepEqual(liveSessionIndexStatus(base, "ses_error", 2_001), {
    type: "error",
    message: "No available channel"
  })

  const retry = taskDeskLiveEvent(undefined, {
    type: "session.status",
    properties: {
      sessionID: "ses_error",
      status: { type: "retry", attempt: 3, message: "Retrying provider route", next: 2_500 }
    }
  })
  noteSessionIndexLiveEvent(base, retry, 2_100)
  assert.equal(liveSessionIndexError(base, "ses_error", 2_101), undefined)
  assert.deepEqual(liveSessionIndexStatus(base, "ses_error", 2_101), {
    type: "retry",
    attempt: 3,
    message: "Retrying provider route",
    next: 2_500
  })
})

test("a newer OpenCode session.error supersedes an older retry until work really resumes", () => {
  const sessionID = "ses_order"
  noteSessionIndexLiveEvent(base, { type: "session.status", sessionID, status: "retry", statusMessage: "old retry" }, 3_000)
  noteSessionIndexLiveEvent(base, { type: "session.error", sessionID, errorMessage: "new terminal failure" }, 3_100)
  assert.equal(liveSessionIndexError(base, sessionID, 3_101), "new terminal failure")
  assert.deepEqual(liveSessionIndexStatus(base, sessionID, 3_101), { type: "error", message: "new terminal failure" })

  noteSessionIndexLiveEvent(base, { type: "session.status", sessionID, status: "busy" }, 3_200)
  assert.equal(liveSessionIndexError(base, sessionID, 3_201), undefined)
  assert.deepEqual(liveSessionIndexStatus(base, sessionID, 3_201), { type: "busy" })
})

test("OpenCode nested provider error messages beat generic error names", () => {
  const event = taskDeskLiveEvent(undefined, {
    type: "session.error",
    properties: {
      sessionID: "ses_nested",
      error: {
        name: "UnknownError",
        data: { error: { message: "Provider routing exhausted" } }
      }
    }
  })
  assert.equal(event?.errorMessage, "Provider routing exhausted")
})

test("OpenCode live provider errors do not change ACP backend semantics", () => {
  const codex = { ...base, backend: "codex" }
  const sessionID = "codex_error"
  noteSessionIndexLiveEvent(codex, { type: "session.error", sessionID, errorMessage: "ACP owns this failure" })
  assert.equal(liveSessionIndexError(codex, sessionID), undefined)
  assert.equal(liveSessionIndexStatus(codex, sessionID), undefined, "ACP session.error must stay with the established adapter/transcript path")
})

test("OpenCode live lifecycle is isolated by routed agent identity", () => {
  const sessionID = "shared_session_id"
  const first = { ...base, agentId: "opencode-primary" }
  const second = { ...base, agentId: "opencode-secondary" }

  noteSessionIndexLiveEvent(first, { type: "session.error", sessionID, errorMessage: "primary route failed" }, 4_000)
  assert.equal(liveSessionIndexError(first, sessionID, 4_001), "primary route failed")
  assert.equal(liveSessionIndexError(second, sessionID, 4_001), undefined, "a sibling routed agent must not inherit the primary agent error")
  assert.equal(liveSessionIndexStatus(second, sessionID, 4_001), undefined)

  noteSessionIndexLiveEvent(second, { type: "session.status", sessionID, status: "busy" }, 4_100)
  assert.deepEqual(liveSessionIndexStatus(second, sessionID, 4_101), { type: "busy" })
  assert.deepEqual(liveSessionIndexStatus(first, sessionID, 4_101), { type: "error", message: "primary route failed" }, "secondary activity must not retract the primary agent error")

  clearSessionIndexLiveState(first, sessionID)
  assert.equal(liveSessionIndexStatus(first, sessionID, 4_102), undefined)
  assert.deepEqual(liveSessionIndexStatus(second, sessionID, 4_102), { type: "busy" }, "clearing one routed agent must not clear another")
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

test("stream remount drops transient status but preserves a terminal error until recovery", () => {
  noteSessionIndexLiveEvent(base, { type: "session.status", sessionID: "ses_a", status: "idle" })
  noteSessionIndexLiveEvent(base, { type: "session.error", sessionID: "ses_a", errorMessage: "temporary failure" })
  const before = sessionIndexInvalidationRevision()
  assert.equal(liveSessionIndexStatus(base, "ses_a")?.type, "error")
  assert.equal(liveSessionIndexError(base, "ses_a"), "temporary failure")

  noteSessionIndexStreamConnected(base)
  assert.deepEqual(liveSessionIndexStatus(base, "ses_a"), { type: "error", message: "temporary failure" })
  assert.equal(liveSessionIndexError(base, "ses_a"), "temporary failure")
  assert.equal(sessionIndexInvalidationRevision(), before + 1)

  noteSessionIndexLiveEvent(base, { type: "session.status", sessionID: "ses_a", status: "busy" })
  assert.equal(liveSessionIndexError(base, "ses_a"), undefined, "real resumed work must retract the old terminal-looking error")
  assert.deepEqual(liveSessionIndexStatus(base, "ses_a"), { type: "busy" })
})

test("durable controller transitions can retire stale event authority explicitly", () => {
  const sessionID = "ses_durable"
  noteSessionIndexLiveEvent(base, { type: "session.error", sessionID, errorMessage: "old provider failure" })
  assert.equal(liveSessionIndexError(base, sessionID), "old provider failure")

  const beforeErrorClear = sessionIndexInvalidationRevision()
  clearSessionIndexLiveError(base, sessionID)
  assert.equal(liveSessionIndexError(base, sessionID), undefined)
  assert.equal(sessionIndexInvalidationRevision(), beforeErrorClear + 1, "starting a new durable turn must invalidate the stale error overlay")

  noteSessionIndexLiveEvent(base, { type: "session.status", sessionID, status: "retry", statusMessage: "routing" })
  noteSessionIndexLiveEvent(base, { type: "session.error", sessionID, errorMessage: "transient current-turn error" })
  noteSessionIndexLiveEvent(base, { type: "session.status", sessionID, status: "idle" })
  assert.equal(liveSessionIndexError(base, sessionID), "transient current-turn error")
  assert.equal(liveSessionIndexStatus(base, sessionID)?.type, "error")

  const beforeSettlement = sessionIndexInvalidationRevision()
  clearSessionIndexLiveState(base, sessionID)
  assert.equal(liveSessionIndexError(base, sessionID), undefined)
  assert.equal(liveSessionIndexStatus(base, sessionID), undefined)
  assert.equal(sessionIndexInvalidationRevision(), beforeSettlement + 1, "durable terminal reconciliation must retire both status and error bridges")
})

test("a foregrounded surface drops every transient status without retiring a terminal error", () => {
  const foreground = { ...base, agentId: "foreground" }
  noteSessionIndexLiveEvent(foreground, { type: "session.status", sessionID: "ses_resume_busy", status: "busy" })
  noteSessionIndexLiveEvent(foreground, { type: "session.error", sessionID: "ses_resume_error", errorMessage: "terminal failure" })
  assert.deepEqual(liveSessionIndexStatus(foreground, "ses_resume_busy"), { type: "busy" })

  const before = sessionIndexInvalidationRevision()
  clearSessionIndexLiveStatuses()
  assert.equal(
    liveSessionIndexStatus(foreground, "ses_resume_busy"),
    undefined,
    "resume must drop the stale busy bridge so the fresh Session index speaks for native truth"
  )
  assert.equal(
    liveSessionIndexError(foreground, "ses_resume_error"),
    "terminal failure",
    "a terminal error must survive a resume until durable transcript truth catches up"
  )
  assert.equal(sessionIndexInvalidationRevision(), before + 1, "dropping resume statuses must invalidate the rail once")
})
