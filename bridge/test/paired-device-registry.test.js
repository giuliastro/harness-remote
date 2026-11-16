import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { PairedDeviceRegistry, parseDeviceKey } from "../src/paired-device-registry.js"

function deviceKey() {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url")
}

async function withState(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-paired-devices-"))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test("paired device survives restart and revocation denies the next lookup", async () => withState(async (directory) => {
  const publicKey = deviceKey()
  const first = new PairedDeviceRegistry({ stateDirectory: directory })
  await first.load()
  const id = await first.pair({ publicKey, name: "Giulio's phone" })
  assert.equal(first.activeKey(id), publicKey)

  const restarted = new PairedDeviceRegistry({ stateDirectory: directory })
  await restarted.load()
  assert.equal(restarted.activeKey(id), publicKey)
  assert.equal(await restarted.revoke(id), true)
  assert.equal(restarted.activeKey(id), null)
  await assert.rejects(() => restarted.pair({ publicKey, name: "stolen re-pair" }), /revoked/)

  const afterRestart = new PairedDeviceRegistry({ stateDirectory: directory })
  await afterRestart.load()
  assert.equal(afterRestart.activeKey(id), null)
  const serialized = await readFile(path.join(directory, "paired-devices.json"), "utf8")
  assert.doesNotMatch(serialized, /PRIVATE KEY/)
}))

test("malformed registry fails closed instead of resetting trust", async () => withState(async (directory) => {
  const registry = new PairedDeviceRegistry({ stateDirectory: directory })
  await registry.load()
  const publicKey = deviceKey()
  const id = await registry.pair({ publicKey, name: "phone" })
  await registry.revoke(id)
  await writeFile(path.join(directory, "paired-devices.json"), "{bad json")
  const restarted = new PairedDeviceRegistry({ stateDirectory: directory })
  await assert.rejects(() => restarted.load(), SyntaxError)
  assert.equal(restarted.activeKey(id), null)
}))

test("only canonical P-256 public keys are accepted", () => {
  assert.equal(parseDeviceKey(deviceKey())?.publicKey.length > 0, true)
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  assert.equal(parseDeviceKey(rsa), null)
  assert.equal(parseDeviceKey("not-a-key"), null)
})

test("signature is accepted only while its device key is active", async () => withState(async (directory) => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  const registry = new PairedDeviceRegistry({ stateDirectory: directory })
  await registry.load()
  const message = "e1-frame-v1\nnonce\nrequest"
  const signature = sign("sha256", Buffer.from(message), pair.privateKey).toString("base64url")
  const id = parseDeviceKey(publicKey).id
  assert.equal(registry.verifySignature(id, message, signature), false)
  await registry.pair({ publicKey, name: "phone" })
  assert.equal(registry.verifySignature(id, message, signature), true)
  assert.equal(registry.verifySignature(id, `${message}!`, signature), false)
  await registry.revoke(id)
  assert.equal(registry.verifySignature(id, message, signature), false)
}))
