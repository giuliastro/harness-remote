import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const {
  DEFAULT_NETWORK_SETTINGS,
  NetworkSettingsStore,
  parseNetworkSettings
} = await import("../dist-electron/electron/network-settings.js")

test("network settings accept only a boolean LAN pairing flag and default to off", () => {
  assert.deepEqual(DEFAULT_NETWORK_SETTINGS, { lanPairing: false })
  assert.deepEqual(parseNetworkSettings({ lanPairing: true }), { lanPairing: true })
  assert.deepEqual(parseNetworkSettings({ lanPairing: false }), { lanPairing: false })
  assert.equal(parseNetworkSettings({ lanPairing: "yes" }), null)
  assert.equal(parseNetworkSettings({}), null)
  assert.equal(parseNetworkSettings(null), null)
  assert.equal(parseNetworkSettings([]), null)
  assert.equal(parseNetworkSettings("on"), null)
})

test("the store persists the opt-in and reloads it; a rejected or corrupt value never wins", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-network-settings-"))
  const file = join(root, "desktop-network-settings.json")
  try {
    const store = new NetworkSettingsStore(file)
    await store.load()
    assert.deepEqual(store.get(), { lanPairing: false })

    await store.replace({ lanPairing: true })
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { lanPairing: true }, "the opt-in must survive an application restart")
    const reloaded = new NetworkSettingsStore(file)
    await reloaded.load()
    assert.deepEqual(reloaded.get(), { lanPairing: true })

    await assert.rejects(reloaded.replace({ lanPairing: "yes" }), /Invalid network settings/)
    assert.deepEqual(reloaded.get(), { lanPairing: true }, "a rejected write must not change the live settings")

    await writeFile(file, "not json", "utf8")
    const corrupted = new NetworkSettingsStore(file)
    await corrupted.load()
    assert.deepEqual(corrupted.get(), { lanPairing: false }, "a corrupt file falls back to the safe default")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

console.log("network settings regression tests passed")
