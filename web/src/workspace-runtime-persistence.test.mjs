import assert from "node:assert/strict"
import test from "node:test"

const storage = new Map()
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
  clear() { storage.clear() }
}

const {
  DESKTOP_LOCAL_MACHINE_ID,
  WORKSPACE_MACHINES_STORAGE_KEY,
  loadWorkspaceMachines,
  persistWorkspaceMachines
} = await import("./workspaceMachines.ts")

const remote = {
  id: "remote-machine",
  name: "Remote",
  config: {
    backend: "opencode",
    host: "192.168.1.50",
    port: 4097,
    username: "harness",
    password: "saved-secret"
  }
}
const local = {
  id: DESKTOP_LOCAL_MACHINE_ID,
  name: "This computer",
  config: {
    backend: "opencode",
    host: "127.0.0.1",
    port: 4123,
    username: "",
    password: ""
  }
}

test("desktop local runtime is never persisted with workspace machines", () => {
  storage.clear()
  persistWorkspaceMachines([local, remote])
  const raw = storage.get(WORKSPACE_MACHINES_STORAGE_KEY)
  assert.match(raw, /remote-machine/)
  assert.doesNotMatch(raw, /desktop-local-runtime/)
  assert.deepEqual(loadWorkspaceMachines().map((machine) => machine.id), ["remote-machine"])
})

test("a stale persisted runtime projection is discarded on load", () => {
  storage.set(WORKSPACE_MACHINES_STORAGE_KEY, JSON.stringify([local, remote]))
  assert.deepEqual(loadWorkspaceMachines().map((machine) => machine.id), ["remote-machine"])
})
