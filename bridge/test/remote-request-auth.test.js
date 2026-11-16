import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { test } from "node:test"
import { PairedDeviceRegistry } from "../src/paired-device-registry.js"
import { RemoteRequestAuthenticator, REMOTE_AUTH_HEADERS, remoteRequestMessage } from "../src/remote-request-auth.js"

const machineID = "machine-123"
const pin = "a".repeat(64)
const now = 1_900_000_000_000

async function fixture(options = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const publicKeyEncoded = publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  const deviceID = createHash("sha256").update(Buffer.from(publicKeyEncoded, "base64url")).digest("base64url")
  const registry = new PairedDeviceRegistry({ store: {
    read: async () => null,
    write: async () => {},
    serial: async (operation) => operation()
  } })
  await registry.load()
  await registry.pair({ publicKey: publicKeyEncoded, name: "Phone" })
  const authenticator = new RemoteRequestAuthenticator({ registry, machineID, pin, now: () => now, ...options })
  const request = (overrides = {}) => {
    const fields = {
      machineID, pin, deviceID, timestamp: now,
      nonce: "b".repeat(43), method: "POST", target: "/v1/sessions?agent=codex",
      body: Buffer.from('{"prompt":"hello"}'), ...overrides
    }
    const signature = sign("sha256", Buffer.from(remoteRequestMessage(fields)), privateKey).toString("base64url")
    return {
      method: fields.method,
      target: fields.target,
      body: fields.body,
      headers: {
        [REMOTE_AUTH_HEADERS.device]: fields.deviceID,
        [REMOTE_AUTH_HEADERS.timestamp]: String(fields.timestamp),
        [REMOTE_AUTH_HEADERS.nonce]: fields.nonce,
        [REMOTE_AUTH_HEADERS.signature]: signature
      }
    }
  }
  return { authenticator, registry, request, deviceID }
}

test("authenticates once and rejects a replay", async () => {
  const { authenticator, request, deviceID } = await fixture()
  const signed = request()
  assert.deepEqual(authenticator.authenticate(signed), { deviceID })
  assert.equal(authenticator.authenticate(signed), null)
})

test("rejects altered method, target, body and pin", async () => {
  const { authenticator, request } = await fixture()
  for (const change of [
    (signed) => { signed.method = "GET" },
    (signed) => { signed.target = "/v1/secrets" },
    (signed) => { signed.body = Buffer.from("different") }
  ]) {
    const signed = request()
    change(signed)
    assert.equal(authenticator.authenticate(signed), null)
  }
  assert.equal(authenticator.authenticate(request({ pin: "c".repeat(64) })), null)
})

test("rejects stale timestamps, duplicate header values and invalid targets", async () => {
  const { authenticator, request } = await fixture()
  assert.equal(authenticator.authenticate(request({ timestamp: now - 60_001 })), null)
  const signed = request()
  signed.headers[REMOTE_AUTH_HEADERS.nonce] = [signed.headers[REMOTE_AUTH_HEADERS.nonce]]
  assert.equal(authenticator.authenticate(signed), null)
  assert.throws(() => request({ target: "//evil.example/" }), /Invalid remote request transcript/)
  assert.throws(() => request({ target: "/a\nb" }), /Invalid remote request transcript/)
})

test("revocation takes effect on the next request", async () => {
  const { authenticator, registry, request, deviceID } = await fixture()
  assert.deepEqual(authenticator.authenticate(request()), { deviceID })
  await registry.revoke(deviceID)
  assert.equal(authenticator.active(deviceID), false)
  assert.equal(authenticator.authenticate(request({ nonce: "c".repeat(43) })), null)
})

test("one device cannot exhaust the replay cache for other paired devices", async () => {
  const { authenticator, registry, request, deviceID } = await fixture({ maxNoncesPerDevice: 2 })
  assert.deepEqual(authenticator.authenticate(request({ nonce: "d".repeat(43) })), { deviceID })
  assert.deepEqual(authenticator.authenticate(request({ nonce: "e".repeat(43) })), { deviceID })
  assert.equal(authenticator.authenticate(request({ nonce: "f".repeat(43) })), null)

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const otherID = await registry.pair({
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), name: "Tablet"
  })
  const fields = { machineID, pin, deviceID: otherID, timestamp: now,
    nonce: "g".repeat(43), method: "GET", target: "/v1/machine", body: Buffer.alloc(0) }
  const signature = sign("sha256", Buffer.from(remoteRequestMessage(fields)), privateKey).toString("base64url")
  assert.deepEqual(authenticator.authenticate({ method: fields.method, target: fields.target, body: fields.body,
    headers: {
      [REMOTE_AUTH_HEADERS.device]: otherID,
      [REMOTE_AUTH_HEADERS.timestamp]: String(now),
      [REMOTE_AUTH_HEADERS.nonce]: fields.nonce,
      [REMOTE_AUTH_HEADERS.signature]: signature
    }
  }), { deviceID: otherID })
})
