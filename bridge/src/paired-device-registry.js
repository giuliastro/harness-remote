import { createHash, createPublicKey, verify } from "node:crypto"
import path from "node:path"
import { JsonFileStore } from "./json-file-store.js"

const MAX_DEVICES = 128
const MAX_NAME_LENGTH = 80
const PUBLIC_KEY_DER_LENGTH = 91

/**
 * Trust is deliberately separate from the existing HTTP Basic credentials. The public Internet
 * listener must consult this registry only after its encrypted, mutually authenticated handshake;
 * storing a key here must never make the current plain-HTTP listener Internet-safe.
 */
export class PairedDeviceRegistry {
  #store
  #devices = new Map()

  constructor({ stateDirectory, store } = {}) {
    if (!stateDirectory && !store) throw new Error("PairedDeviceRegistry requires a state directory")
    this.#store = store ?? new JsonFileStore({ filePath: path.join(stateDirectory, "paired-devices.json") })
  }

  async load() {
    // Corrupt trust state is a startup error, not an invitation to discard revocations.
    const parsed = await this.#store.read({ onCorrupt: "throw" })
    if (parsed === null) {
      this.#devices = new Map()
      return
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.devices) || parsed.devices.length > MAX_DEVICES) {
      throw new Error("Invalid paired-device registry")
    }
    const devices = new Map()
    for (const entry of parsed.devices) {
      const key = parseDeviceKey(entry?.publicKey)
      if (!key || entry.id !== key.id || typeof entry.name !== "string" || entry.name.length > MAX_NAME_LENGTH
        || typeof entry.pairedAt !== "string" || (entry.revokedAt !== null && typeof entry.revokedAt !== "string")
        || devices.has(entry.id)) {
        throw new Error("Invalid paired-device registry")
      }
      devices.set(entry.id, { id: entry.id, name: entry.name, publicKey: key.publicKey, pairedAt: entry.pairedAt, revokedAt: entry.revokedAt })
    }
    this.#devices = devices
  }

  list() {
    return [...this.#devices.values()].map(({ publicKey, ...entry }) => ({ ...entry }))
  }

  /** This check is synchronous so a revocation can take effect on the next received frame. */
  activeKey(id) {
    const entry = this.#devices.get(id)
    return entry && !entry.revokedAt ? entry.publicKey : null
  }

  // The transport must separately bind this signature to its handshake, encryption keys and a
  // fresh nonce. Signature verification alone does not protect against replay or disclosure.
  verifySignature(id, message, signature) {
    const publicKey = this.activeKey(id)
    if (!publicKey || typeof message !== "string" || Buffer.byteLength(message, "utf8") > 8192
      || typeof signature !== "string" || signature.length > 256 || !/^[A-Za-z0-9_-]+$/.test(signature)) return false
    try {
      const signatureBytes = Buffer.from(signature, "base64url")
      if (signatureBytes.toString("base64url") !== signature) return false
      return verify("sha256", Buffer.from(message, "utf8"),
        createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" }), signatureBytes)
    } catch {
      return false
    }
  }

  async pair({ publicKey, name, now = new Date() }) {
    const key = parseDeviceKey(publicKey)
    if (!key) throw new Error("A valid P-256 device public key is required")
    const label = typeof name === "string" ? name.trim() : ""
    if (!label || label.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("Invalid device name")
    return this.#store.serial(async () => {
      const current = this.#devices.get(key.id)
      if (current?.revokedAt) throw new Error("A revoked device cannot be paired again without a new key")
      if (current) return current.id
      if (this.#devices.size >= MAX_DEVICES) throw new Error("Too many paired devices")
      const next = new Map(this.#devices)
      next.set(key.id, { id: key.id, name: label, publicKey: key.publicKey, pairedAt: now.toISOString(), revokedAt: null })
      await this.#save(next)
      this.#devices = next
      return key.id
    })
  }

  async revoke(id, now = new Date()) {
    return this.#store.serial(async () => {
      const current = this.#devices.get(id)
      if (!current) return false
      if (current.revokedAt) return true
      const next = new Map(this.#devices)
      next.set(id, { ...current, revokedAt: now.toISOString() })
      await this.#save(next)
      this.#devices = next
      return true
    })
  }

  async #save(devices) {
    await this.#store.write({ version: 1, devices: [...devices.values()] }, { mode: 0o600 })
  }
}

export function parseDeviceKey(value) {
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const der = Buffer.from(value, "base64url")
    if (der.length !== PUBLIC_KEY_DER_LENGTH || der.toString("base64url") !== value) return null
    const key = createPublicKey({ key: der, format: "der", type: "spki" })
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null
    const canonical = key.export({ format: "der", type: "spki" })
    if (!canonical.equals(der)) return null
    return { id: createHash("sha256").update(der).digest("base64url"), publicKey: value }
  } catch {
    return null
  }
}
