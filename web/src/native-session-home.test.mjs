import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { appendCursorPage, needsOpenCodeRailStream, refreshCursorPage, sessionTreeRows } from "./components/native-session-home.tsx"
import { nativeSessionAgentChoices, reconcileStableSessionRecords } from "./components/native-session-home-base.tsx"
import { mergedAttentionSessionCount } from "./components/native-session-home-attention.tsx"
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

const providerSnapshot = {
  machine: { id: "daemon-1", name: "Machine" },
  agents: [
    ["opencode", "OpenCode"], ["opencode2", "OpenCode 2"], ["copilot", "GitHub Copilot CLI"],
    ["mimo", "MiMo Code"], ["codex", "Codex CLI"], ["claude", "Claude Code"], ["omp", "Oh My Pi"], ["pi", "PI"]
  ].map(([id, label]) => ({
    id, label, backend: id, transport: id === "opencode" ? "http" : "acp",
    managed: true, state: "available", capabilities: { sessions: true, prompt: true }
  }))
}
const providerSource = [{ machine: { id: "saved-1", name: "Machine", config: {} }, snapshot: providerSnapshot, state: "online" }]
const zeroSessionChoices = nativeSessionAgentChoices(providerSource, "", [])
assert.deepEqual(
  Object.fromEntries(zeroSessionChoices.map((choice) => [choice.id, choice.label])),
  Object.fromEntries(providerSnapshot.agents.map((agent) => [agent.id, agent.label])),
  "the harness filter must preserve machine-advertised provider ids and labels even before the first Session"
)
const countedChoices = nativeSessionAgentChoices(providerSource, "", [
  { machine: providerSource[0].machine, machineID: "daemon-1", record: { agentId: "opencode", agentLabel: "OpenCode" } },
  { machine: providerSource[0].machine, machineID: "daemon-1", record: { agentId: "opencode2", agentLabel: "OpenCode 2" } },
  { machine: providerSource[0].machine, machineID: "daemon-1", record: { agentId: "opencode2", agentLabel: "OpenCode 2" } }
])
assert.equal(countedChoices.find((choice) => choice.id === "opencode")?.count, 1)
assert.equal(countedChoices.find((choice) => choice.id === "opencode2")?.count, 2)
assert.equal(countedChoices.find((choice) => choice.id === "opencode")?.label, "OpenCode")
assert.equal(countedChoices.find((choice) => choice.id === "opencode2")?.label, "OpenCode 2")

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
assert.deepEqual(replacementPage.records.map(byID), ["current"], "the native page cache remains exact before manual pagination; visual stability belongs to the rail reconciliation layer")

function stableItem(backend, id, updated, status = "idle", directory = "/repo") {
  return {
    machine: { id: "machine-1", name: "Machine", config: {} },
    machineID: "daemon-1",
    record: {
      key: `${backend}:${id}`,
      agentId: backend,
      agentLabel: backend,
      backend,
      transport: backend === "opencode" ? "http" : "acp",
      abortSupported: true,
      modelsSupported: true,
      renameSupported: true,
      deleteSupported: true,
      session: {
        id,
        title: id,
        directory,
        time: { created: updated - 100, updated }
      },
      status: { type: status }
    }
  }
}

const stableKeys = (records) => records.map((entry) => entry.record.session.id)
for (const backend of ["opencode", "codex", "claude", "omp", "pi"]) {
  let rail = reconcileStableSessionRecords([], [
    stableItem(backend, "older", 100),
    stableItem(backend, "middle", 200),
    stableItem(backend, "recent", 300)
  ])
  assert.deepEqual(stableKeys(rail), ["recent", "middle", "older"], `${backend}: first render may use native recency`)

  rail = reconcileStableSessionRecords(rail, [
    stableItem(backend, "older", 900, "busy"),
    stableItem(backend, "recent", 700, "idle"),
    stableItem(backend, "middle", 800, "done")
  ], { keepMissing: () => true })
  assert.deepEqual(stableKeys(rail), ["recent", "middle", "older"], `${backend}: Working/Done timestamp changes must not move existing rows`)
  assert.equal(rail.find((entry) => entry.record.session.id === "older").record.status.type, "busy", `${backend}: stable layout must still accept fresh live metadata`)

  rail = reconcileStableSessionRecords(rail, [
    stableItem(backend, "recent", 700, "idle")
  ], { keepMissing: () => true })
  assert.deepEqual(stableKeys(rail), ["recent", "middle", "older"], `${backend}: a transient first-page omission must not make already-visible Sessions disappear`)

  const authoritativeRail = reconcileStableSessionRecords(rail, [
    stableItem(backend, "recent", 700, "idle")
  ])
  assert.deepEqual(stableKeys(authoritativeRail), ["recent"], `${backend}: an explicit authoritative refresh must prune Sessions absent from a successful native read`)

  rail = reconcileStableSessionRecords(rail, [
    stableItem(backend, "older", 950, "done"),
    stableItem(backend, "middle", 800, "done"),
    stableItem(backend, "recent", 700, "idle")
  ], { keepMissing: () => true })
  assert.deepEqual(stableKeys(rail), ["recent", "middle", "older"], `${backend}: completion must update in place rather than teleport the row`)
  assert.equal(rail.find((entry) => entry.record.session.id === "older").record.status.type, "done", `${backend}: terminal state must reconcile onto the retained row`)

  rail = reconcileStableSessionRecords(rail, [
    stableItem(backend, "new", 1_000),
    stableItem(backend, "older", 950, "done"),
    stableItem(backend, "middle", 800, "done"),
    stableItem(backend, "recent", 700, "idle")
  ], { keepMissing: () => true })
  assert.deepEqual(stableKeys(rail), ["new", "recent", "middle", "older"], `${backend}: a genuinely new Session may enter at the top without reordering existing rows`)

  rail = reconcileStableSessionRecords(rail, [
    ...rail,
    stableItem(backend, "very-old", 10)
  ], { keepMissing: () => true, newPosition: "back" })
  assert.deepEqual(stableKeys(rail), ["new", "recent", "middle", "older", "very-old"], `${backend}: Load older must append rather than disturb the visible list`)

  const deletedKey = `daemon-1:${backend}:middle`
  rail = reconcileStableSessionRecords(rail, rail.filter((entry) => entry.record.session.id !== "middle"), {
    deletedKeys: new Set([deletedKey]),
    keepMissing: () => true
  })
  assert.equal(stableKeys(rail).includes("middle"), false, `${backend}: an explicit delete must beat stable-layout retention immediately`)
}

let projectStableRail = reconcileStableSessionRecords([], [
  stableItem("codex", "project-a", 300, "idle", "/repo-a"),
  stableItem("codex", "project-b", 200, "idle", "/repo-b")
])
projectStableRail = reconcileStableSessionRecords(projectStableRail, [
  stableItem("codex", "project-b-new", 400, "idle", "/repo-b"),
  stableItem("codex", "project-a", 300, "idle", "/repo-a"),
  stableItem("codex", "project-b", 200, "idle", "/repo-b")
], { keepMissing: () => true })
assert.deepEqual(
  stableKeys(projectStableRail),
  ["project-a", "project-b-new", "project-b"],
  "new activity in an existing Project must enter at that Project's front without moving the Project itself"
)

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

const railAgent = (backend, state = "available", capabilities = { sessions: true, prompt: true }) => ({
  id: `${backend}-${state}`,
  label: backend,
  backend,
  transport: backend === "opencode" ? "http" : "acp",
  managed: true,
  state,
  capabilities
})

assert.equal(needsOpenCodeRailStream(railAgent("opencode")), true, "an available OpenCode agent without attention capabilities needs the persistent routed rail stream")
for (const backend of ["codex", "claude", "omp", "pi"]) {
  assert.equal(needsOpenCodeRailStream(railAgent(backend)), false, `${backend} must never gain the OpenCode routed rail lifecycle owner`)
}
for (const state of ["configured", "unavailable", "starting", "error"]) {
  assert.equal(needsOpenCodeRailStream(railAgent("opencode", state)), false, `OpenCode ${state} must not be started just because the Session rail is visible`)
}
assert.equal(needsOpenCodeRailStream(railAgent("opencode", "available", { sessions: false, prompt: true })), false, "OpenCode without native Sessions does not need a Session rail stream")
assert.equal(needsOpenCodeRailStream(railAgent("opencode", "available", { sessions: true, prompt: true, questions: true })), false, "OpenCode question capability already has an Attention-owned routed stream")
assert.equal(needsOpenCodeRailStream(railAgent("opencode", "available", { sessions: true, prompt: true, permissions: true })), false, "OpenCode permission capability already has an Attention-owned routed stream")

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

assert.equal(mergedAttentionSessionCount(
  new Set(["machine:agent:one", "machine:agent:two"]),
  new Set(["machine:agent:two", "machine:agent:three"])
), 3, "the nav attention count must be a Session-identity union rather than double-counting Inbox overlap")

const source = readFileSync(new URL("./components/native-session-home-base.tsx", import.meta.url), "utf8")
assert.match(source, /presentationOverrides/, "live detail status must survive selecting another Session")
assert.match(source, /\{ \.\.\.current, \[selectedKey\]: selectedState \}/, "the status bridge must be keyed by native Session identity")
assert.match(source, /reconcileStableSessionRecords\(current, freshRecords/, "native refreshes must reconcile into stable visual positions instead of replacing the rail order")
assert.match(source, /keepMissing: \(item\)/, "already-visible Sessions must survive transient native-index omissions while their source still exists")
assert.match(source, /newPosition: "back"/, "explicit older-page loading must append new rows instead of reordering the rail")
assert.doesNotMatch(source, /selectedActivityAnchor/, "layout stability must not be a selected-row-only timestamp workaround")
assert.doesNotMatch(source, /\[expandedProjects, selectedKey, selectedState\]/, "Working/Done changes must not force the selected row to scroll again")
assert.match(source, /presentationOverrides\[targetKey\]/, "non-selected rows must retain their last observed live state until discovery reconciles them")
assert.match(source, /attentionSessionKeys\?\.has\(targetKey\)[\s\S]*return "attention"/, "structured pending requests must override stale discovery state in the federated rail")
assert.match(source, /onAttentionKeysChange\?\.\(attentionKeys\)/, "the rail must expose attention identities so global counts can be deduplicated")
assert.match(source, /createMachineID/, "native Session creation must have an explicit machine selection independent of the list filter")
assert.match(source, /createMachines\.map/, "the create panel must render the available machine choices")
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
assert.match(source, /refreshCursorPage\(authoritativeRefresh \? undefined : existing, firstRecords, page\.nextCursor/, "automatic first-page refreshes must preserve the manual pagination tail while explicit Refresh rebuilds native truth")
assert.match(source, /authoritativeRefreshToken !== authoritativeRefreshApplied\.current/, "only an explicit Refresh token may switch the rail into authoritative pruning")
assert.match(source, /agent\.processID/, "adapter restarts must invalidate connection-bound ACP cursors")

const inboxSource = readFileSync(new URL("./components/native-session-home-attention.tsx", import.meta.url), "utf8")
assert.match(inboxSource, /loadNativeSessionAttentionIndex/, "the global Inbox must use the capability-driven pending-request index")
assert.match(inboxSource, /startNativeSessionAttentionLiveRefresh/, "the global Inbox must use its dedicated attention event path")
assert.match(inboxSource, /!result\.complete && previous[\s\S]*items: previous\.index\.items/, "a partial refresh must fail closed and preserve known pending attention")
assert.match(inboxSource, /openAttentionSession[\s\S]*discoverAgentNativeSessionPage/, "native history lookup must happen only when a user opens an Inbox item or notification")
assert.match(inboxSource, /attentionSessionKeys=\{inboxSessionKeys\}/, "the Inbox must feed pending Session identities into the existing federated filter instead of starting a second discovery path")
assert.match(inboxSource, /mergedAttentionSessionCount\(baseAttentionKeys, inboxSessionKeys\)/, "mobile nav attention must union native and Inbox identities")
assert.match(inboxSource, /Authorization required/, "global permissions must remain visibly distinct from generic attention")
assert.doesNotMatch(inboxSource, /startTaskDeskSessionLiveRefresh|loadMessagePage|continueConversation|stopConversation/, "global attention must stay outside transcript and Session writer paths")

const attentionSource = readFileSync(new URL("./components/work-thread-attention.tsx", import.meta.url), "utf8")
assert.match(attentionSource, /classifyNativeSessionAttention/, "the detail surface must use the shared attention state model")
assert.match(attentionSource, /Authorization required/, "permissions must be visibly distinct from generic input")
assert.match(attentionSource, /blocked until you allow or deny/, "authorization UI must explain that the agent remains blocked")
assert.match(attentionSource, /If you do nothing, this request remains blocked/, "authorization UI must state the consequence of no response")

console.log("native Session Home tree, stable rail lifecycle, create parity, attention semantics and selection UX tests passed")
