import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { desktopAttentionNotification } from "./native-session-attention-notification-presentation.ts"

function event(overrides = {}) {
  return {
    transition: "entered",
    machineID: "machine-1",
    machineName: "Workstation",
    agentID: "codex",
    agentLabel: "Codex",
    sessionID: "session-123",
    kind: "authorization",
    reason: "permission",
    requestIDs: ["permission:p1"],
    requestedAction: "write_file",
    explanation: "The agent needs to update the requested file.",
    boundary: "/workspace/project/**",
    consequence: "The Session remains blocked until you allow or deny this request.",
    ...overrides
  }
}

test("authorization desktop notification explains action, reason, boundary and no-response consequence", () => {
  const notification = desktopAttentionNotification(event())
  assert.equal(notification.title, "Authorization required")
  assert.match(notification.body, /write_file/)
  assert.match(notification.body, /needs to update/)
  assert.match(notification.body, /Boundary: \/workspace\/project\/\*\*/)
  assert.match(notification.body, /remains blocked until you allow or deny/)
  assert.match(notification.body, /Workstation · Codex/)
  assert.deepEqual(notification.target, {
    machineID: "machine-1",
    agentID: "codex",
    sessionID: "session-123"
  })
})

test("desktop notification includes bounded task identity when native metadata is available", () => {
  const notification = desktopAttentionNotification(event(), {
    sessionTitle: "Fix issue #371",
    projectLabel: "Harness Remote"
  })
  assert.match(notification.body, /Session: Fix issue #371/)
  assert.match(notification.body, /Project: Harness Remote/)
  assert.match(notification.overlayDescription, /Fix issue #371/)
  assert.match(notification.overlayDescription, /Harness Remote/)
  assert.match(notification.body, /Workstation · Codex/)
})

test("task identity enrichment remains optional and preserves the proven fallback", () => {
  const notification = desktopAttentionNotification(event())
  assert.doesNotMatch(notification.body, /Session:/)
  assert.doesNotMatch(notification.body, /Project:/)
  assert.match(notification.body, /Workstation · Codex/)
})

test("rejected and question attention keep distinct notification semantics", () => {
  const rejected = desktopAttentionNotification(event({
    kind: "rejected",
    reason: "rejected",
    requestedAction: undefined,
    explanation: undefined,
    boundary: undefined,
    consequence: "This request was rejected and will not proceed automatically."
  }))
  assert.equal(rejected.title, "Request rejected")
  assert.match(rejected.body, /will not proceed automatically/)

  const question = desktopAttentionNotification(event({
    kind: "recoverable",
    reason: "question",
    requestedAction: "Which deployment target should I use?",
    explanation: undefined,
    boundary: undefined,
    consequence: "The Session remains blocked until you answer this question."
  }))
  assert.equal(question.title, "Input required")
  assert.match(question.body, /Which deployment target/)
  assert.match(question.body, /remains blocked until you answer/)
})

test("Attention Inbox enriches only emitted notifications with bounded native metadata and deep-links by identity", () => {
  const source = readFileSync(new URL("./components/native-session-home-attention.tsx", import.meta.url), "utf8")
  assert.match(source, /reconcileNativeSessionAttentionNotifications\(notificationStateRef\.current, \[\{/)
  assert.match(source, /index: result/)
  assert.match(source, /for \(const notification of notificationResult\.notifications\)[\s\S]*void notifyAttention\(notification, latest\)/)
  assert.match(source, /NOTIFICATION_CONTEXT_MAX_PAGES = 4/)
  assert.match(source, /pageNumber < NOTIFICATION_CONTEXT_MAX_PAGES/)
  assert.match(source, /record\.session\.project\?\.name\?\.trim\(\)/)
  assert.match(source, /desktopAttentionNotification\(notification, context\)/)
  assert.match(source, /const existingContext = notificationContextRef\.current\.get\(target\.key\)/)
  assert.match(source, /\.\.\.existingContext,[\s\S]*sessionTitle: target\.title/, "remembering a Session must not discard an already resolved Project label")
  assert.match(source, /subscribeDesktopAttentionActivation/)
  assert.match(source, /candidate\.machineID === activation\.machineID && candidate\.agent\.id === activation\.agentID/)
  assert.match(source, /openAttentionSession\(target, activation\.sessionID\)/)
  assert.doesNotMatch(source, /loadMessagePage|loadMessages|loadTranscript/)
})
