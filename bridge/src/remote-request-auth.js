import { createHash } from "node:crypto"

export const REMOTE_AUTH_HEADERS = Object.freeze({
  device: "x-harness-device",
  timestamp: "x-harness-timestamp",
  nonce: "x-harness-nonce",
  signature: "x-harness-signature"
})

const MAX_SKEW_MS = 60_000
const MAX_NONCES = 10_000
const MAX_NONCES_PER_DEVICE = 2_048
const DEVICE_ID = /^[A-Za-z0-9_-]{43}$/
const NONCE = /^[A-Za-z0-9_-]{32,64}$/
const SIGNATURE = /^[A-Za-z0-9_-]{1,256}$/
const TARGET = /^\/(?!\/)[^\u0000-\u001f\u007f]*$/

function singleHeader(headers, name) {
  const value = headers?.[name]
  return typeof value === "string" ? value : null
}

/** The exact UTF-8 bytes signed by the Android Keystore key for one HTTPS request. */
export function remoteRequestMessage({ machineID, pin, deviceID, timestamp, nonce, method, target, body }) {
  if (typeof machineID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(machineID)
    || typeof pin !== "string" || !/^[a-f0-9]{64}$/.test(pin)
    || typeof deviceID !== "string" || !DEVICE_ID.test(deviceID)
    || !Number.isSafeInteger(timestamp) || timestamp < 0
    || typeof nonce !== "string" || !NONCE.test(nonce)
    || typeof method !== "string" || !/^[A-Z]{1,16}$/.test(method)
    || typeof target !== "string" || target.length > 4096 || !TARGET.test(target)
    || !Buffer.isBuffer(body)) throw new Error("Invalid remote request transcript")
  const digest = createHash("sha256").update(body).digest("hex")
  return `harness-remote-request-v1\n${machineID}\n${pin}\n${deviceID}\n${timestamp}\n${nonce}\n${method}\n${target}\n${digest}`
}

/** Synchronous verification and nonce reservation prevent two concurrent replays from winning. */
export class RemoteRequestAuthenticator {
  #registry
  #machineID
  #pin
  #now
  #maxNoncesPerDevice
  #nonces = new Map()

  constructor({ registry, machineID, pin, now = () => Date.now(), maxNoncesPerDevice = MAX_NONCES_PER_DEVICE }) {
    if (!registry || typeof registry.verifySignature !== "function" || typeof registry.activeKey !== "function") {
      throw new Error("Paired device registry is required")
    }
    if (!Number.isInteger(maxNoncesPerDevice) || maxNoncesPerDevice < 1 || maxNoncesPerDevice > MAX_NONCES) {
      throw new Error("Invalid per-device nonce limit")
    }
    this.#registry = registry
    this.#machineID = machineID
    this.#pin = pin
    this.#now = now
    this.#maxNoncesPerDevice = maxNoncesPerDevice
  }

  authenticate({ headers, method, target, body }) {
    const deviceID = singleHeader(headers, REMOTE_AUTH_HEADERS.device)
    const timestampText = singleHeader(headers, REMOTE_AUTH_HEADERS.timestamp)
    const nonce = singleHeader(headers, REMOTE_AUTH_HEADERS.nonce)
    const signature = singleHeader(headers, REMOTE_AUTH_HEADERS.signature)
    if (!DEVICE_ID.test(deviceID ?? "") || !/^(0|[1-9][0-9]{0,15})$/.test(timestampText ?? "")
      || !NONCE.test(nonce ?? "") || !SIGNATURE.test(signature ?? "")) return null
    const timestamp = Number(timestampText)
    const now = this.#now()
    if (!Number.isSafeInteger(timestamp) || !Number.isFinite(now) || Math.abs(now - timestamp) > MAX_SKEW_MS) return null
    if (!this.#registry.activeKey(deviceID)) return null

    let message
    try {
      message = remoteRequestMessage({ machineID: this.#machineID, pin: this.#pin, deviceID, timestamp, nonce, method, target, body })
    } catch {
      return null
    }
    const replayKey = `${deviceID}:${nonce}`
    let deviceNonceCount = 0
    for (const [key, expiresAt] of this.#nonces) {
      if (expiresAt < now) this.#nonces.delete(key)
      else if (key.startsWith(`${deviceID}:`)) deviceNonceCount += 1
    }
    if (this.#nonces.has(replayKey) || this.#nonces.size >= MAX_NONCES ||
      deviceNonceCount >= this.#maxNoncesPerDevice) return null
    if (!this.#registry.verifySignature(deviceID, message, signature)) return null
    this.#nonces.set(replayKey, now + MAX_SKEW_MS * 2)
    return { deviceID }
  }

  active(deviceID) {
    return Boolean(this.#registry.activeKey(deviceID))
  }
}
