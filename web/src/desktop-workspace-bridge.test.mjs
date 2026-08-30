import assert from "node:assert/strict"

const calls = {
  replace: [],
  request: [],
  subscribe: [],
  unsubscribe: []
}

let releaseFirstSync
const firstSyncGate = new Promise((resolve) => { releaseFirstSync = resolve })

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
      return Promise.resolve({ ok: true, response: { status: 200, data: { ok: true }, headers: {} } })
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
    onMenuCommand() { return () => {} },
    setApplicationMenu() { return Promise.resolve(true) }
  }
}

const bridge = await import("./desktopBridge.ts")

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

console.log("desktop workspace bridge regression tests passed")
