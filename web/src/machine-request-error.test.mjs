import assert from "node:assert/strict"
import { api } from "./api.ts"
import { taskClient } from "./taskClient.ts"
import { syncDesktopProfiles } from "./desktopBridge.ts"
import { MachineHttpError, isMachineTransportFailure } from "./machine-request-error.ts"

const config = { backend: "claude", host: "127.0.0.1", port: 4914, username: "", password: "" }
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const requests = [
  () => api.sendPrompt(config, "claude-test", "Test prompt"),
  () => taskClient.getWorkThread(config, "test-thread")
]
const upstreamError = "Internal error: Network error. Please check your internet connection."

async function expectHttpFailure(request, status, message) {
  await assert.rejects(request, (error) => {
    assert.ok(error instanceof MachineHttpError)
    assert.equal(error.status, status)
    assert.equal(error.message, message)
    assert.equal(isMachineTransportFailure(error), false, "a daemon HTTP response must not disconnect a healthy machine")
    return true
  })
}

try {
  for (const status of [500, 503]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: upstreamError }), { status })
    for (const request of requests) await expectHttpFailure(request, status, upstreamError)
  }

  globalThis.fetch = async () => { throw new TypeError("Failed to fetch") }
  for (const request of requests) {
    await assert.rejects(request, (error) => {
      assert.equal(isMachineTransportFailure(error), true, "a real failed fetch must still trigger machine recovery")
      return true
    })
  }
  assert.equal(isMachineTransportFailure(new Error("Request timed out")), true)

  // Exercise the renderer's real Electron error conversion as well as browser fetch.
  let desktopError = { code: "http", status: 500, message: upstreamError }
  globalThis.window = {
    harnessDesktop: {
      platform: { isDesktop: true, os: "linux" },
      async replaceProfiles(profiles, revision) {
        return { revision, acceptedProfileIDs: profiles.map((profile) => profile.id), changedProfileIDs: [], removedProfileIDs: [], unchangedProfileIDs: [] }
      },
      async request() { return { ok: false, error: desktopError } }
    }
  }
  await syncDesktopProfiles([{ id: "test-machine", name: "Test", config }])
  for (const request of requests) await expectHttpFailure(request, 500, upstreamError)
  desktopError = { code: "connection", message: "Cannot reach 127.0.0.1:4914." }
  for (const request of requests) {
    await assert.rejects(request, (error) => {
      assert.equal(isMachineTransportFailure(error), true)
      return true
    })
  }
} finally {
  globalThis.fetch = originalFetch
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
}

console.log("Harness HTTP errors preserve machine connectivity; real transport failures still reconnect")
