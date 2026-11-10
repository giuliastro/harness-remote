import assert from "node:assert/strict"
import { backgroundAttentionMachines, syncBackgroundAttention } from "./background-attention.ts"

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
