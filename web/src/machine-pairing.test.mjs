import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  claimMachinePairing,
  parseMachinePairingActivation,
  scanAndroidMachinePairing,
  upsertPairedMachine
} from "./machine-pairing.ts"

const future = () => Date.now() + 60_000
const pairingURL = (endpoint = "http://192.168.1.20:4097", expiresAt = future()) =>
  `harnessremote://pair?endpoint=${encodeURIComponent(endpoint)}&token=${"a".repeat(43)}&expires=${expiresAt}`

test("pairing activation accepts only the private explicit daemon endpoint shape", () => {
  const expiresAt = future()
  const url = pairingURL("http://192.168.1.20:4097", expiresAt)
  assert.deepEqual(parseMachinePairingActivation(url), {
    endpoint: "http://192.168.1.20:4097",
    token: "a".repeat(43),
    expiresAt
  })
  assert.equal(parseMachinePairingActivation("https://example.com"), null)
  assert.equal(parseMachinePairingActivation(pairingURL("http://user:secret@192.168.1.20:4097")), null)
  assert.equal(parseMachinePairingActivation(pairingURL("http://192.168.1.20")), null)
  assert.equal(parseMachinePairingActivation(pairingURL("http://192.168.1.20:4097/path")), null)
})

test("Android in-app scanner accepts only Harness Remote pairing QR values", async () => {
  const url = pairingURL()
  const expected = parseMachinePairingActivation(url)
  assert.deepEqual(await scanAndroidMachinePairing({
    platform: "android",
    scan: async () => ({ value: url })
  }), expected)
  assert.equal(await scanAndroidMachinePairing({
    platform: "android",
    scan: async () => ({ cancelled: true })
  }), null)
  await assert.rejects(() => scanAndroidMachinePairing({
    platform: "android",
    scan: async () => ({ value: "https://example.com/not-a-pairing-code" })
  }), /not a valid Harness Remote machine pairing code/i)
})

test("native pairing claim exchanges the one-time token for the existing daemon credentials", async () => {
  const activation = parseMachinePairingActivation(pairingURL())
  assert.ok(activation)
  let requestOptions
  const paired = await claimMachinePairing(activation, {
    native: true,
    nativeRequest: async (options) => {
      requestOptions = options
      return {
        status: 200,
        data: {
          version: 1,
          machine: { id: "physical-machine-1", name: "Studio PC" },
          credentials: { username: "harness", password: "generated-secret" }
        },
        headers: {},
        url: options.url
      }
    }
  })

  assert.equal(requestOptions.url, "http://192.168.1.20:4097/v1/pairing/claim")
  assert.equal(requestOptions.method, "POST")
  assert.deepEqual(requestOptions.data, { token: "a".repeat(43) })
  assert.deepEqual(paired, {
    id: "physical-machine-1",
    name: "Studio PC",
    config: {
      backend: "opencode",
      host: "192.168.1.20",
      port: 4097,
      username: "harness",
      password: "generated-secret",
      agentId: undefined
    }
  })
})

test("re-pairing updates an existing endpoint in place instead of duplicating it", () => {
  const existing = {
    id: "local-stable-id",
    name: "Old name",
    config: {
      backend: "opencode",
      host: "192.168.1.20",
      port: 4097,
      username: "harness",
      password: "old-secret"
    }
  }
  const paired = {
    id: "physical-machine-1",
    name: "Studio PC",
    config: {
      backend: "opencode",
      host: "192.168.1.20",
      port: 4097,
      username: "harness",
      password: "new-secret"
    }
  }
  const result = upsertPairedMachine([existing], paired)
  assert.equal(result.length, 1)
  assert.equal(result[0].id, "local-stable-id")
  assert.equal(result[0].name, "Studio PC")
  assert.equal(result[0].config.password, "new-secret")
})

test("Android packaging exposes deep-link and in-app QR pairing without CAMERA or notification permission", () => {
  const sync = readFileSync(new URL("../scripts/sync-native-live-events.mjs", import.meta.url), "utf8")
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
  const activity = readFileSync(new URL("../native-android/MainActivity.java", import.meta.url), "utf8")
  const scanner = readFileSync(new URL("../native-android/PairingScannerPlugin.java", import.meta.url), "utf8")
  assert.match(sync, /android:scheme="harnessremote" android:host="pair"/)
  assert.match(sync, /android\.intent\.category\.BROWSABLE/)
  assert.match(sync, /play-services-code-scanner:16\.1\.0/)
  assert.match(sync, /barcode_ui/)
  assert.doesNotMatch(sync, /android\.permission\.CAMERA/)
  assert.doesNotMatch(sync, /POST_NOTIFICATIONS/)
  assert.match(activity, /registerPlugin\(PairingScannerPlugin\.class\)/)
  assert.match(scanner, /Barcode\.FORMAT_QR_CODE/)
  assert.match(scanner, /enableAutoZoom\(\)/)
  assert.match(main, /subscribeAndroidMachinePairing/)
  assert.match(main, /scanAndroidMachinePairing\(\)/)
  assert.match(main, /"Scan QR code"/)
  assert.match(main, /upsertPairedMachine\(machinesRef\.current, paired\)/)
  assert.match(main, /persistMachines\(nextMachines\)/)
})
