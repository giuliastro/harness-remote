import assert from "node:assert/strict"
import {
  EMPTY_NATIVE_SESSION_ATTENTION_NOTIFICATION_STATE,
  reconcileNativeSessionAttentionNotifications
} from "./native-session-attention-notifications.ts"

const permission = (id = "perm-1", sessionID = "session-1") => ({
  id,
  sessionID,
  permission: "write",
  patterns: ["src/**"],
  metadata: { reason: "Apply the requested code change" },
  always: []
})

const question = (id = "question-1", sessionID = "session-1") => ({
  id,
  sessionID,
  questions: [{
    header: "Choose target",
    question: "Which environment should be used?",
    options: [],
    custom: true
  }]
})

const item = ({ sessionID = "session-1", kind, reason, permissions = [], questions = [] }) => ({
  sessionID,
  attention: {
    kind,
    reason,
    requiresUserAction: kind === "authorization" || kind === "recoverable",
    failClosed: kind === "authorization" || kind === "rejected"
  },
  permissions,
  questions
})

const observation = (items, { complete = true, machineID = "machine-1", agentID = "opencode" } = {}) => ({
  machineID,
  machineName: "Dev workstation",
  agentID,
  agentLabel: "OpenCode",
  index: {
    agentID,
    queried: { questions: true, permissions: true },
    complete,
    errors: complete ? {} : { permissions: "temporary network error" },
    items
  }
})

const authorization = (permissionID = "perm-1") => item({
  kind: "authorization",
  reason: "permission",
  permissions: [permission(permissionID)]
})

// Existing pending work is a baseline on first observation, not a reload/reconnect notification.
let result = reconcileNativeSessionAttentionNotifications(
  EMPTY_NATIVE_SESSION_ATTENTION_NOTIFICATION_STATE,
  [observation([authorization()])]
)
assert.equal(result.notifications.length, 0)
let state = result.state

// A stable pending request must never spam on repeated snapshots.
result = reconcileNativeSessionAttentionNotifications(state, [observation([authorization()])])
assert.equal(result.notifications.length, 0)
state = result.state

// A genuinely new request in the same Session remains meaningful even at the same severity.
result = reconcileNativeSessionAttentionNotifications(state, [observation([authorization("perm-2")])])
assert.equal(result.notifications.length, 1)
assert.deepEqual(result.notifications[0], {
  transition: "changed",
  machineID: "machine-1",
  machineName: "Dev workstation",
  agentID: "opencode",
  agentLabel: "OpenCode",
  sessionID: "session-1",
  kind: "authorization",
  reason: "permission",
  requestIDs: ["permission:perm-2"],
  requestedAction: "write",
  explanation: "Apply the requested code change",
  boundary: "src/**",
  consequence: "The Session remains blocked until you allow or deny this request."
})
state = result.state

// A partial read must not clear the dedup baseline and create a false re-entry on recovery.
result = reconcileNativeSessionAttentionNotifications(state, [observation([], { complete: false })])
assert.equal(result.notifications.length, 0)
state = result.state
result = reconcileNativeSessionAttentionNotifications(state, [observation([authorization("perm-2")])])
assert.equal(result.notifications.length, 0)
state = result.state

// Only a complete snapshot resolves a tracked item. Re-entry after a real resolution is new.
result = reconcileNativeSessionAttentionNotifications(state, [observation([])])
assert.equal(result.notifications.length, 0)
state = result.state
result = reconcileNativeSessionAttentionNotifications(state, [observation([authorization("perm-2")])])
assert.equal(result.notifications.length, 1)
assert.equal(result.notifications[0].transition, "entered")
state = result.state

// Missing aggregate scopes do not reset dedup state during a disconnected-machine refresh.
result = reconcileNativeSessionAttentionNotifications(state, [])
assert.equal(result.notifications.length, 0)
state = result.state
result = reconcileNativeSessionAttentionNotifications(state, [observation([authorization("perm-2")])])
assert.equal(result.notifications.length, 0)

// A new question is recoverable/input attention and remains semantically distinct from authorization.
result = reconcileNativeSessionAttentionNotifications(result.state, [
  observation([
    authorization("perm-2"),
    item({
      sessionID: "session-2",
      kind: "recoverable",
      reason: "question",
      questions: [question("question-2", "session-2")]
    })
  ])
])
assert.equal(result.notifications.length, 1)
assert.equal(result.notifications[0].kind, "recoverable")
assert.equal(result.notifications[0].requestedAction, "Which environment should be used?")
assert.equal(result.notifications[0].consequence, "The Session remains blocked until you answer this question.")
state = result.state

// Escalating the same Session from a question to permission must notify as a changed boundary.
result = reconcileNativeSessionAttentionNotifications(state, [
  observation([
    authorization("perm-2"),
    item({
      sessionID: "session-2",
      kind: "authorization",
      reason: "permission",
      permissions: [permission("perm-3", "session-2")]
    })
  ])
])
assert.equal(result.notifications.length, 1)
assert.equal(result.notifications[0].transition, "changed")
assert.equal(result.notifications[0].kind, "authorization")
state = result.state

// Rejected/fail-closed remains distinct from a retryable failure.
result = reconcileNativeSessionAttentionNotifications(state, [
  observation([
    authorization("perm-2"),
    item({
      sessionID: "session-2",
      kind: "rejected",
      reason: "rejected"
    })
  ])
])
assert.equal(result.notifications.length, 1)
assert.equal(result.notifications[0].kind, "rejected")
assert.equal(result.notifications[0].consequence, "This request was rejected and will not proceed automatically.")

console.log("native Session attention notification transition tests passed")
