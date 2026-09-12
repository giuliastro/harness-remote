import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("TaskDesk desktop live events follow the selected daemon agent", () => {
  const contract = readFileSync(new URL("../electron/ipc-contract.ts", import.meta.url), "utf8")
  const bridge = readFileSync(new URL("./desktopBridge.ts", import.meta.url), "utf8")
  const transport = readFileSync(new URL("../electron/event-transport.ts", import.meta.url), "utf8")
  const liveEvents = readFileSync(new URL("./taskdesk-live-events.ts", import.meta.url), "utf8")

  assert.match(contract, /backend\?: BackendKind/)
  assert.match(contract, /agentId\?: string/)
  assert.match(liveEvents, /createDesktopOpenCodeEventSubscription\(\{[\s\S]*?config,/)
  assert.match(bridge, /const profileId = desktopProfileID\(options\.config\)/)
  assert.match(bridge, /backend: options\.config\.backend/)
  assert.match(bridge, /agentId: options\.config\.agentId/)
  assert.match(transport, /const targetProfile = eventProfile\(profile, subscription\.options\)/)
  assert.match(transport, /routingHeaders\(targetProfile, \{ preflight: false \}\)/)
  assert.match(transport, /streamURL\(targetProfile, subscription\.options\)/)
})

test("desktop event routing validates the renderer supplied route", () => {
  const transport = readFileSync(new URL("../electron/event-transport.ts", import.meta.url), "utf8")
  assert.match(transport, /EVENT_BACKENDS/)
  assert.match(transport, /Event subscription backend is invalid/)
  assert.match(transport, /\^\[A-Za-z0-9\._-\]\+\$/)
  assert.match(transport, /Event subscription agent is invalid/)
})

test("Session-first controller uses live events as the primary refresh path", () => {
  const controller = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")

  assert.match(controller, /startTaskDeskSessionLiveRefresh\(\{/)
  assert.match(controller, /onMessage:/)
  assert.match(controller, /onIndex:/)
  assert.match(controller, /onDetail:/)
  assert.match(controller, /createCoalescedTailRefresh/)
})

test("OpenCode completion lifecycle reconciles status and the selected transcript", () => {
  const refresh = readFileSync(new URL("./taskdesk-session-live-refresh.ts", import.meta.url), "utf8")
  const lifecycle = refresh.match(/if \(event\.type === "session\.status"[\s\S]*?\n      \}/)?.[0] || ""

  assert.match(lifecycle, /event\.type === "session\.idle"/)
  assert.match(lifecycle, /throttle\("index", [^,]+, onIndex\)/)
  assert.match(lifecycle, /selectedEvent[\s\S]*?throttle\("message", [^,]+, onMessage\)/)
  assert.doesNotMatch(lifecycle, /send|prompt|continueWorkThread/)
})

test("pending permission/question never masquerades as terminal lifecycle", () => {
  const refresh = readFileSync(new URL("./taskdesk-session-live-refresh.ts", import.meta.url), "utf8")
  const attentionLifecycle = refresh.match(/if \(isAttentionEvent\(event\.type\)\) \{[\s\S]*?\n      \}/)?.[0] || ""

  assert.match(refresh, /type === "permission\.replied"/)
  assert.match(refresh, /type === "question\.replied"/)
  assert.match(refresh, /type === "question\.rejected"/)
  assert.match(attentionLifecycle, /throttle\("detail", [^,]+, onDetail\)/)
  assert.match(attentionLifecycle, /throttle\("message", [^,]+, onMessage\)/)
  assert.match(attentionLifecycle, /if \(isAttentionResolutionEvent\(event\.type\)\)/)
  assert.match(attentionLifecycle, /throttle\("index", [^,]+, onIndex\)/)
  assert.match(attentionLifecycle, /settleAfterLifecycle\(\)/)

  const resolutionGuard = attentionLifecycle.indexOf("if (isAttentionResolutionEvent(event.type))")
  assert.ok(resolutionGuard >= 0)
  assert.ok(attentionLifecycle.indexOf('throttle("index"', resolutionGuard) > resolutionGuard)
  assert.ok(attentionLifecycle.indexOf("settleAfterLifecycle()", resolutionGuard) > resolutionGuard)
  assert.doesNotMatch(attentionLifecycle.slice(0, resolutionGuard), /throttle\("index"|settleAfterLifecycle\(\)/)
  assert.doesNotMatch(attentionLifecycle, /send|prompt|continueWorkThread/)
})

test("OpenCode reliability regressions stay in the required browser gate", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/pr-checks.yml", import.meta.url), "utf8")
  const browserSmoke = readFileSync(new URL("../scripts/native-opencode-browser-smoke.mjs", import.meta.url), "utf8")
  const realSmoke = readFileSync(new URL("../scripts/native-opencode-real-regression-smoke.mjs", import.meta.url), "utf8")
  const permissionSmoke = readFileSync(new URL("../scripts/native-opencode-permission-regression-smoke.mjs", import.meta.url), "utf8")

  for (const marker of [
    "OPENCODE-TRANSIENT-INTERRUPTION-PROMPT",
    "OPENCODE-LATE-RECOVERY-PROMPT",
    "OPENCODE-TERMINAL-INTERRUPTION-PROMPT",
    "OPENCODE-TERMINAL-PROVIDER-ERROR-PROMPT",
    "OPENCODE-PERSISTED-WITHOUT-FINAL-EVENT-PROMPT"
  ]) assert.ok(browserSmoke.includes(marker), `missing historical OpenCode browser regression: ${marker}`)
  assert.match(realSmoke, /mounted completion lag/)
  assert.match(realSmoke, /without navigation/)

  assert.match(permissionSmoke, /permission\.asked/)
  assert.match(permissionSmoke, /permission\.replied/)
  assert.match(permissionSmoke, /Response interrupted/)
  assert.match(permissionSmoke, /reply: "reject"/)
  assert.match(permissionSmoke, /reply: "once"/)
  assert.match(permissionSmoke, /opening an unresolved Session must not consume Attention/)
  assert.match(permissionSmoke, /permission resolution left mounted Activity running/)
  assert.doesNotMatch(permissionSmoke, /page\.reload\(/)

  for (const script of [
    "native-opencode-browser-smoke.mjs",
    "native-opencode-real-regression-smoke.mjs",
    "native-opencode-permission-regression-smoke.mjs"
  ]) assert.ok(workflow.includes(`node scripts/${script}`), `${script} is not a required Chromium PR gate`)
})

test("foregrounding the app immediately reconciles durable conversation state", () => {
  const refresh = readFileSync(new URL("./taskdesk-session-live-refresh.ts", import.meta.url), "utf8")

  assert.match(refresh, /CapacitorApp\.addListener\("appStateChange"/)
  assert.match(refresh, /if \(isActive\) reconcileAfterForeground\(\)/)
  assert.match(refresh, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/)
  assert.match(refresh, /window\.addEventListener\("pageshow", onPageShow\)/)

  const foreground = refresh.match(/const reconcileAfterForeground = \(\) => \{[\s\S]*?\n  \}/)?.[0] || ""
  assert.match(foreground, /onIndex\(\)/)
  assert.match(foreground, /onMessage\(\)/)
  assert.match(foreground, /onDetail\(\)/)
  assert.doesNotMatch(foreground, /send|prompt|continueWorkThread/)

  assert.match(refresh, /document\.removeEventListener\("visibilitychange", onVisibilityChange\)/)
  assert.match(refresh, /window\.removeEventListener\("pageshow", onPageShow\)/)
  assert.match(refresh, /appStateHandle.*remove\(\)/)
})
