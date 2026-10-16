import assert from "node:assert/strict"

const calls = {
  replace: [],
  request: [],
  subscribe: [],
  unsubscribe: [],
  attention: [],
  runtimeGet: 0,
  runtimeRetry: 0,
  networkGet: 0,
  networkSet: []
}

let attentionActivation
let releaseFirstSync
const firstSyncGate = new Promise((resolve) => { releaseFirstSync = resolve })
let runtimeState = {
  status: "ready",
  machine: { profileId: "desktop-local-runtime", host: "127.0.0.1", port: 4111, pid: 1234 }
}
let networkState = { lanPairing: false }
let networkFailure

globalThis.window = {
  harnessDesktop: {
    platform: { isDesktop: true, os: "linux" },
    replaceProfiles(profiles, revision) {
      calls.replace.push({ profiles, revision })
      if (profiles.length > 0 && calls.replace.filter((call) => call.profiles.length > 0).length === 1) return firstSyncGate
      return Promise.resolve({
        revision,
        acceptedProfileIDs: profiles.map((profile) => profile.id),
        changedProfileIDs: profiles.map((profile) => profile.id),
        removedProfileIDs: [],
        unchangedProfileIDs: []
      })
    },
    request(profileId, request) {
      calls.request.push({ profileId, request })
      const data = request.path.startsWith("/v1/agents/")
        ? {
            models: [{ providerID: "codex", providerName: "Codex", modelID: "gpt-5.6-sol", modelName: "GPT-5.6-Sol" }],
            stale: false,
            refreshedAt: "2026-09-08T00:00:00.000Z"
          }
        : { ok: true }
      return Promise.resolve({ ok: true, response: { status: 200, data, headers: {} } })
    },
    getLocalRuntimeState() {
      calls.runtimeGet += 1
      return Promise.resolve(runtimeState)
    },
    retryLocalRuntime() {
      calls.runtimeRetry += 1
      return Promise.resolve(runtimeState)
    },
    getNetworkSettings() {
      calls.networkGet += 1
      return Promise.resolve({ ...networkState })
    },
    setNetworkSettings(lanPairing, language) {
      calls.networkSet.push({ lanPairing, language })
      if (networkFailure) return Promise.reject(networkFailure)
      networkState = { lanPairing }
      return Promise.resolve({ ...networkState, cancelled: false })
    },
    subscribeEvents(profileId, options) {
      calls.subscribe.push({ profileId, options })
      return Promise.resolve("sub-1")
    },
    unsubscribeEvents(subscriptionId) {
      calls.unsubscribe.push(subscriptionId)
      return Promise.resolve()
    },
    notifyCompletion() { return Promise.resolve() },
    notifyAttention(notification) {
      calls.attention.push(notification)
      return Promise.resolve()
    },
    onAttentionActivated(callback) {
      attentionActivation = callback
      return () => {
        if (attentionActivation === callback) attentionActivation = undefined
      }
    },
    onMenuCommand() { return () => {} },
    setApplicationMenu() { return Promise.resolve(true) }
  }
}

const bridge = await import("./desktopBridge.ts")
const { taskClient } = await import("./taskClient.ts")

// A fresh renderer must send its canonical snapshot even when it is empty. Otherwise Electron can
// retain stale profiles loaded from desktop-profiles.json after an application restart.
await bridge.syncDesktopProfiles([])
assert.equal(calls.replace.length, 1)
assert.deepEqual(calls.replace[0].profiles, [])

const machine = {
  id: "machine-local",
  name: "Local",
  config: {
    backend: "opencode",
    host: "HTTP://LOCALHOST/",
    port: 4097,
    username: " harness ",
    password: " secret "
  }
}

const sync = bridge.syncDesktopProfiles([machine])
const firstRequest = bridge.desktopRequestResult(
  { ...machine.config, backend: "codex", agentId: "codex" },
  { path: "/session/test" }
)

await Promise.resolve()
assert.equal(calls.request.length, 0, "first desktop request must wait for registry acknowledgement")
assert.equal(calls.replace.length, 2)
assert.deepEqual(calls.replace[1].profiles, [{
  id: "machine-local",
  backend: "opencode",
  host: "http://localhost",
  port: 4097,
  username: "harness",
  password: "secret"
}])

releaseFirstSync({
  revision: 1,
  acceptedProfileIDs: ["machine-local"],
  changedProfileIDs: ["machine-local"],
  removedProfileIDs: [],
  unchangedProfileIDs: []
})
await sync
await firstRequest

assert.equal(calls.request.length, 1)
assert.equal(calls.request[0].profileId, "machine-local")
assert.deepEqual(calls.request[0].request.route, { backend: "codex", agentId: "codex" })

const catalog = await taskClient.listAgentModels(
  { ...machine.config, backend: "claude", agentId: "claude" },
  "codex"
)
assert.equal(catalog.models[0]?.modelID, "gpt-5.6-sol")
assert.match(calls.request[1].request.path, /^\/v1\/agents\/codex\/models\?/)
assert.deepEqual(
  calls.request[1].request.route,
  { backend: "codex", agentId: "codex" },
  "desktop model discovery must not combine the selected agent path with the machine primary backend"
)
assert.equal(
  bridge.desktopProfileID({ ...machine.config, backend: "pi", agentId: "pi" }),
  "machine-local",
  "agent routing must not change the authorized machine identity"
)

const statuses = []
const subscription = bridge.createDesktopOpenCodeEventSubscription({
  config: { ...machine.config, backend: "pi", agentId: "pi" },
  scope: "global",
  onEvent() {},
  onStatus(status) { statuses.push(status) }
})
for (let index = 0; index < 20 && calls.subscribe.length === 0; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
assert.equal(calls.subscribe.length, 1)
assert.equal(calls.subscribe[0].profileId, "machine-local")
assert.deepEqual(calls.subscribe[0].options, {
  scope: "global",
  directory: undefined,
  backend: "pi",
  agentId: "pi"
})
subscription.close()

const notification = {
  title: "Authorization required",
  body: "write_file\nThe Session remains blocked until you allow or deny this request.",
  overlayDescription: "Authorization required · Local · Codex",
  target: { machineID: "native-machine", agentID: "codex", sessionID: "session-123" }
}
bridge.notifyDesktopAttention(notification)
await Promise.resolve()
assert.deepEqual(calls.attention, [notification])

const activated = []
const unsubscribeAttention = bridge.subscribeDesktopAttentionActivation((target) => activated.push(target))
attentionActivation?.(notification.target)
assert.deepEqual(activated, [notification.target])
unsubscribeAttention()
attentionActivation?.({ machineID: "other", agentID: "codex", sessionID: "ignored" })
assert.equal(activated.length, 1, "unsubscribed attention activation must not leak callbacks")

const lan = {
  id: "machine-lan",
  name: "LAN",
  config: {
    backend: "opencode",
    host: "192.168.1.40",
    port: 4097,
    username: "harness",
    password: "secret"
  }
}
await bridge.syncDesktopProfiles([lan])
assert.equal(bridge.desktopProfileID({ ...lan.config, backend: "omp", agentId: "omp" }), "machine-lan")

// The embedded runtime endpoint is public to the renderer, but its credentials are not. Once the
// state has been read, host+port map to the volatile main-process profile and requests route there.
const ready = await bridge.desktopLocalRuntimeState()
assert.equal(calls.runtimeGet, 1)
assert.deepEqual(ready, runtimeState)
const localConfig = {
  backend: "codex",
  agentId: "codex",
  host: runtimeState.machine.host,
  port: runtimeState.machine.port,
  username: "",
  password: ""
}
assert.equal(bridge.desktopProfileID(localConfig), "desktop-local-runtime")
const localResult = await bridge.desktopRequestResult(localConfig, { path: "/session/local" })
assert.equal(localResult.ok, true)
assert.equal(calls.request.at(-1).profileId, "desktop-local-runtime")
assert.deepEqual(calls.request.at(-1).request.route, { backend: "codex", agentId: "codex" })

// Polling the embedded runtime is a health check, not a reason to rebuild the renderer's machine
// list. Electron IPC returns a fresh object on every call; an unchanged semantic state must retain
// the prior object identity so React does not restart an unrelated slow/offline machine discovery.
runtimeState = {
  status: "ready",
  machine: { profileId: "desktop-local-runtime", host: "127.0.0.1", port: 4111, pid: 1234 }
}
const sameReady = await bridge.desktopLocalRuntimeState()
assert.equal(calls.runtimeGet, 2)
assert.strictEqual(sameReady, ready, "unchanged runtime polls must preserve object identity")

runtimeState = {
  status: "ready",
  machine: { profileId: "desktop-local-runtime", host: "127.0.0.1", port: 4111, pid: 4321 }
}
const restartedReady = await bridge.desktopLocalRuntimeState()
assert.equal(calls.runtimeGet, 3)
assert.notStrictEqual(restartedReady, sameReady, "a real runtime restart must produce a new state object")
assert.equal(restartedReady.machine.pid, 4321)

// Even if a composed workspace snapshot contains the local projection, renderer synchronization
// must never attempt to persist/replace the volatile main-process profile.
await bridge.syncDesktopProfiles([
  lan,
  {
    id: "desktop-local-runtime",
    config: { ...localConfig, backend: "opencode", agentId: undefined }
  }
])
assert.deepEqual(calls.replace.at(-1).profiles.map((profile) => profile.id), ["machine-lan"])

runtimeState = { status: "unavailable", error: "not installed" }
assert.deepEqual(await bridge.retryDesktopLocalRuntime(), runtimeState)
assert.equal(calls.runtimeRetry, 1)

// The LAN pairing opt-in is a plain main-process setting the renderer proxies. A restart that the
// user cancels in the native dialog answers cancelled without changing anything, and a busy runtime
// or a failed IPC turns into the translated error the machine editor shows.
assert.deepEqual(await bridge.desktopNetworkSettings(), { lanPairing: false })
assert.equal(calls.networkGet, 1)
assert.deepEqual(await bridge.setDesktopNetworkSettings(true), { lanPairing: true, cancelled: false })
assert.equal(calls.networkSet.at(-1).lanPairing, true)
assert.equal(typeof calls.networkSet.at(-1).language, "string")
networkState = { lanPairing: true }
networkFailure = new Error("boom")
await assert.rejects(bridge.setDesktopNetworkSettings(false), /could not be updated|impossibile|無法|无法/i, "an IPC failure must surface the translated settings error")
networkFailure = undefined
assert.deepEqual(await bridge.desktopNetworkSettings(), { lanPairing: true })

console.log("desktop workspace bridge regression tests passed")