import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const { DesktopProfileError, ProfileRegistry } = await import("../dist-electron/electron/profile-registry.js")

function profile(id, overrides = {}) {
  return {
    id,
    backend: "opencode",
    host: "127.0.0.1",
    port: 4097,
    username: "harness",
    password: "saved-secret",
    ...overrides
  }
}

test("runtime profiles authorize transport without being persisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-runtime-profile-"))
  const path = join(root, "profiles.json")
  const registry = new ProfileRegistry(path)
  try {
    await registry.replace([profile("saved", { host: "machine.local" })], 1)
    const runtime = profile("runtime-local", {
      port: 4123,
      username: "harness-desktop",
      password: "ephemeral-secret"
    })
    const change = registry.setRuntimeProfile(runtime)

    assert.equal(registry.get("runtime-local").password, "ephemeral-secret")
    assert.equal(registry.has("runtime-local"), true)
    assert.ok(change.changedProfileIDs.includes("runtime-local"))

    const persisted = await readFile(path, "utf8")
    assert.equal(persisted.includes("saved-secret"), true)
    assert.equal(persisted.includes("ephemeral-secret"), false)
    assert.equal(persisted.includes("runtime-local"), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("renderer replacement cannot overwrite or remove a runtime-owned profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-runtime-profile-replace-"))
  const path = join(root, "profiles.json")
  const registry = new ProfileRegistry(path)
  try {
    registry.setRuntimeProfile(profile("runtime-local", { password: "runtime-secret" }))
    await registry.replace([profile("saved", { host: "machine.local" })], 1)
    assert.equal(registry.get("runtime-local").password, "runtime-secret")
    assert.equal(registry.get("saved").host, "machine.local")

    await assert.rejects(
      registry.replace([profile("runtime-local", { password: "renderer-secret" })], 2),
      DesktopProfileError
    )
    assert.equal(registry.get("runtime-local").password, "runtime-secret")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("clearing a runtime profile removes only the volatile entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-runtime-profile-clear-"))
  const path = join(root, "profiles.json")
  const registry = new ProfileRegistry(path)
  try {
    await registry.replace([profile("saved", { host: "machine.local" })], 1)
    registry.setRuntimeProfile(profile("runtime-local"))
    const change = registry.clearRuntimeProfile("runtime-local")

    assert.deepEqual(change.removedProfileIDs, ["runtime-local"])
    assert.equal(registry.has("runtime-local"), false)
    assert.equal(registry.has("saved"), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})