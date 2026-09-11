import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { appendCursorPage, refreshCursorPage, sessionTreeRows } from "./components/native-session-home.tsx"
import { canCreateNativeSession } from "./native-session-create.ts"
import { classifyNativeSessionAttention, sessionNeedsAttention } from "./native-session-attention.ts"

function item(id, parentID) {
  return {
    machine: { id: "machine-1", name: "Machine" },
    record: {
      key: id,
      agentId: "opencode",
      agentLabel: "OpenCode",
      backend: "opencode",
      transport: "http",
      abortSupported: true,
      modelsSupported: true,
      session: {
        id,
        parentID,
        title: id,
        directory: "/repo",
        time: { created: 1, updated: 1 }
      }
    }
  }
}

const rows = sessionTreeRows([
  item("child-2", "root"),
  item("root"),
  item("orphan", "missing"),
  item("child-1", "root"),
  item("cycle-a", "cycle-b"),
  item("cycle-b", "cycle-a"),
  item("self", "self")
])

assert.deepEqual(rows.map(({ item: row, depth }) => [row.record.session.id, depth]), [
  ["root", 0],
  ["child-2", 1],
  ["child-1", 1],
  ["orphan", 0],
  ["self", 0],
  ["cycle-a", 0],
  ["cycle-b", 1]
])
assert.equal(new Set(rows.map(({ item: row }) => row.record.session.id)).size, 7, "cycles or missing parents must never hide or duplicate a native Session")

const byID = (record) => record.id
let cursorPage = refreshCursorPage(undefined, [
  { id: "recent-1", title: "Recent one" },
  { id: "recent-2", title: "Recent two" }
], "page-2", byID)
assert.deepEqual(cursorPage, {
  records: [
    { id: "recent-1", title: "Recent one" },
    { id: "recent-2", title: "Recent two" }
  ],
  firstPageCursor: "page-2",
  nextCursor: "page-2",
  loadedOlder: false
})

cursorPage = appendCursorPage(cursorPage, [
  { id: "older-1", title: "Older" },
  { id: "recent-2", title: "Updated at the page boundary" }
], "page-3", byID)
assert.equal(cursorPage.loadedOlder, true)
assert.equal(cursorPage.nextCursor, "page-3")
assert.equal(cursorPage.records.find((record) => record.id === "recent-2").title, "Updated at the page boundary")

cursorPage = refreshCursorPage(cursorPage, [
  { id: "newest", title: "Newest" },
  { id: "recent-1", title: "Fresh status/title" }
], "new-page-2", byID)
assert.deepEqual(new Set(cursorPage.records.map(byID)), new Set(["newest", "recent-1", "recent-2", "older-1"]))
assert.equal(cursorPage.records.find((record) => record.id === "recent-1").title, "Fresh status/title")
assert.equal(cursorPage.firstPageCursor, "new-page-2", "a failed old tail can restart from the latest first-page cursor")
assert.equal(cursorPage.nextCursor, "page-3", "a recurring refresh must not silently jump an in-progress older-page chain")

const replacementPage = refreshCursorPage({
  records: [{ id: "stale", title: "Stale" }],
  firstPageCursor: "old",
  nextCursor: "old",
  loadedOlder: false
}, [{ id: "current", title: "Current" }], undefined, byID)
assert.deepEqual(replacementPage.records.map(byID), ["current"], "before manual pagination, page one remains an exact refresh")

for (const [backend, transport] of [
  ["opencode", "http"],
  ["omp", "acp"],
  ["pi", "acp"],
  ["claude", "acp"],
  ["codex", "acp"]
]) {
  assert.equal(canCreateNativeSession({
    id: backend,
    label: backend,
    backend,
    transport,
    managed: true,
    state: "available",
    capabilities: { sessions: true, prompt: true }
  }), true, `${backend} must be available in New Session when its native transport is writable`)
}

assert.equal(canCreateNativeSession({
  id: "claude",
  label: "Claude",
  backend: "claude",
  transport: "acp",
  managed: true,
  state: "unavailable",
  capabilities: { sessions: true, prompt: true }
}), false, "an unavailable harness must not be offered for native create")

const permission = {
  id: "permission-1",
  sessionID: "session-1",
  permission: "edit",
  patterns: ["src/**"],
  metadata: {},
  always: []
}
const question = {
  id: "question-1",
  sessionID: "session-1",
  questions: [{ question: "Which option?", header: "Choice", options: [] }]
}

assert.deepEqual(classifyNativeSessionAttention({ status: { type: "working" }, permissions: [permission], questions: [question] }), {
  kind: "authorization",
  requiresUserAction: true,
  failClosed: true,
  reason: "permission"
}, "an explicit harness permission must outrank generic working/question state")
assert.deepEqual(classifyNativeSessionAttention({ questions: [question] }), {
  kind: "recoverable",
  requiresUserAction: true,
  failClosed: true,
  reason: "question"
}, "a harness question needs input but must not be flattened into authorization")
for (const type of ["rejected", "permission-denied", "forbidden", "fail_closed"]) {
  const state = classifyNativeSessionAttention({ status: { type } })
  assert.equal(state.kind, "rejected", `${type} must remain fail-closed rather than looking retryable`)
  assert.equal(state.failClosed, true)
  assert.equal(state.requiresUserAction, false)
}
for (const type of ["error", "failed", "needs-attention", "blocked", "disconnected", "offline"]) {
  assert.equal(classifyNativeSessionAttention({ status: { type } }).kind, "recoverable", `${type} must surface as recoverable attention`)
  assert.equal(sessionNeedsAttention({ status: { type } }), true)
}
for (const type of ["completed", "done", "finished", "succeeded"]) {
  assert.equal(classifyNativeSessionAttention({ status: { type } }).kind, "informational", `${type} is informational rather than a request for action`)
  assert.equal(sessionNeedsAttention({ status: { type } }), false)
}
for (const type of ["working", "waiting", "retry", "busy", "running", "in_progress", "ready", "something-new"]) {
  assert.equal(classifyNativeSessionAttention({ status: { type } }).kind, "none", `${type} must not be promoted into attention without evidence`)
}

const source = readFileSync(new URL("./components/native-session-home-base.tsx", import.meta.url), "utf8")
assert.match(source, /presentationOverrides/, "live detail status must survive selecting another Session")
assert.match(source, /\{ \.\.\.current, \[selectedKey\]: selectedState \}/, "the status bridge must be keyed by native Session identity")
assert.match(source, /setPresentationOverrides\(\{\}\)[\s\S]*setRecords\(uniqueSessionRecords/, "a successful native discovery must retire temporary presentation overrides")
assert.match(source, /presentationOverrides\[targetKey\]/, "non-selected rows must retain their last observed live state until discovery reconciles them")
assert.match(source, /createMachineID/, "native Session creation must have an explicit machine selection independent of the list filter")
assert.match(source, /createMachines\.map/, "the create panel must render the available machine choices")
assert.match(source, /selectedActivityAnchor/, "the currently open Session must keep a stable activity ordering anchor")
assert.match(source, /activityTimestamp\(item, anchor\)/, "Project and Machine ordering must use the same selected-Session activity anchor")
assert.match(source, /setExpandedProjects/, "a selected Session below the compact preview must be made visible")
assert.match(source, /scrollIntoView\(\{ block: "nearest"/, "the selected Session must be kept in the visible list viewport")
assert.match(source, /recentlyCompletedKey/, "Working to Ready must leave a brief completion affordance")
assert.match(source, /snapshot && state === "online" && !error/, "a reconnect-grace machine must not remain writable just because its last snapshot is cached")
assert.match(source, /disabled=\{!loaded \|\| createMachines\.length === 0\}/, "New Session must stay disabled until Session and Project bootstrap has settled")
assert.match(source, /if \(!loaded \|\| createMachines\.length === 0\) return/, "the create handler must enforce the same bootstrap gate as the button")
assert.doesNotMatch(source, /t\("sf\.findingSessions"\)/, "the central workspace status, not the rail, must own the startup explanation")
assert.doesNotMatch(source, /t\("sf\.loadingSessions"\)/, "machine cards must not repeat the central Session-loading status")
assert.doesNotMatch(source, /!loaded \? <LoadingIcon size=\{15\} \/>/, "New Session keeps its stable label while bootstrap disables it")
assert.doesNotMatch(source, /\{!loaded && loading \? <div className="hr-native-home-empty">/, "the rail must not render a second loading panel")
assert.match(source, /const discoveryReady = sources\.every\(\(\{ state \}\) => state !== "loading"\)/, "Session discovery must not settle while machine probes are still in flight")
assert.match(source, /if \(!discoveryReady\) \{[\s\S]*setLoading\(true\)[\s\S]*return/, "the rail must remain explicitly loading until machine discovery can produce real Session results")
assert.match(source, /discoverAgentNativeSessionPage\(machine\.config, agent\)/, "recurring discovery must fetch exactly the first native Session page")
assert.match(source, /machine\.config\.username,[\s\S]*machine\.config\.password/, "a corrected machine credential must invalidate the Session index")
assert.match(source, /onRefreshCompleteRef\.current\?\.\(refreshToken\)/, "a requested Session refresh must settle only after its index read completes")
assert.doesNotMatch(source, /discoverMachineNativeSessions/, "the recurring rail must not eagerly flatten every Session page")
assert.match(source, /entry\.nextCursor[\s\S]*loadOlderSessions/, "older native Session pages must require an explicit user action")
assert.match(source, /refreshCursorPage\(existing, firstRecords, page\.nextCursor/, "a recurring first-page refresh must preserve the manual pagination tail")
assert.match(source, /agent\.processID/, "adapter restarts must invalidate connection-bound ACP cursors")

const inboxSource = readFileSync(new URL("./components/native-session-home-attention.tsx", import.meta.url), "utf8")
assert.match(inboxSource, /loadNativeSessionAttentionIndex/, "the global Inbox must use the capability-driven pending-request index")
assert.match(inboxSource, /startNativeSessionAttentionLiveRefresh/, "the global Inbox must use its dedicated attention event path")
assert.match(inboxSource, /!result\.complete && previous[\s\S]*items: previous\.index\.items/, "a partial refresh must fail closed and preserve known pending attention")
assert.match(inboxSource, /async function openInboxEntry[\s\S]*discoverAgentNativeSessionPage/, "native history lookup must happen only when a user opens an Inbox item")
assert.match(inboxSource, /Authorization required/, "global permissions must remain visibly distinct from generic attention")
assert.doesNotMatch(inboxSource, /startTaskDeskSessionLiveRefresh|loadMessagePage|continueConversation|stopConversation/, "global attention must stay outside transcript and Session writer paths")

const attentionSource = readFileSync(new URL("./components/work-thread-attention.tsx", import.meta.url), "utf8")
assert.match(attentionSource, /classifyNativeSessionAttention/, "the detail surface must use the shared attention state model")
assert.match(attentionSource, /Authorization required/, "permissions must be visibly distinct from generic input")
assert.match(attentionSource, /blocked until you allow or deny/, "authorization UI must explain that the agent remains blocked")
assert.match(attentionSource, /If you do nothing, this request remains blocked/, "authorization UI must state the consequence of no response")

console.log("native Session Home tree, create parity, attention semantics and stable-selection UX tests passed")
