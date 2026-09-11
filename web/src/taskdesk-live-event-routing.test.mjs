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

test("foregrounding the app immediately reconciles durable conversation state", () => {
  const refresh = readFileSync(new URL("./taskdesk-session-live-refresh.ts", import.meta.url), "utf8")

  // Android may keep the native SSE reader alive while WebView JavaScript is suspended, so events
  // produced in the background cannot be the only way the renderer catches up on resume.
  assert.match(refresh, /CapacitorApp\.addListener\("appStateChange"/)
  assert.match(refresh, /if \(isActive\) reconcileAfterForeground\(\)/)
  assert.match(refresh, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/)
  assert.match(refresh, /window\.addEventListener\("pageshow", onPageShow\)/)

  // Resume must re-read both authoritative Conversation state and the selected transcript/attention
  // surfaces. It must not resend a prompt or depend on a new live event arriving.
  const foreground = refresh.match(/const reconcileAfterForeground = \(\) => \{[\s\S]*?\n  \}/)?.[0] || ""
  assert.match(foreground, /onIndex\(\)/)
  assert.match(foreground, /onMessage\(\)/)
  assert.match(foreground, /onDetail\(\)/)
  assert.doesNotMatch(foreground, /send|prompt|continueWorkThread/)

  // Lifecycle listeners cannot accumulate as Conversations are opened and closed.
  assert.match(refresh, /document\.removeEventListener\("visibilitychange", onVisibilityChange\)/)
  assert.match(refresh, /window\.removeEventListener\("pageshow", onPageShow\)/)
  assert.match(refresh, /appStateHandle.*remove\(\)/)
})
