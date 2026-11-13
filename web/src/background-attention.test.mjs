import assert from "node:assert/strict"
import {
  backgroundAttentionMachines,
  restoreBackgroundAttentionNotification,
  selectedNativeSessionFromKey,
  syncBackgroundAttention,
  syncVisibleNativeSession
} from "./background-attention.ts"

function machine(id, host = "127.0.0.1", port = 4097, overrides = {}) {
  return {
    id,
    name: `Machine ${id}`,
    config: {
      backend: "opencode",
      host,
      port,
      username: "harness",
      password: "secret",
      ...overrides
    }
  }
}

const status = {
  supported: true,
  running: true,
  configuredMachines: 1,
  connectedMachines: 1,
  notificationPermission: true,
  batteryExempt: false,
  manufacturer: "Google",
  lastError: ""
}

{
  const result = backgroundAttentionMachines([
    machine("one"),
    machine("one", "127.0.0.2"),
    machine("two", "192.168.1.20", 4097, { username: "other", password: "pw" }),
    { ...machine("desktop"), id: "desktop-local-runtime" }
  ])
  assert.deepEqual(result, [
    {
      id: "one",
      name: "Machine one",
      baseUrl: "http://127.0.0.1:4097",
      username: "harness",
      password: "secret"
    },
    {
      id: "two",
      name: "Machine two",
      baseUrl: "http://192.168.1.20:4097",
      username: "other",
      password: "pw"
    }
  ], "the native payload must be deduplicated, desktop-local-free and credential-complete")
}

{
  const result = backgroundAttentionMachines([
    machine("https", "studio.local", 4097, { host: "https://studio.local" }),
    machine("broken", "ftp://studio.local")
  ])
  assert.equal(result.length, 1, "only an HTTP(S) endpoint with an explicit port may reach the service")
  assert.equal(result[0].baseUrl, "https://studio.local:4097")
}

{
  // A daemon behind an HTTPS reverse proxy or Tailscale serve listens on the default port, which
  // `new URL` normalises away. It must still reach the background service.
  const result = backgroundAttentionMachines([
    machine("proxy", "https://studio.example.ts.net", 443),
    machine("plain", "http://10.0.0.9", 80)
  ])
  assert.deepEqual(result.map((entry) => entry.baseUrl), [
    "https://studio.example.ts.net:443",
    "http://10.0.0.9:80"
  ])
}

{
  const machines = Array.from({ length: 9 }, (_, index) => machine(`m${index}`, `10.0.0.${index + 1}`))
  assert.equal(backgroundAttentionMachines(machines).length, 6, "the native payload stays bounded")
}

{
  const calls = []
  const plugin = {
    async configure(options) {
      calls.push(["configure", options.machines.map((entry) => entry.id)])
      return status
    },
    async start(options) {
      calls.push(["start", options.prompt])
      return status
    },
    async stop() {
      calls.push(["stop"])
      return status
    },
    async status() {
      return status
    }
  }
  const result = await syncBackgroundAttention([machine("one")], { platform: "android", prompt: true, plugin })
  assert.deepEqual(result, status)
  assert.deepEqual(calls, [["configure", ["one"]], ["start", true]], "pairing must configure then start with permission prompting")

  calls.length = 0
  await syncBackgroundAttention([], { platform: "android", plugin })
  assert.deepEqual(calls, [["configure", []], ["stop"]], "removing every machine must stop the native service")
}

{
  let called = false
  const plugin = {
    async configure() { called = true; return status },
    async start() { called = true; return status },
    async stop() { called = true; return status },
    async status() { return status }
  }
  const result = await syncBackgroundAttention([machine("one")], { platform: "web", plugin })
  assert.equal(result, null)
  assert.equal(called, false, "web and desktop must not touch the Android service")
}

{
  const calls = []
  const plugin = {
    async restoreNotification() {
      calls.push("restore")
      return status
    }
  }
  const result = await restoreBackgroundAttentionNotification({ platform: "android", plugin })
  assert.deepEqual(result, status)
  assert.deepEqual(calls, ["restore"], "the explicit recovery path must ask the native service to re-post")
}

{
  let called = false
  const plugin = { async restoreNotification() { called = true; return status } }
  const result = await restoreBackgroundAttentionNotification({ platform: "web", plugin })
  assert.equal(result, null)
  assert.equal(called, false, "web and desktop never call the Android notification recovery bridge")
}

{
  assert.deepEqual(
    selectedNativeSessionFromKey("machine-1:opencode:session-1"),
    { machineID: "machine-1", agentID: "opencode", sessionID: "session-1" },
    "the existing selected-Session key is the native visibility identity"
  )
  assert.equal(selectedNativeSessionFromKey(null), null)
  assert.equal(selectedNativeSessionFromKey("machine-1:opencode"), null)
  assert.equal(selectedNativeSessionFromKey(":opencode:session-1"), null)
  assert.equal(selectedNativeSessionFromKey("machine-1::session-1"), null)
}

{
  const calls = []
  const plugin = {
    async setVisibleSession(options) {
      calls.push(options)
      return status
    }
  }
  await syncVisibleNativeSession(
    { machineID: "machine-1", agentID: "opencode", sessionID: "session-1" },
    { platform: "android", plugin }
  )
  await syncVisibleNativeSession(null, { platform: "android", plugin })
  assert.deepEqual(calls, [
    { machineID: "machine-1", agentID: "opencode", sessionID: "session-1" },
    {}
  ], "selection changes reach the native service and clearing is explicit")
}

{
  let called = false
  const plugin = {
    async setVisibleSession() { called = true; return status }
  }
  const result = await syncVisibleNativeSession(
    { machineID: "machine-1", agentID: "opencode", sessionID: "session-1" },
    { platform: "web", plugin }
  )
  assert.equal(result, null)
  assert.equal(called, false, "web and desktop never call the Android visibility bridge")
}

{
  // Someone who updates from a version without background notifications already has paired
  // machines and never goes through pairing again. The launch must offer the one-time prompt.
  const { readFileSync } = await import("node:fs")
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
  assert.match(
    main,
    /syncBackgroundAttention\(persistedMachines, \{ prompt: true, preferences: notificationPreferences \}\)/,
    "a launch with paired machines asks for the notification permission once"
  )
}

{
  // Settings → Notifications on Android. The master switch off stops the service, which exists only
  // to deliver notifications; the per-kind switches reach the native service, which posts while the
  // WebView is gone.
  const calls = []
  const plugin = {
    async configure(options) { calls.push(["configure", options.machines.length]); return status },
    async start() { calls.push(["start"]); return status },
    async stop() { calls.push(["stop"]); return status },
    async setNotificationKinds(kinds) { calls.push(["kinds", kinds]); return status }
  }
  await syncBackgroundAttention([machine("one")], {
    platform: "android",
    plugin,
    preferences: { enabled: false, ready: true, failed: true, attention: true }
  })
  assert.deepEqual(calls, [["configure", 0], ["stop"]], "notifications off on this device stops the background service")

  calls.length = 0
  await syncBackgroundAttention([machine("one")], {
    platform: "android",
    plugin,
    preferences: { enabled: true, ready: false, failed: true, attention: false }
  })
  assert.deepEqual(calls, [
    ["configure", 1],
    ["kinds", { ready: false, failed: true, attention: false }],
    ["start"]
  ], "the per-kind switches reach the native service before it starts")
}
